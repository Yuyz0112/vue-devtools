import { stringify, parse } from 'src/util'
import SharedData from 'src/shared-data'
import { set, get } from '../util'
import Vue from 'vue'
import clone from './clone'

const isProd = process.env.NODE_ENV === 'production'

export function initVuexBackend (hook, bridge, isLegacy) {
  const store = hook.store

  const earlyModules = hook.flushStoreModules()
  let initialState = clone(store.state)

  let snapshotsVm = null
  const updateSnapshotsVm = (state) => {
    snapshotsVm = new Vue({
      data: {
        $$state: state || {}
      },
      computed: store._vm.$options.computed
    })
  }

  let baseStateSnapshot, stateSnapshots, mutations, lastState
  let registeredModules = {}
  let allTimeModules = {}

  updateSnapshotsVm()

  function reset (stateSnapshot = null) {
    baseStateSnapshot = stateSnapshot || clone(initialState)
    mutations = []
    resetSnapshotCache()
  }

  function resetSnapshotCache () {
    stateSnapshots = [
      { index: -1, state: baseStateSnapshot }
    ]
  }

  reset()

  function addModule (path, module, options) {
    if (typeof path === 'string') path = [path]

    let state
    if (options && options.preserveState) {
      state = get(store.state, path)
    }
    if (!state) {
      state = typeof module.state === 'function' ? module.state() : module.state
    }
    if (!state) {
      state = {}
    }

    const fakeModule = {
      ...module
    }

    const replaceNestedStates = (nestedModule) => {
      if (nestedModule.modules) {
        Object.keys(nestedModule.modules).forEach(key => {
          const child = nestedModule.modules[key]
          let state = {}
          if (child.state) {
            state = typeof child.state === 'function' ? child.state() : child.state
          }
          child.state = clone(state)
          replaceNestedStates(child)
        })
      }
    }
    replaceNestedStates(fakeModule)

    const key = path.join('/')
    const moduleInfo = registeredModules[key] = allTimeModules[key] = {
      path,
      module: fakeModule,
      options: {
        ...options,
        preserveState: false
      },
      state: clone(state)
    }

    if (SharedData.recordVuex) {
      addMutation(`Register module: ${key}`, {
        path,
        module,
        options
      }, {
        registerModule: true
      })
    }

    return moduleInfo
  }

  let origRegisterModule, origUnregisterModule

  if (store.registerModule) {
    origRegisterModule = store.registerModule.bind(store)
    store.registerModule = (path, module, options) => {
      addModule(path, module, options)
      origRegisterModule(path, module, options)
      if (!isProd) console.log('register module', path)
    }

    origUnregisterModule = store.unregisterModule.bind(store)
    store.unregisterModule = (path) => {
      if (typeof path === 'string') path = [path]

      delete registeredModules[path.join('/')]

      if (SharedData.recordVuex) {
        addMutation(`Unregister module: ${path.join('/')}`, {
          path
        }, {
          unregisterModule: true
        })
      }

      origUnregisterModule(path)
      if (!isProd) console.log('unregister module', path)
    }
  } else {
    origRegisterModule = origUnregisterModule = () => {}
  }

  bridge.send('vuex:init')

  earlyModules.forEach(({ path, module, options }) => {
    const moduleInfo = addModule(path, module, options)
    moduleInfo.early = true
  })

  // deal with multiple backend injections
  hook.off('vuex:mutation')

  // application -> devtool
  hook.on('vuex:mutation', ({ type, payload }) => {
    if (!SharedData.recordVuex) return

    addMutation(type, payload)
  })

  function addMutation (type, payload, options = {}) {
    const index = mutations.length

    mutations.push({
      type,
      payload: clone(payload),
      index,
      handlers: store._mutations[type],
      registeredModules: Object.keys(registeredModules),
      ...options
    })

    bridge.send('vuex:mutation', {
      mutation: {
        type: type,
        payload: stringify(payload),
        index
      },
      timestamp: Date.now()
    })
  }

  // devtool -> application
  bridge.on('vuex:travel-to-state', ({ index, apply }) => {
    const snapshot = replayMutations(index)
    const state = clone(lastState)
    bridge.send('vuex:inspected-state', {
      index,
      snapshot
    })
    if (apply) {
      ensureRegisteredModules(mutations[index])
      hook.emit('vuex:travel-to-state', state)
    }
  })

  bridge.on('vuex:commit-all', () => {
    reset(lastState)
  })

  bridge.on('vuex:revert-all', () => {
    reset()
  })

  bridge.on('vuex:commit', index => {
    baseStateSnapshot = lastState
    resetSnapshotCache()
    mutations = mutations.slice(index + 1)
    mutations.forEach((mutation, index) => {
      mutation.index = index
    })
  })

  bridge.on('vuex:revert', index => {
    resetSnapshotCache()
    ensureRegisteredModules(mutations[index - 1])
    mutations = mutations.slice(0, index)
  })

  bridge.on('vuex:import-state', state => {
    const parsed = parse(state, true)
    initialState = parsed
    reset()
    hook.emit('vuex:travel-to-state', parsed)
    bridge.send('vuex:init')
    bridge.send('vuex:inspected-state', {
      index: -1,
      snapshot: getSnapshot(baseStateSnapshot)
    })
  })

  bridge.on('vuex:inspect-state', index => {
    if (index === -1) {
      bridge.send('vuex:inspected-state', {
        index,
        snapshot: getSnapshot(baseStateSnapshot)
      })
    } else {
      const snapshot = replayMutations(index)
      bridge.send('vuex:inspected-state', {
        index,
        snapshot
      })
    }
  })

  function replayMutations (index) {
    const originalVm = store._vm
    const originalState = clone(store.state)
    store._vm = snapshotsVm

    let tempRemovedModules = []
    let tempAddedModules = []

    // Get most recent snapshot for target index
    // for faster replay
    let stateSnapshot
    for (let i = 0; i < stateSnapshots.length; i++) {
      const s = stateSnapshots[i]
      if (s.index > index) {
        break
      } else {
        stateSnapshot = s
      }
    }

    let resultState

    // Snapshot was already replayed
    if (stateSnapshot.index === index) {
      resultState = stateSnapshot.state

      const state = clone(stateSnapshot.state)
      updateSnapshotsVm(state)
      store.replaceState(state)
    } else {
      // Update state when using fake vm to properly temporarily remove modules
      updateSnapshotsVm(originalState)
      store.replaceState(originalState)
      // Temporarily remove modules if they where not present during first mutation being replayed
      const startMutation = mutations[stateSnapshot.index]
      if (startMutation) {
        tempRemovedModules = Object.keys(registeredModules).filter(m => !startMutation.registeredModules.includes(m))
      } else {
        tempRemovedModules = Object.keys(registeredModules)
      }
      tempRemovedModules = tempRemovedModules.filter(m => !registeredModules[m].early)
      tempRemovedModules.filter(m => hasModule(m.split('/'))).sort((a, b) => b.length - a.length).forEach(m => {
        origUnregisterModule(m.split('/'))
        if (!isProd) console.log('before replay unregister', m)
      })

      const state = clone(stateSnapshot.state)
      updateSnapshotsVm(state)
      store.replaceState(state)

      SharedData.snapshotLoading = true

      // Replay mutations
      for (let i = stateSnapshot.index + 1; i <= index; i++) {
        const mutation = mutations[i]
        if (mutation.registerModule) {
          const key = mutation.payload.path.join('/')
          const moduleInfo = allTimeModules[key]
          if (!moduleInfo.early) {
            tempAddedModules.push(key)
            origRegisterModule(moduleInfo.path, {
              ...moduleInfo.module,
              state: clone(moduleInfo.state)
            }, moduleInfo.options)
            updateSnapshotsVm(store.state)
            if (!isProd) console.log('replay register module', moduleInfo)
          }
        } else if (mutation.unregisterModule && hasModule(mutation.payload.path) != null) {
          const path = mutation.payload.path
          const index = tempAddedModules.indexOf(path.join('/'))
          if (index !== -1) tempAddedModules.splice(index, 1)
          origUnregisterModule(path)
          updateSnapshotsVm(store.state)
          if (!isProd) console.log('replay unregister module', path)
        } else if (mutation.handlers) {
          store._committing = true
          try {
            const payload = mutation.payload
            if (Array.isArray(mutation.handlers)) {
              mutation.handlers.forEach(handler => handler(payload))
            } else {
              if (isLegacy || SharedData.vuex1) {
                // Vuex 1
                mutation.handlers(store.state, payload)
              } else {
                mutation.handlers(payload)
              }
            }
          } catch (e) {
            throw e
          }
          store._committing = false
        }

        if (i !== index && i % SharedData.cacheVuexSnapshotsEvery === 0) {
          takeStateSnapshot(i)
        }
      }

      // Send final state after replay
      resultState = clone(store.state)
    }

    lastState = resultState

    const result = stringify({
      state: store.state,
      getters: store.getters || {}
    })

    // Restore user state
    tempAddedModules.sort((a, b) => b.length - a.length).forEach(m => {
      origUnregisterModule(m.split('/'))
      if (!isProd) console.log('after replay unregister', m)
    })
    tempRemovedModules.sort((a, b) => a.length - b.length).forEach(m => {
      const { path, module, options, state } = registeredModules[m]
      origRegisterModule(path, {
        ...module,
        state: clone(state)
      }, options)
      if (!isProd) console.log('after replay register', m)
    })
    store._vm = originalVm

    return result
  }

  bridge.on('vuex:edit-state', ({ index, value, path }) => {
    let parsedValue
    if (value) {
      parsedValue = parse(value, true)
    }
    store._committing = true
    set(store.state, path, parsedValue)
    store._committing = false
    bridge.send('vuex:inspected-state', {
      index,
      snapshot: getSnapshot()
    })
  })

  function takeStateSnapshot (index) {
    stateSnapshots.push({
      index,
      state: clone(store.state)
    })
    // Delete old cached snapshots
    if (stateSnapshots.length > SharedData.cacheVuexSnapshotsLimit) {
      stateSnapshots.splice(1, 1)
    }
  }

  function getSnapshot (stateSnapshot = null) {
    let originalVm
    if (stateSnapshot) {
      originalVm = store._vm
      store._vm = snapshotsVm
      store.replaceState(clone(stateSnapshot))
    }

    const result = stringify({
      state: store.state,
      getters: store.getters || {}
    })

    if (stateSnapshot) {
      // Restore user state
      store._vm = originalVm
    }

    return result
  }

  function ensureRegisteredModules (mutation) {
    if (mutation) {
      mutation.registeredModules.forEach(m => {
        if (!Object.keys(registeredModules).sort((a, b) => a.length - b.length).includes(m)) {
          const data = allTimeModules[m]
          if (data) {
            const { path, module, options, state } = data
            origRegisterModule(path, {
              ...module,
              state: clone(state)
            }, options)
            registeredModules[path.join('/')] = data
          }
        }
      })
      Object.keys(registeredModules).sort((a, b) => b.length - a.length).forEach(m => {
        if (!mutation.registeredModules.includes(m)) {
          origUnregisterModule(m.split('/'))
          delete registeredModules[m]
        }
      })
      updateSnapshotsVm(store.state)
    }
  }

  function hasModule (path) {
    return !!store._modules.get(path)
  }
}

export function getCustomStoreDetails (store) {
  return {
    _custom: {
      type: 'store',
      display: 'Store',
      value: {
        state: store.state,
        getters: store.getters
      },
      fields: {
        abstract: true
      }
    }
  }
}
