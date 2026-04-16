import { L as LiquidBorder } from "./liquid-border-iKf5_fIk.js";
import { r as reactExports, R as React, j as jsxRuntimeExports, c as client } from "./client-CTCutEjw.js";
const PALETTE_HEX = [
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#d946ef",
  "#ec4899",
  "#f43f5e",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#0ea5e9",
  "#3b82f6",
  "#2563eb"
];
const PALETTE_RGB = PALETTE_HEX.map((hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
]);
function uidToColorRgb(uid) {
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = (hash << 5) - hash + uid.charCodeAt(i) | 0;
  }
  return PALETTE_RGB[Math.abs(hash) % PALETTE_RGB.length];
}
const MAX_COLORS = 16;
let memberColors = [[99, 102, 241]];
const canvas = document.getElementById("border-canvas");
if (!canvas) throw new Error("border-canvas not found");
const border = new LiquidBorder(canvas, {
  colors: memberColors,
  cornerRadius: 12,
  borderWidth: 4,
  idleFPS: 24,
  activeFPS: 24,
  glowEnabled: false,
  activityMode: false
});
async function loadMemberColors() {
  try {
    const status = await window.teamHub.getInitialStatus();
    updateColorsFromStatus(status);
  } catch {
  }
}
function updateColorsFromStatus(status) {
  if (!status?.members?.length) return;
  const colors = [];
  for (const m of status.members) {
    if (m.uid && colors.length < MAX_COLORS) {
      const rgb = uidToColorRgb(m.uid);
      colors.push([rgb[0], rgb[1], rgb[2]]);
    }
  }
  if (colors.length > 0) {
    memberColors = colors;
    border.setColors(colors);
  }
}
if (window.teamHub?.onStatusUpdate) {
  window.teamHub.onStatusUpdate(updateColorsFromStatus);
}
loadMemberColors().then(() => {
  border.start();
});
window.addEventListener("beforeunload", () => {
  border.dispose();
});
const __vite_import_meta_env__$2 = { "BASE_URL": "./", "DEV": false, "MODE": "production", "PROD": true, "SSR": false };
function hasInitialValue(atom2) {
  return "init" in atom2;
}
function isActuallyWritableAtom(atom2) {
  return !!atom2.write;
}
function hasOnMount(atom2) {
  return !!atom2.onMount;
}
function isAtomStateInitialized(atomState) {
  return "v" in atomState || "e" in atomState;
}
function returnAtomValue(atomState) {
  if ("e" in atomState) {
    throw atomState.e;
  }
  if ((__vite_import_meta_env__$2 ? "production" : void 0) !== "production" && !("v" in atomState)) {
    throw new Error("[Bug] atom state is not initialized");
  }
  return atomState.v;
}
function isPromiseLike$1(p) {
  return typeof (p == null ? void 0 : p.then) === "function";
}
function addPendingPromiseToDependency(atom2, promise, dependencyAtomState) {
  if (!dependencyAtomState.p.has(atom2)) {
    dependencyAtomState.p.add(atom2);
    const cleanup = () => dependencyAtomState.p.delete(atom2);
    promise.then(cleanup, cleanup);
  }
}
function getMountedOrPendingDependents(atom2, atomState, mountedMap) {
  const mounted = mountedMap.get(atom2);
  const mountedDependents = mounted == null ? void 0 : mounted.t;
  const pendingDependents = atomState.p;
  if (!(mountedDependents == null ? void 0 : mountedDependents.size)) {
    return pendingDependents;
  }
  if (!pendingDependents.size) {
    return mountedDependents;
  }
  const dependents = new Set(mountedDependents);
  for (const a of pendingDependents) {
    dependents.add(a);
  }
  return dependents;
}
const BUILDING_BLOCK_atomRead = (_store, atom2, ...params) => atom2.read(...params);
const BUILDING_BLOCK_atomWrite = (_store, atom2, ...params) => atom2.write(...params);
const BUILDING_BLOCK_atomOnInit = (store, atom2) => {
  var _a;
  return (_a = atom2.INTERNAL_onInit) == null ? void 0 : _a.call(atom2, store);
};
const BUILDING_BLOCK_atomOnMount = (_store, atom2, setAtom) => {
  var _a;
  return (_a = atom2.onMount) == null ? void 0 : _a.call(atom2, setAtom);
};
const BUILDING_BLOCK_ensureAtomState = (store, atom2) => {
  var _a;
  const buildingBlocks = getInternalBuildingBlocks(store);
  const atomStateMap = buildingBlocks[0];
  const storeHooks = buildingBlocks[6];
  const atomOnInit = buildingBlocks[9];
  if ((__vite_import_meta_env__$2 ? "production" : void 0) !== "production" && !atom2) {
    throw new Error("Atom is undefined or null");
  }
  let atomState = atomStateMap.get(atom2);
  if (!atomState) {
    atomState = { d: /* @__PURE__ */ new Map(), p: /* @__PURE__ */ new Set(), n: 0 };
    atomStateMap.set(atom2, atomState);
    (_a = storeHooks.i) == null ? void 0 : _a.call(storeHooks, atom2);
    atomOnInit == null ? void 0 : atomOnInit(store, atom2);
  }
  return atomState;
};
const BUILDING_BLOCK_flushCallbacks = (store) => {
  var _a;
  const buildingBlocks = getInternalBuildingBlocks(store);
  const mountedMap = buildingBlocks[1];
  const changedAtoms = buildingBlocks[3];
  const mountCallbacks = buildingBlocks[4];
  const unmountCallbacks = buildingBlocks[5];
  const storeHooks = buildingBlocks[6];
  const recomputeInvalidatedAtoms = buildingBlocks[13];
  if (!storeHooks.f && !changedAtoms.size && !mountCallbacks.size && !unmountCallbacks.size) {
    return;
  }
  const errors = [];
  const call = (fn) => {
    try {
      fn();
    } catch (e) {
      errors.push(e);
    }
  };
  do {
    if (storeHooks.f) {
      call(storeHooks.f);
    }
    const callbacks = /* @__PURE__ */ new Set();
    for (const atom2 of changedAtoms) {
      const listeners = (_a = mountedMap.get(atom2)) == null ? void 0 : _a.l;
      if (listeners) {
        for (const listener of listeners) {
          callbacks.add(listener);
        }
      }
    }
    changedAtoms.clear();
    for (const fn of unmountCallbacks) {
      callbacks.add(fn);
    }
    unmountCallbacks.clear();
    for (const fn of mountCallbacks) {
      callbacks.add(fn);
    }
    mountCallbacks.clear();
    for (const fn of callbacks) {
      call(fn);
    }
    if (changedAtoms.size) {
      recomputeInvalidatedAtoms(store);
    }
  } while (changedAtoms.size || unmountCallbacks.size || mountCallbacks.size);
  if (errors.length) {
    throw new AggregateError(errors);
  }
};
const BUILDING_BLOCK_recomputeInvalidatedAtoms = (store) => {
  const buildingBlocks = getInternalBuildingBlocks(store);
  const mountedMap = buildingBlocks[1];
  const invalidatedAtoms = buildingBlocks[2];
  const changedAtoms = buildingBlocks[3];
  const ensureAtomState = buildingBlocks[11];
  const readAtomState = buildingBlocks[14];
  const mountDependencies = buildingBlocks[17];
  if (!changedAtoms.size) {
    return;
  }
  const sortedReversedAtoms = [];
  const sortedReversedStates = [];
  const visiting = /* @__PURE__ */ new WeakSet();
  const visited = /* @__PURE__ */ new WeakSet();
  const stackAtoms = [];
  const stackStates = [];
  for (const atom2 of changedAtoms) {
    stackAtoms.push(atom2);
    stackStates.push(ensureAtomState(store, atom2));
  }
  while (stackAtoms.length) {
    const top = stackAtoms.length - 1;
    const a = stackAtoms[top];
    const aState = stackStates[top];
    if (visited.has(a)) {
      stackAtoms.pop();
      stackStates.pop();
      continue;
    }
    if (visiting.has(a)) {
      if (invalidatedAtoms.get(a) === aState.n) {
        sortedReversedAtoms.push(a);
        sortedReversedStates.push(aState);
      } else if ((__vite_import_meta_env__$2 ? "production" : void 0) !== "production" && invalidatedAtoms.has(a)) {
        throw new Error("[Bug] invalidated atom exists");
      }
      visited.add(a);
      stackAtoms.pop();
      stackStates.pop();
      continue;
    }
    visiting.add(a);
    for (const d of getMountedOrPendingDependents(a, aState, mountedMap)) {
      if (!visiting.has(d)) {
        stackAtoms.push(d);
        stackStates.push(ensureAtomState(store, d));
      }
    }
  }
  for (let i = sortedReversedAtoms.length - 1; i >= 0; --i) {
    const a = sortedReversedAtoms[i];
    const aState = sortedReversedStates[i];
    let hasChangedDeps = false;
    for (const dep of aState.d.keys()) {
      if (dep !== a && changedAtoms.has(dep)) {
        hasChangedDeps = true;
        break;
      }
    }
    if (hasChangedDeps) {
      invalidatedAtoms.set(a, aState.n);
      readAtomState(store, a);
      mountDependencies(store, a);
    }
    invalidatedAtoms.delete(a);
  }
};
const storeMutationSet = /* @__PURE__ */ new WeakSet();
const BUILDING_BLOCK_readAtomState = (store, atom2) => {
  var _a, _b;
  const buildingBlocks = getInternalBuildingBlocks(store);
  const mountedMap = buildingBlocks[1];
  const invalidatedAtoms = buildingBlocks[2];
  const changedAtoms = buildingBlocks[3];
  const storeHooks = buildingBlocks[6];
  const atomRead = buildingBlocks[7];
  const ensureAtomState = buildingBlocks[11];
  const flushCallbacks = buildingBlocks[12];
  const recomputeInvalidatedAtoms = buildingBlocks[13];
  const readAtomState = buildingBlocks[14];
  const writeAtomState = buildingBlocks[16];
  const mountDependencies = buildingBlocks[17];
  const setAtomStateValueOrPromise = buildingBlocks[20];
  const registerAbortHandler = buildingBlocks[26];
  const storeEpochHolder = buildingBlocks[28];
  const atomState = ensureAtomState(store, atom2);
  const storeEpochNumber = storeEpochHolder[0];
  if (isAtomStateInitialized(atomState)) {
    if (
      // If the atom is mounted, we can use cached atom state,
      // because it should have been updated by dependencies.
      // We can't use the cache if the atom is invalidated.
      mountedMap.has(atom2) && invalidatedAtoms.get(atom2) !== atomState.n || // If atom is not mounted, we can use cached atom state,
      // only if store hasn't been mutated.
      atomState.m === storeEpochNumber
    ) {
      atomState.m = storeEpochNumber;
      return atomState;
    }
    let hasChangedDeps = false;
    for (const [a, n] of atomState.d) {
      if (readAtomState(store, a).n !== n) {
        hasChangedDeps = true;
        break;
      }
    }
    if (!hasChangedDeps) {
      atomState.m = storeEpochNumber;
      return atomState;
    }
  }
  let isSync = true;
  const prevDeps = new Set(atomState.d.keys());
  const pruneDependencies = () => {
    for (const a of prevDeps) {
      atomState.d.delete(a);
    }
  };
  const mountDependenciesIfAsync = () => {
    if (mountedMap.has(atom2)) {
      const shouldRecompute = !changedAtoms.size;
      mountDependencies(store, atom2);
      if (shouldRecompute) {
        recomputeInvalidatedAtoms(store);
        flushCallbacks(store);
      }
    }
  };
  const getter = (a) => {
    var _a2;
    if (a === atom2) {
      const aState2 = ensureAtomState(store, a);
      if (!isAtomStateInitialized(aState2)) {
        if (hasInitialValue(a)) {
          setAtomStateValueOrPromise(store, a, a.init);
        } else {
          throw new Error("no atom init");
        }
      }
      return returnAtomValue(aState2);
    }
    const aState = readAtomState(store, a);
    try {
      return returnAtomValue(aState);
    } finally {
      prevDeps.delete(a);
      atomState.d.set(a, aState.n);
      if (isPromiseLike$1(atomState.v)) {
        addPendingPromiseToDependency(atom2, atomState.v, aState);
      }
      if (mountedMap.has(atom2)) {
        (_a2 = mountedMap.get(a)) == null ? void 0 : _a2.t.add(atom2);
      }
      if (!isSync) {
        mountDependenciesIfAsync();
      }
    }
  };
  let controller;
  let setSelf;
  const options = {
    get signal() {
      if (!controller) {
        controller = new AbortController();
      }
      return controller.signal;
    },
    get setSelf() {
      if ((__vite_import_meta_env__$2 ? "production" : void 0) !== "production") {
        console.warn(
          "[DEPRECATED] setSelf is deprecated and will be removed in v3."
        );
      }
      if ((__vite_import_meta_env__$2 ? "production" : void 0) !== "production" && !isActuallyWritableAtom(atom2)) {
        console.warn("setSelf function cannot be used with read-only atom");
      }
      if (!setSelf && isActuallyWritableAtom(atom2)) {
        setSelf = (...args) => {
          if ((__vite_import_meta_env__$2 ? "production" : void 0) !== "production" && isSync) {
            console.warn("setSelf function cannot be called in sync");
          }
          if (!isSync) {
            try {
              return writeAtomState(store, atom2, ...args);
            } finally {
              recomputeInvalidatedAtoms(store);
              flushCallbacks(store);
            }
          }
        };
      }
      return setSelf;
    }
  };
  const prevEpochNumber = atomState.n;
  const prevInvalidated = invalidatedAtoms.get(atom2) === prevEpochNumber;
  try {
    if ((__vite_import_meta_env__$2 ? "production" : void 0) !== "production") {
      storeMutationSet.delete(store);
    }
    const valueOrPromise = atomRead(store, atom2, getter, options);
    if ((__vite_import_meta_env__$2 ? "production" : void 0) !== "production" && storeMutationSet.has(store)) {
      console.warn(
        "Detected store mutation during atom read. This is not supported."
      );
    }
    setAtomStateValueOrPromise(store, atom2, valueOrPromise);
    if (isPromiseLike$1(valueOrPromise)) {
      registerAbortHandler(store, valueOrPromise, () => controller == null ? void 0 : controller.abort());
      const settle = () => {
        pruneDependencies();
        mountDependenciesIfAsync();
      };
      valueOrPromise.then(settle, settle);
    } else {
      pruneDependencies();
    }
    (_a = storeHooks.r) == null ? void 0 : _a.call(storeHooks, atom2);
    atomState.m = storeEpochNumber;
    return atomState;
  } catch (error) {
    delete atomState.v;
    atomState.e = error;
    ++atomState.n;
    atomState.m = storeEpochNumber;
    return atomState;
  } finally {
    isSync = false;
    if (atomState.n !== prevEpochNumber && prevInvalidated) {
      invalidatedAtoms.set(atom2, atomState.n);
      changedAtoms.add(atom2);
      (_b = storeHooks.c) == null ? void 0 : _b.call(storeHooks, atom2);
    }
  }
};
const BUILDING_BLOCK_invalidateDependents = (store, atom2) => {
  const buildingBlocks = getInternalBuildingBlocks(store);
  const mountedMap = buildingBlocks[1];
  const invalidatedAtoms = buildingBlocks[2];
  const ensureAtomState = buildingBlocks[11];
  const stack = [atom2];
  while (stack.length) {
    const a = stack.pop();
    const aState = ensureAtomState(store, a);
    for (const d of getMountedOrPendingDependents(a, aState, mountedMap)) {
      const dState = ensureAtomState(store, d);
      if (invalidatedAtoms.get(d) !== dState.n) {
        invalidatedAtoms.set(d, dState.n);
        stack.push(d);
      }
    }
  }
};
const BUILDING_BLOCK_writeAtomState = (store, atom2, ...args) => {
  const buildingBlocks = getInternalBuildingBlocks(store);
  const changedAtoms = buildingBlocks[3];
  const storeHooks = buildingBlocks[6];
  const atomWrite = buildingBlocks[8];
  const ensureAtomState = buildingBlocks[11];
  const flushCallbacks = buildingBlocks[12];
  const recomputeInvalidatedAtoms = buildingBlocks[13];
  const readAtomState = buildingBlocks[14];
  const invalidateDependents = buildingBlocks[15];
  const writeAtomState = buildingBlocks[16];
  const mountDependencies = buildingBlocks[17];
  const setAtomStateValueOrPromise = buildingBlocks[20];
  const storeEpochHolder = buildingBlocks[28];
  let isSync = true;
  const getter = (a) => returnAtomValue(readAtomState(store, a));
  const setter = (a, ...args2) => {
    var _a;
    const aState = ensureAtomState(store, a);
    try {
      if (a === atom2) {
        if (!hasInitialValue(a)) {
          throw new Error("atom not writable");
        }
        if ((__vite_import_meta_env__$2 ? "production" : void 0) !== "production") {
          storeMutationSet.add(store);
        }
        const prevEpochNumber = aState.n;
        const v = args2[0];
        setAtomStateValueOrPromise(store, a, v);
        mountDependencies(store, a);
        if (prevEpochNumber !== aState.n) {
          ++storeEpochHolder[0];
          changedAtoms.add(a);
          invalidateDependents(store, a);
          (_a = storeHooks.c) == null ? void 0 : _a.call(storeHooks, a);
        }
        return void 0;
      } else {
        return writeAtomState(store, a, ...args2);
      }
    } finally {
      if (!isSync) {
        recomputeInvalidatedAtoms(store);
        flushCallbacks(store);
      }
    }
  };
  try {
    return atomWrite(store, atom2, getter, setter, ...args);
  } finally {
    isSync = false;
  }
};
const BUILDING_BLOCK_mountDependencies = (store, atom2) => {
  var _a;
  const buildingBlocks = getInternalBuildingBlocks(store);
  const mountedMap = buildingBlocks[1];
  const changedAtoms = buildingBlocks[3];
  const storeHooks = buildingBlocks[6];
  const ensureAtomState = buildingBlocks[11];
  const invalidateDependents = buildingBlocks[15];
  const mountAtom = buildingBlocks[18];
  const unmountAtom = buildingBlocks[19];
  const atomState = ensureAtomState(store, atom2);
  const mounted = mountedMap.get(atom2);
  if (mounted && atomState.d.size > 0) {
    for (const [a, n] of atomState.d) {
      if (!mounted.d.has(a)) {
        const aState = ensureAtomState(store, a);
        const aMounted = mountAtom(store, a);
        aMounted.t.add(atom2);
        mounted.d.add(a);
        if (n !== aState.n) {
          changedAtoms.add(a);
          invalidateDependents(store, a);
          (_a = storeHooks.c) == null ? void 0 : _a.call(storeHooks, a);
        }
      }
    }
    for (const a of mounted.d) {
      if (!atomState.d.has(a)) {
        mounted.d.delete(a);
        const aMounted = unmountAtom(store, a);
        aMounted == null ? void 0 : aMounted.t.delete(atom2);
      }
    }
  }
};
const BUILDING_BLOCK_mountAtom = (store, atom2) => {
  var _a;
  const buildingBlocks = getInternalBuildingBlocks(store);
  const mountedMap = buildingBlocks[1];
  const mountCallbacks = buildingBlocks[4];
  const storeHooks = buildingBlocks[6];
  const atomOnMount = buildingBlocks[10];
  const ensureAtomState = buildingBlocks[11];
  const flushCallbacks = buildingBlocks[12];
  const recomputeInvalidatedAtoms = buildingBlocks[13];
  const readAtomState = buildingBlocks[14];
  const writeAtomState = buildingBlocks[16];
  const mountAtom = buildingBlocks[18];
  const atomState = ensureAtomState(store, atom2);
  let mounted = mountedMap.get(atom2);
  if (!mounted) {
    readAtomState(store, atom2);
    for (const a of atomState.d.keys()) {
      const aMounted = mountAtom(store, a);
      aMounted.t.add(atom2);
    }
    mounted = {
      l: /* @__PURE__ */ new Set(),
      d: new Set(atomState.d.keys()),
      t: /* @__PURE__ */ new Set()
    };
    mountedMap.set(atom2, mounted);
    if (isActuallyWritableAtom(atom2) && hasOnMount(atom2)) {
      const processOnMount = () => {
        let isSync = true;
        const setAtom = (...args) => {
          try {
            return writeAtomState(store, atom2, ...args);
          } finally {
            if (!isSync) {
              recomputeInvalidatedAtoms(store);
              flushCallbacks(store);
            }
          }
        };
        try {
          const onUnmount = atomOnMount(store, atom2, setAtom);
          if (onUnmount) {
            mounted.u = () => {
              isSync = true;
              try {
                onUnmount();
              } finally {
                isSync = false;
              }
            };
          }
        } finally {
          isSync = false;
        }
      };
      mountCallbacks.add(processOnMount);
    }
    (_a = storeHooks.m) == null ? void 0 : _a.call(storeHooks, atom2);
  }
  return mounted;
};
const BUILDING_BLOCK_unmountAtom = (store, atom2) => {
  var _a, _b;
  const buildingBlocks = getInternalBuildingBlocks(store);
  const mountedMap = buildingBlocks[1];
  const unmountCallbacks = buildingBlocks[5];
  const storeHooks = buildingBlocks[6];
  const ensureAtomState = buildingBlocks[11];
  const unmountAtom = buildingBlocks[19];
  const atomState = ensureAtomState(store, atom2);
  let mounted = mountedMap.get(atom2);
  if (!mounted || mounted.l.size) {
    return mounted;
  }
  let isDependent = false;
  for (const a of mounted.t) {
    if ((_a = mountedMap.get(a)) == null ? void 0 : _a.d.has(atom2)) {
      isDependent = true;
      break;
    }
  }
  if (!isDependent) {
    if (mounted.u) {
      unmountCallbacks.add(mounted.u);
    }
    mounted = void 0;
    mountedMap.delete(atom2);
    for (const a of atomState.d.keys()) {
      const aMounted = unmountAtom(store, a);
      aMounted == null ? void 0 : aMounted.t.delete(atom2);
    }
    (_b = storeHooks.u) == null ? void 0 : _b.call(storeHooks, atom2);
    return void 0;
  }
  return mounted;
};
const BUILDING_BLOCK_setAtomStateValueOrPromise = (store, atom2, valueOrPromise) => {
  const buildingBlocks = getInternalBuildingBlocks(store);
  const ensureAtomState = buildingBlocks[11];
  const abortPromise = buildingBlocks[27];
  const atomState = ensureAtomState(store, atom2);
  const hasPrevValue = "v" in atomState;
  const prevValue = atomState.v;
  if (isPromiseLike$1(valueOrPromise)) {
    for (const a of atomState.d.keys()) {
      addPendingPromiseToDependency(
        atom2,
        valueOrPromise,
        ensureAtomState(store, a)
      );
    }
  }
  atomState.v = valueOrPromise;
  delete atomState.e;
  if (!hasPrevValue || !Object.is(prevValue, atomState.v)) {
    ++atomState.n;
    if (isPromiseLike$1(prevValue)) {
      abortPromise(store, prevValue);
    }
  }
};
const BUILDING_BLOCK_storeGet = (store, atom2) => {
  const readAtomState = getInternalBuildingBlocks(store)[14];
  return returnAtomValue(readAtomState(store, atom2));
};
const BUILDING_BLOCK_storeSet = (store, atom2, ...args) => {
  const buildingBlocks = getInternalBuildingBlocks(store);
  const changedAtoms = buildingBlocks[3];
  const flushCallbacks = buildingBlocks[12];
  const recomputeInvalidatedAtoms = buildingBlocks[13];
  const writeAtomState = buildingBlocks[16];
  const prevChangedAtomsSize = changedAtoms.size;
  try {
    return writeAtomState(store, atom2, ...args);
  } finally {
    if (changedAtoms.size !== prevChangedAtomsSize) {
      recomputeInvalidatedAtoms(store);
      flushCallbacks(store);
    }
  }
};
const BUILDING_BLOCK_storeSub = (store, atom2, listener) => {
  const buildingBlocks = getInternalBuildingBlocks(store);
  const flushCallbacks = buildingBlocks[12];
  const mountAtom = buildingBlocks[18];
  const unmountAtom = buildingBlocks[19];
  const mounted = mountAtom(store, atom2);
  const listeners = mounted.l;
  listeners.add(listener);
  flushCallbacks(store);
  return () => {
    listeners.delete(listener);
    unmountAtom(store, atom2);
    flushCallbacks(store);
  };
};
const BUILDING_BLOCK_registerAbortHandler = (store, promise, abortHandler) => {
  const buildingBlocks = getInternalBuildingBlocks(store);
  const abortHandlersMap = buildingBlocks[25];
  let abortHandlers = abortHandlersMap.get(promise);
  if (!abortHandlers) {
    abortHandlers = /* @__PURE__ */ new Set();
    abortHandlersMap.set(promise, abortHandlers);
    const cleanup = () => abortHandlersMap.delete(promise);
    promise.then(cleanup, cleanup);
  }
  abortHandlers.add(abortHandler);
};
const BUILDING_BLOCK_abortPromise = (store, promise) => {
  const buildingBlocks = getInternalBuildingBlocks(store);
  const abortHandlersMap = buildingBlocks[25];
  const abortHandlers = abortHandlersMap.get(promise);
  abortHandlers == null ? void 0 : abortHandlers.forEach((fn) => fn());
};
const buildingBlockMap = /* @__PURE__ */ new WeakMap();
const getInternalBuildingBlocks = (store) => {
  const buildingBlocks = buildingBlockMap.get(store);
  if ((__vite_import_meta_env__$2 ? "production" : void 0) !== "production" && !buildingBlocks) {
    throw new Error(
      "Store must be created by buildStore to read its building blocks"
    );
  }
  return buildingBlocks;
};
function getBuildingBlocks(store) {
  const buildingBlocks = getInternalBuildingBlocks(store);
  const enhanceBuildingBlocks = buildingBlocks[24];
  if (enhanceBuildingBlocks) {
    return enhanceBuildingBlocks(buildingBlocks);
  }
  return buildingBlocks;
}
function buildStore(...buildArgs) {
  const store = {
    get(atom2) {
      const storeGet = getInternalBuildingBlocks(store)[21];
      return storeGet(store, atom2);
    },
    set(atom2, ...args) {
      const storeSet = getInternalBuildingBlocks(store)[22];
      return storeSet(store, atom2, ...args);
    },
    sub(atom2, listener) {
      const storeSub = getInternalBuildingBlocks(store)[23];
      return storeSub(store, atom2, listener);
    }
  };
  const buildingBlocks = [
    // store state
    /* @__PURE__ */ new WeakMap(),
    // atomStateMap
    /* @__PURE__ */ new WeakMap(),
    // mountedMap
    /* @__PURE__ */ new WeakMap(),
    // invalidatedAtoms
    /* @__PURE__ */ new Set(),
    // changedAtoms
    /* @__PURE__ */ new Set(),
    // mountCallbacks
    /* @__PURE__ */ new Set(),
    // unmountCallbacks
    {},
    // storeHooks
    // atom interceptors
    BUILDING_BLOCK_atomRead,
    BUILDING_BLOCK_atomWrite,
    BUILDING_BLOCK_atomOnInit,
    BUILDING_BLOCK_atomOnMount,
    // building-block functions
    BUILDING_BLOCK_ensureAtomState,
    BUILDING_BLOCK_flushCallbacks,
    BUILDING_BLOCK_recomputeInvalidatedAtoms,
    BUILDING_BLOCK_readAtomState,
    BUILDING_BLOCK_invalidateDependents,
    BUILDING_BLOCK_writeAtomState,
    BUILDING_BLOCK_mountDependencies,
    BUILDING_BLOCK_mountAtom,
    BUILDING_BLOCK_unmountAtom,
    BUILDING_BLOCK_setAtomStateValueOrPromise,
    BUILDING_BLOCK_storeGet,
    BUILDING_BLOCK_storeSet,
    BUILDING_BLOCK_storeSub,
    void 0,
    // abortable promise support
    /* @__PURE__ */ new WeakMap(),
    // abortHandlersMap
    BUILDING_BLOCK_registerAbortHandler,
    BUILDING_BLOCK_abortPromise,
    // store epoch
    [0]
  ].map((fn, i) => buildArgs[i] || fn);
  buildingBlockMap.set(store, Object.freeze(buildingBlocks));
  return store;
}
const __vite_import_meta_env__$1 = {};
let keyCount = 0;
function atom(read, write) {
  const key = `atom${++keyCount}`;
  const config = {
    toString() {
      return (__vite_import_meta_env__$1 ? "production" : void 0) !== "production" && this.debugLabel ? key + ":" + this.debugLabel : key;
    }
  };
  if (typeof read === "function") {
    config.read = read;
  } else {
    config.init = read;
    config.read = defaultRead;
    config.write = defaultWrite;
  }
  return config;
}
function defaultRead(get) {
  return get(this);
}
function defaultWrite(get, set, arg) {
  return set(
    this,
    typeof arg === "function" ? arg(get(this)) : arg
  );
}
function createStore() {
  return buildStore();
}
let defaultStore;
function getDefaultStore() {
  if (!defaultStore) {
    defaultStore = createStore();
    if ((__vite_import_meta_env__$1 ? "production" : void 0) !== "production") {
      globalThis.__JOTAI_DEFAULT_STORE__ || (globalThis.__JOTAI_DEFAULT_STORE__ = defaultStore);
      if (globalThis.__JOTAI_DEFAULT_STORE__ !== defaultStore) {
        console.warn(
          "Detected multiple Jotai instances. It may cause unexpected behavior with the default store. https://github.com/pmndrs/jotai/discussions/2044"
        );
      }
    }
  }
  return defaultStore;
}
const __vite_import_meta_env__ = {};
const StoreContext = reactExports.createContext(
  void 0
);
function useStore(options) {
  const store = reactExports.useContext(StoreContext);
  return store || getDefaultStore();
}
function Provider({
  children,
  store
}) {
  const storeRef = reactExports.useRef(null);
  if (store) {
    return reactExports.createElement(StoreContext.Provider, { value: store }, children);
  }
  if (storeRef.current === null) {
    storeRef.current = createStore();
  }
  return reactExports.createElement(
    StoreContext.Provider,
    {
      // TODO: If this is not a false positive, consider using useState instead of useRef like https://github.com/pmndrs/jotai/pull/2771
      // eslint-disable-next-line react-hooks/refs
      value: storeRef.current
    },
    children
  );
}
const isPromiseLike = (x) => typeof (x == null ? void 0 : x.then) === "function";
const attachPromiseStatus = (promise) => {
  if (!promise.status) {
    promise.status = "pending";
    promise.then(
      (v) => {
        promise.status = "fulfilled";
        promise.value = v;
      },
      (e) => {
        promise.status = "rejected";
        promise.reason = e;
      }
    );
  }
};
const use = React.use || // A shim for older React versions
((promise) => {
  if (promise.status === "pending") {
    throw promise;
  } else if (promise.status === "fulfilled") {
    return promise.value;
  } else if (promise.status === "rejected") {
    throw promise.reason;
  } else {
    attachPromiseStatus(promise);
    throw promise;
  }
});
const continuablePromiseMap = /* @__PURE__ */ new WeakMap();
const createContinuablePromise = (store, promise, getValue) => {
  const buildingBlocks = getBuildingBlocks(store);
  const registerAbortHandler = buildingBlocks[26];
  let continuablePromise = continuablePromiseMap.get(promise);
  if (!continuablePromise) {
    continuablePromise = new Promise((resolve, reject) => {
      let curr = promise;
      const onFulfilled = (me) => (v) => {
        if (curr === me) {
          resolve(v);
        }
      };
      const onRejected = (me) => (e) => {
        if (curr === me) {
          reject(e);
        }
      };
      const onAbort = () => {
        try {
          const nextValue = getValue();
          if (isPromiseLike(nextValue)) {
            continuablePromiseMap.set(nextValue, continuablePromise);
            curr = nextValue;
            nextValue.then(onFulfilled(nextValue), onRejected(nextValue));
            registerAbortHandler(store, nextValue, onAbort);
          } else {
            resolve(nextValue);
          }
        } catch (e) {
          reject(e);
        }
      };
      promise.then(onFulfilled(promise), onRejected(promise));
      registerAbortHandler(store, promise, onAbort);
    });
    continuablePromiseMap.set(promise, continuablePromise);
  }
  return continuablePromise;
};
function useAtomValue(atom2, options) {
  const { delay, unstable_promiseStatus: promiseStatus = !React.use } = {};
  const store = useStore();
  const [[valueFromReducer, storeFromReducer, atomFromReducer], rerender] = reactExports.useReducer(
    (prev) => {
      const nextValue = store.get(atom2);
      if (Object.is(prev[0], nextValue) && prev[1] === store && prev[2] === atom2) {
        return prev;
      }
      return [nextValue, store, atom2];
    },
    void 0,
    () => [store.get(atom2), store, atom2]
  );
  let value = valueFromReducer;
  if (storeFromReducer !== store || atomFromReducer !== atom2) {
    rerender();
    value = store.get(atom2);
  }
  reactExports.useEffect(() => {
    const unsub = store.sub(atom2, () => {
      if (promiseStatus) {
        try {
          const value2 = store.get(atom2);
          if (isPromiseLike(value2)) {
            attachPromiseStatus(
              createContinuablePromise(store, value2, () => store.get(atom2))
            );
          }
        } catch (e) {
        }
      }
      if (typeof delay === "number") {
        console.warn(`[DEPRECATED] delay option is deprecated and will be removed in v3.

Migration guide:

Create a custom hook like the following.

function useAtomValueWithDelay<Value>(
  atom: Atom<Value>,
  options: { delay: number },
): Value {
  const { delay } = options
  const store = useStore(options)
  const [value, setValue] = useState(() => store.get(atom))
  useEffect(() => {
    const unsub = store.sub(atom, () => {
      setTimeout(() => setValue(store.get(atom)), delay)
    })
    return unsub
  }, [store, atom, delay])
  return value
}
`);
        setTimeout(rerender, delay);
        return;
      }
      rerender();
    });
    rerender();
    return unsub;
  }, [store, atom2, delay, promiseStatus]);
  reactExports.useDebugValue(value);
  if (isPromiseLike(value)) {
    const promise = createContinuablePromise(
      store,
      value,
      () => store.get(atom2)
    );
    if (promiseStatus) {
      attachPromiseStatus(promise);
    }
    return use(promise);
  }
  return value;
}
function useSetAtom(atom2, options) {
  const store = useStore();
  const setAtom = reactExports.useCallback(
    (...args) => {
      if ((__vite_import_meta_env__ ? "production" : void 0) !== "production" && !("write" in atom2)) {
        throw new Error("not writable atom");
      }
      return store.set(atom2, ...args);
    },
    [store, atom2]
  );
  return setAtom;
}
function useAtom(atom2, options) {
  return [
    useAtomValue(atom2),
    // We do wrong type assertion here, which results in throwing an error.
    useSetAtom(atom2)
  ];
}
const teamStatusAtom = atom(null);
const themeAtom = atom("light");
const mcpStoreAtom = atom({ store: [], memberMounts: [] });
const registryAtom = atom({ servers: [], metadata: { count: 0 } });
const projectsAtom = atom([]);
const pageAtom = atom("team");
const storeTabAtom = atom("installed");
const selectedMemberAtom = atom(null);
const selectedProjectAtom = atom(null);
const registrySearchAtom = atom("");
const membersAtom = atom((get) => get(teamStatusAtom)?.members ?? []);
const sessionsAtom = atom((get) => get(teamStatusAtom)?.sessions ?? []);
const workingCountAtom = atom((get) => get(membersAtom).filter((m) => m.status === "working").length);
const reservedCountAtom = atom((get) => get(membersAtom).filter((m) => m.status === "reserved").length);
const offlineCountAtom = atom((get) => get(membersAtom).filter((m) => m.status === "offline").length);
const healthyAtom = atom((get) => get(teamStatusAtom)?.healthy ?? true);
const activeProjectsCountAtom = atom((get) => get(projectsAtom).filter((p) => !["done", "abandoned"].includes(p.status)).length);
function IpcBridge() {
  const setStatus = useSetAtom(teamStatusAtom);
  const setTheme = useSetAtom(themeAtom);
  const setMcpStore = useSetAtom(mcpStoreAtom);
  const setRegistry = useSetAtom(registryAtom);
  const setProjects = useSetAtom(projectsAtom);
  reactExports.useEffect(() => {
    window.teamHub.getInitialStatus().then(setStatus);
    window.teamHub.getTheme().then((t) => {
      setTheme(t);
      document.documentElement.setAttribute("data-theme", t);
    });
    window.teamHub.getMcpStore().then(setMcpStore);
    window.teamHub.getRegistry().then(setRegistry);
    window.teamHub.listProjects().then(setProjects);
    const unsubStatus = window.teamHub.onStatusUpdate((s) => {
      setStatus(s);
      window.teamHub.getMcpStore().then(setMcpStore);
      window.teamHub.listProjects().then(setProjects);
    });
    const unsubTheme = window.teamHub.onThemeChange((t) => {
      setTheme(t);
      document.documentElement.setAttribute("data-theme", t);
    });
    return () => {
      unsubStatus();
      unsubTheme();
    };
  }, [setStatus, setTheme, setMcpStore, setRegistry, setProjects]);
  return null;
}
const header$1 = "_header_bsd2p_1";
const titleRow = "_titleRow_bsd2p_9";
const dot$1 = "_dot_bsd2p_16";
const title$1 = "_title_bsd2p_9";
const sessionBadge = "_sessionBadge_bsd2p_30";
const statusRow$1 = "_statusRow_bsd2p_39";
const scanTime = "_scanTime_bsd2p_45";
const healthStatus = "_healthStatus_bsd2p_50";
const styles$8 = {
  header: header$1,
  titleRow,
  dot: dot$1,
  title: title$1,
  sessionBadge,
  statusRow: statusRow$1,
  scanTime,
  healthStatus
};
function formatRelativeTime(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const secs = Math.floor(diff / 1e3);
  if (secs < 5) return "刚刚";
  if (secs < 60) return `${secs}s前`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m前`;
  return `${Math.floor(mins / 60)}h前`;
}
function Header() {
  const sessions = useAtomValue(sessionsAtom);
  const status = useAtomValue(teamStatusAtom);
  const healthy = useAtomValue(healthyAtom);
  const [, forceUpdate] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => {
    const id = setInterval(forceUpdate, 1e3);
    return () => clearInterval(id);
  }, []);
  const scannedAt = status?.scannedAt ?? "";
  const errorMsg2 = status?.errorMsg;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$8.header, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$8.titleRow, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "span",
        {
          className: styles$8.dot,
          style: { background: healthy ? "var(--dot-green)" : "var(--dot-red)" }
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$8.title, children: "Team Hub" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: styles$8.sessionBadge, children: [
        sessions.length,
        " sessions"
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$8.statusRow, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: styles$8.scanTime, children: [
        "刷新: ",
        scannedAt ? formatRelativeTime(scannedAt) : "-"
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$8.healthStatus, children: healthy ? "✅ 正常" : `⚠️ ${errorMsg2 ?? "异常"}` })
    ] })
  ] });
}
const avatar = "_avatar_kz0sf_1";
const initial = "_initial_kz0sf_13";
const dot = "_dot_kz0sf_17";
const dotWorking = "_dotWorking_kz0sf_27";
const dotOffline = "_dotOffline_kz0sf_31";
const dotReserved = "_dotReserved_kz0sf_35";
const pulse = "_pulse_kz0sf_1";
const styles$7 = {
  avatar,
  initial,
  dot,
  dotWorking,
  dotOffline,
  dotReserved,
  pulse
};
const PALETTE = [
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#d946ef",
  "#ec4899",
  "#f43f5e",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#0ea5e9",
  "#3b82f6",
  "#2563eb"
];
function uidToColor(uid) {
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = (hash << 5) - hash + uid.charCodeAt(i) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
function getInitial(displayName2) {
  return displayName2.charAt(0);
}
const dotClass = {
  reserved: "dotReserved",
  working: "dotWorking",
  offline: "dotOffline"
};
function Avatar({ uid, displayName: displayName2, size = 28, status }) {
  const bg = uidToColor(uid);
  const fontSize = Math.round(size * 0.46);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      className: styles$7.avatar,
      style: { width: size, height: size, backgroundColor: bg, fontSize },
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$7.initial, children: getInitial(displayName2) }),
        status !== void 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: `${styles$7.dot} ${styles$7[dotClass[status]]}` })
      ]
    }
  );
}
const list$2 = "_list_goc29_1";
const projectGroup = "_projectGroup_goc29_19";
const projectHeader = "_projectHeader_goc29_24";
const projectName$1 = "_projectName_goc29_31";
const memberRow = "_memberRow_goc29_37";
const reservedRow = "_reservedRow_goc29_51";
const memberName$1 = "_memberName_goc29_55";
const tempName = "_tempName_goc29_62";
const taskText = "_taskText_goc29_66";
const duration = "_duration_goc29_75";
const emptyBusy = "_emptyBusy_goc29_83";
const idleSection = "_idleSection_goc29_91";
const idleLabel = "_idleLabel_goc29_97";
const idleGrid = "_idleGrid_goc29_104";
const idleCard = "_idleCard_goc29_110";
const idleName = "_idleName_goc29_125";
const idleRole = "_idleRole_goc29_133";
const styles$6 = {
  list: list$2,
  projectGroup,
  projectHeader,
  projectName: projectName$1,
  memberRow,
  reservedRow,
  memberName: memberName$1,
  tempName,
  taskText,
  duration,
  emptyBusy,
  idleSection,
  idleLabel,
  idleGrid,
  idleCard,
  idleName,
  idleRole
};
function formatDuration(lockedAt) {
  const diff = Date.now() - new Date(lockedAt).getTime();
  const totalMins = Math.floor(diff / 6e4);
  if (totalMins < 1) return "<1m";
  if (totalMins < 60) return `${totalMins}m`;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + "…" : str;
}
function groupByProject(members) {
  const map = /* @__PURE__ */ new Map();
  for (const m of members) {
    if (m.status !== "working") continue;
    const proj = m.project ?? "未知项目";
    if (!map.has(proj)) map.set(proj, []);
    map.get(proj).push(m);
  }
  return map;
}
function MemberList({ onMemberClick }) {
  const members = useAtomValue(membersAtom);
  const [, forceUpdate] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => {
    const id = setInterval(forceUpdate, 6e4);
    return () => clearInterval(id);
  }, []);
  const reservedMembers = members.filter((m) => m.status === "reserved");
  const workingGroups = groupByProject(members);
  const offlineMembers = members.filter((m) => m.status === "offline");
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$6.list, children: [
    reservedMembers.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$6.projectGroup, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$6.projectHeader, children: /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$6.projectName, children: "预约中" }) }),
      reservedMembers.map((member, idx) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "div",
        {
          className: `${styles$6.memberRow} ${styles$6.reservedRow} ${idx === reservedMembers.length - 1 ? styles$6.last : ""}`,
          onClick: () => onMemberClick(member.name),
          children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(Avatar, { uid: member.uid, displayName: member.name, size: 24, status: "reserved" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: `${styles$6.memberName} ${member.type === "temporary" ? styles$6.tempName : ""}`, children: member.name }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: styles$6.taskText, children: [
              member.caller ? `by ${truncate(member.caller, 8)}` : "",
              member.project ? ` · ${truncate(member.project, 8)}` : ""
            ] })
          ]
        },
        member.uid
      ))
    ] }),
    workingGroups.size > 0 ? Array.from(workingGroups.entries()).map(([project, projectMembers]) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$6.projectGroup, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$6.projectHeader, children: /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$6.projectName, children: project }) }),
      projectMembers.map((member, idx) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "div",
        {
          className: `${styles$6.memberRow} ${idx === projectMembers.length - 1 ? styles$6.last : ""}`,
          onClick: () => onMemberClick(member.name),
          children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(Avatar, { uid: member.uid, displayName: member.name, size: 24, status: "working" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: `${styles$6.memberName} ${member.type === "temporary" ? styles$6.tempName : ""}`, children: member.name }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$6.taskText, children: truncate(member.task ?? "", 12) }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$6.duration, children: member.lockedAt ? formatDuration(member.lockedAt) : "" })
          ]
        },
        member.uid
      ))
    ] }, project)) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$6.emptyBusy, children: "暂无进行中的任务" }),
    offlineMembers.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$6.idleSection, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$6.idleLabel, children: "离线" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$6.idleGrid, children: offlineMembers.map((m) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "div",
        {
          className: styles$6.idleCard,
          onClick: () => onMemberClick(m.name),
          title: m.name,
          children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(Avatar, { uid: m.uid, displayName: m.name, size: 32, status: "offline" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$6.idleName, children: m.name }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$6.idleRole, children: m.role })
          ]
        },
        m.uid
      )) })
    ] })
  ] });
}
const overlay = "_overlay_bkb13_1";
const modal = "_modal_bkb13_11";
const header = "_header_bkb13_24";
const title = "_title_bkb13_32";
const closeBtn = "_closeBtn_bkb13_38";
const body = "_body_bkb13_53";
const hint = "_hint_bkb13_60";
const empty$3 = "_empty_bkb13_65";
const cliList = "_cliList_bkb13_72";
const cliRow = "_cliRow_bkb13_78";
const cliSelected = "_cliSelected_bkb13_95";
const cliIcon = "_cliIcon_bkb13_100";
const cliInfo = "_cliInfo_bkb13_107";
const cliName = "_cliName_bkb13_115";
const cliBin = "_cliBin_bkb13_121";
const cliVersion = "_cliVersion_bkb13_130";
const cliCheck = "_cliCheck_bkb13_136";
const workspaceSection = "_workspaceSection_bkb13_143";
const selectFolderBtn = "_selectFolderBtn_bkb13_149";
const workspaceSelected = "_workspaceSelected_bkb13_166";
const folderIcon = "_folderIcon_bkb13_176";
const workspacePath = "_workspacePath_bkb13_181";
const clearBtn = "_clearBtn_bkb13_194";
const workspaceHint = "_workspaceHint_bkb13_209";
const trustSection = "_trustSection_bkb13_215";
const trustTitle = "_trustTitle_bkb13_221";
const trustDesc = "_trustDesc_bkb13_227";
const trustPathBox = "_trustPathBox_bkb13_233";
const summary = "_summary_bkb13_244";
const summaryRow = "_summaryRow_bkb13_254";
const summaryLabel = "_summaryLabel_bkb13_260";
const summaryValue = "_summaryValue_bkb13_266";
const toast = "_toast_bkb13_276";
const errorMsg = "_errorMsg_bkb13_287";
const footer$2 = "_footer_bkb13_297";
const cancelBtn = "_cancelBtn_bkb13_306";
const retryBtn = "_retryBtn_bkb13_322";
const launchBtn = "_launchBtn_bkb13_338";
const spinner = "_spinner_bkb13_365";
const styles$5 = {
  overlay,
  modal,
  header,
  title,
  closeBtn,
  body,
  hint,
  empty: empty$3,
  cliList,
  cliRow,
  cliSelected,
  cliIcon,
  cliInfo,
  cliName,
  cliBin,
  cliVersion,
  cliCheck,
  workspaceSection,
  selectFolderBtn,
  workspaceSelected,
  folderIcon,
  workspacePath,
  clearBtn,
  workspaceHint,
  trustSection,
  trustTitle,
  trustDesc,
  trustPathBox,
  summary,
  summaryRow,
  summaryLabel,
  summaryValue,
  toast,
  errorMsg,
  footer: footer$2,
  cancelBtn,
  retryBtn,
  launchBtn,
  spinner
};
const mockClis = [
  { name: "claude", bin: "/usr/local/bin/claude", version: "1.0.0", status: "found" }
];
function LeadModal({ memberName: memberName2, onClose }) {
  const [clis, setClis] = reactExports.useState([]);
  const [selected, setSelected] = reactExports.useState(null);
  const [step, setStep] = reactExports.useState("cli");
  const [workspacePath2, setWorkspacePath] = reactExports.useState(null);
  const [trustPath, setTrustPath] = reactExports.useState(null);
  const [launchState, setLaunchState] = reactExports.useState("idle");
  const [errorMsg2, setErrorMsg] = reactExports.useState("");
  reactExports.useEffect(() => {
    const load = async () => {
      try {
        const result = await window.api?.scanAgentClis?.();
        if (result?.found && result.found.length > 0) {
          setClis(result.found);
          if (result.found.length === 1) setSelected(result.found[0]);
        } else {
          setClis(mockClis);
          if (mockClis.length === 1) setSelected(mockClis[0]);
        }
      } catch {
        setClis(mockClis);
        if (mockClis.length === 1) setSelected(mockClis[0]);
      }
    };
    load();
  }, []);
  const handleNext = () => {
    if (!selected) return;
    setStep("workspace");
  };
  const handleSelectFolder = async () => {
    try {
      const result = await window.api?.selectDirectory?.();
      if (result && !result.canceled && result.path) {
        setWorkspacePath(result.path);
      }
    } catch {
    }
  };
  const handleClearFolder = () => {
    setWorkspacePath(null);
  };
  const handleBack = () => {
    setStep("cli");
    setLaunchState("idle");
    setErrorMsg("");
  };
  const doLaunch = async () => {
    if (!selected) return;
    setLaunchState("loading");
    setErrorMsg("");
    try {
      const result = await window.api?.launchMember?.({
        memberName: memberName2,
        cliBin: selected.bin,
        cliName: selected.name,
        isLeader: true,
        workspacePath: workspacePath2 ?? void 0
      });
      if (result && result.ok === false) {
        if (result.reason === "trust_required" && result.workspacePath) {
          setTrustPath(result.workspacePath);
          setStep("trust");
          setLaunchState("idle");
          return;
        }
        setLaunchState("error");
        setErrorMsg(result.reason ?? "启动失败，请重试");
        return;
      }
      setLaunchState("success");
      setTimeout(onClose, 1200);
    } catch (e) {
      setLaunchState("error");
      setErrorMsg(e?.message ?? "启动失败，请重试");
    }
  };
  const handleLaunch = doLaunch;
  const handleTrust = async () => {
    if (!trustPath) return;
    setLaunchState("trusting");
    setErrorMsg("");
    try {
      const trustResult = await window.api?.trustWorkspace?.(trustPath);
      if (trustResult && !trustResult.ok) {
        setLaunchState("error");
        setErrorMsg(trustResult.reason ?? "信任写入失败");
        return;
      }
      setStep("workspace");
      await doLaunch();
    } catch (e) {
      setLaunchState("error");
      setErrorMsg(e?.message ?? "信任写入失败");
    }
  };
  const handleTrustCancel = () => {
    setTrustPath(null);
    setStep("workspace");
    setLaunchState("idle");
    setErrorMsg("");
  };
  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$5.overlay, onClick: handleOverlayClick, children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$5.modal, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$5.header, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: styles$5.title, children: [
        "带队 ",
        memberName2
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$5.closeBtn, onClick: onClose, children: "×" })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$5.body, children: [
      step === "cli" && /* @__PURE__ */ jsxRuntimeExports.jsx(jsxRuntimeExports.Fragment, { children: clis.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$5.empty, children: "未检测到 agent CLI" }) : /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$5.hint, children: "选择 CLI 启动代理实例" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$5.cliList, children: clis.map((cli) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "div",
          {
            className: `${styles$5.cliRow} ${selected?.bin === cli.bin ? styles$5.cliSelected : ""}`,
            onClick: () => setSelected(cli),
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$5.cliIcon, children: ">_" }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$5.cliInfo, children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$5.cliName, children: cli.name }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$5.cliBin, children: cli.bin })
              ] }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: styles$5.cliVersion, children: [
                "v",
                cli.version
              ] }),
              selected?.bin === cli.bin && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$5.cliCheck, children: "✓" })
            ]
          },
          cli.bin
        )) })
      ] }) }),
      step === "workspace" && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$5.hint, children: "选择工作目录（可选）" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$5.workspaceSection, children: [
          workspacePath2 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$5.workspaceSelected, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$5.folderIcon, children: "📁" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$5.workspacePath, children: workspacePath2 }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$5.clearBtn, onClick: handleClearFolder, children: "✕" })
          ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$5.selectFolderBtn, onClick: handleSelectFolder, children: "选择文件夹..." }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$5.workspaceHint, children: "不选择则使用默认目录" })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$5.summary, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$5.summaryRow, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$5.summaryLabel, children: "CLI" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$5.summaryValue, children: selected?.name })
          ] }),
          workspacePath2 && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$5.summaryRow, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$5.summaryLabel, children: "目录" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$5.summaryValue, children: workspacePath2.split("/").pop() })
          ] })
        ] }),
        launchState === "success" && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$5.toast, children: [
          "已启动 ",
          selected?.name,
          " — ",
          memberName2
        ] }),
        launchState === "error" && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$5.errorMsg, children: errorMsg2 })
      ] }),
      step === "trust" && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$5.trustSection, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$5.trustTitle, children: "工作目录未受信任" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$5.trustDesc, children: "该目录尚未在 Claude 配置中标记为可信。是否信任此目录并继续启动？" }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$5.trustPathBox, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$5.folderIcon, children: "📁" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$5.workspacePath, children: trustPath })
          ] })
        ] }),
        launchState === "error" && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$5.errorMsg, children: errorMsg2 })
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$5.footer, children: [
      step === "cli" && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$5.cancelBtn, onClick: onClose, children: "取消" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: styles$5.launchBtn,
            disabled: !selected,
            onClick: handleNext,
            children: "下一步"
          }
        )
      ] }),
      step === "workspace" && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        launchState === "error" && /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: styles$5.retryBtn,
            onClick: () => {
              setLaunchState("idle");
              setErrorMsg("");
            },
            children: "重试"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$5.cancelBtn, onClick: handleBack, children: "上一步" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: styles$5.launchBtn,
            disabled: launchState === "loading" || launchState === "success",
            onClick: handleLaunch,
            children: launchState === "loading" ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$5.spinner }) : launchState === "success" ? "已启动" : "确认启动"
          }
        )
      ] }),
      step === "trust" && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$5.cancelBtn, onClick: handleTrustCancel, children: "返回" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: styles$5.launchBtn,
            disabled: launchState === "trusting",
            onClick: handleTrust,
            children: launchState === "trusting" ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$5.spinner }) : "信任并启动"
          }
        )
      ] })
    ] })
  ] }) });
}
const container$3 = "_container_ir4jt_1";
const loading$1 = "_loading_ir4jt_8";
const topBar$1 = "_topBar_ir4jt_18";
const backBtn$1 = "_backBtn_ir4jt_26";
const topName$1 = "_topName_ir4jt_43";
const profileCard = "_profileCard_ir4jt_50";
const profileInfo = "_profileInfo_ir4jt_57";
const displayName = "_displayName_ir4jt_64";
const meta = "_meta_ir4jt_71";
const roleBadge = "_roleBadge_ir4jt_77";
const tempBadge = "_tempBadge_ir4jt_86";
const subMeta = "_subMeta_ir4jt_94";
const uidLabel = "_uidLabel_ir4jt_107";
const leadBtn = "_leadBtn_ir4jt_115";
const statusBar = "_statusBar_ir4jt_145";
const statusDot = "_statusDot_ir4jt_156";
const statusLabel = "_statusLabel_ir4jt_164";
const statusProject = "_statusProject_ir4jt_170";
const statusTask = "_statusTask_ir4jt_175";
const tabs$3 = "_tabs_ir4jt_183";
const tab$2 = "_tab_ir4jt_183";
const tabActive$1 = "_tabActive_ir4jt_206";
const tabContent$1 = "_tabContent_ir4jt_213";
const empty$2 = "_empty_ir4jt_219";
const markdown = "_markdown_ir4jt_229";
const mdH1 = "_mdH1_ir4jt_235";
const mdH2 = "_mdH2_ir4jt_242";
const mdH3 = "_mdH3_ir4jt_249";
const mdLi = "_mdLi_ir4jt_256";
const mdP = "_mdP_ir4jt_261";
const mdSpacer = "_mdSpacer_ir4jt_265";
const codeBlock = "_codeBlock_ir4jt_269";
const logList = "_logList_ir4jt_284";
const logEntry = "_logEntry_ir4jt_290";
const logEvent = "_logEvent_ir4jt_299";
const logIn = "_logIn_ir4jt_307";
const logOut = "_logOut_ir4jt_312";
const logProject = "_logProject_ir4jt_317";
const logTask = "_logTask_ir4jt_322";
const logTime = "_logTime_ir4jt_329";
const projectList = "_projectList_ir4jt_337";
const projectRow = "_projectRow_ir4jt_343";
const projectDot = "_projectDot_ir4jt_353";
const projectRowName = "_projectRowName_ir4jt_360";
const projectRowStatus = "_projectRowStatus_ir4jt_369";
const projectRowProgress = "_projectRowProgress_ir4jt_374";
const configBadge = "_configBadge_ir4jt_383";
const mcpList = "_mcpList_ir4jt_395";
const mcpRow = "_mcpRow_ir4jt_401";
const mcpMounted = "_mcpMounted_ir4jt_411";
const mcpInfo = "_mcpInfo_ir4jt_416";
const mcpName$1 = "_mcpName_ir4jt_421";
const mcpDesc$1 = "_mcpDesc_ir4jt_427";
const mcpMountBtn = "_mcpMountBtn_ir4jt_435";
const mcpUnmountBtn = "_mcpUnmountBtn_ir4jt_458";
const footer$1 = "_footer_ir4jt_482";
const styles$4 = {
  container: container$3,
  loading: loading$1,
  topBar: topBar$1,
  backBtn: backBtn$1,
  topName: topName$1,
  profileCard,
  profileInfo,
  displayName,
  meta,
  roleBadge,
  tempBadge,
  subMeta,
  uidLabel,
  leadBtn,
  statusBar,
  statusDot,
  statusLabel,
  statusProject,
  statusTask,
  tabs: tabs$3,
  tab: tab$2,
  tabActive: tabActive$1,
  tabContent: tabContent$1,
  empty: empty$2,
  markdown,
  mdH1,
  mdH2,
  mdH3,
  mdLi,
  mdP,
  mdSpacer,
  codeBlock,
  logList,
  logEntry,
  logEvent,
  logIn,
  logOut,
  logProject,
  logTask,
  logTime,
  projectList,
  projectRow,
  projectDot,
  projectRowName,
  projectRowStatus,
  projectRowProgress,
  configBadge,
  mcpList,
  mcpRow,
  mcpMounted,
  mcpInfo,
  mcpName: mcpName$1,
  mcpDesc: mcpDesc$1,
  mcpMountBtn,
  mcpUnmountBtn,
  footer: footer$1
};
function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function formatTime(iso) {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function renderMarkdown(text) {
  const lines = text.split("\n");
  const nodes = [];
  let inCode = false;
  let codeLines = [];
  let key = 0;
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        nodes.push(/* @__PURE__ */ jsxRuntimeExports.jsx("pre", { className: styles$4.codeBlock, children: codeLines.join("\n") }, key++));
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (line.startsWith("# ")) {
      nodes.push(/* @__PURE__ */ jsxRuntimeExports.jsx("h3", { className: styles$4.mdH1, children: line.slice(2) }, key++));
    } else if (line.startsWith("## ")) {
      nodes.push(/* @__PURE__ */ jsxRuntimeExports.jsx("h4", { className: styles$4.mdH2, children: line.slice(3) }, key++));
    } else if (line.startsWith("### ")) {
      nodes.push(/* @__PURE__ */ jsxRuntimeExports.jsx("h5", { className: styles$4.mdH3, children: line.slice(4) }, key++));
    } else if (line.startsWith("- ")) {
      nodes.push(/* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.mdLi, children: line }, key++));
    } else if (line.trim() === "") {
      nodes.push(/* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.mdSpacer }, key++));
    } else {
      nodes.push(/* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.mdP, children: line }, key++));
    }
  }
  if (inCode && codeLines.length > 0) {
    nodes.push(/* @__PURE__ */ jsxRuntimeExports.jsx("pre", { className: styles$4.codeBlock, children: codeLines.join("\n") }, key++));
  }
  return nodes;
}
function MemberDetail({ memberName: memberName2, onBack }) {
  const [detail, setDetail] = reactExports.useState(null);
  const [loading2, setLoading] = reactExports.useState(true);
  const [tab2, setTab] = reactExports.useState("persona");
  const { store } = useAtomValue(mcpStoreAtom);
  const members = useAtomValue(membersAtom);
  const liveMember = reactExports.useMemo(() => members.find((m) => m.name === memberName2), [members, memberName2]);
  const [mountedNames, setMountedNames] = reactExports.useState(/* @__PURE__ */ new Set());
  const [toggling, setToggling] = reactExports.useState(/* @__PURE__ */ new Set());
  const [memberProjects, setMemberProjects] = reactExports.useState([]);
  const [showLeadModal, setShowLeadModal] = reactExports.useState(false);
  const [availableClis, setAvailableClis] = reactExports.useState(null);
  reactExports.useEffect(() => {
    setLoading(true);
    window.teamHub.getMemberDetail(memberName2).then((d) => {
      setDetail(d);
      setLoading(false);
    });
  }, [memberName2]);
  reactExports.useEffect(() => {
    window.teamHub.getMemberMcps(memberName2).then((mcps) => {
      setMountedNames(new Set(mcps.map((m) => m.name)));
    });
  }, [memberName2]);
  reactExports.useEffect(() => {
    window.teamHub.getMemberProjects(memberName2).then(setMemberProjects);
  }, [memberName2]);
  reactExports.useEffect(() => {
    const check = async () => {
      try {
        const result = await window.api?.scanAgentClis?.();
        setAvailableClis(result?.found?.length > 0);
      } catch {
        setAvailableClis(true);
      }
    };
    check();
  }, []);
  const handleToggle = reactExports.useCallback(async (mcpName2, mounted) => {
    setToggling((prev) => new Set(prev).add(mcpName2));
    if (mounted) {
      await window.teamHub.unmountMemberMcp(memberName2, mcpName2);
    } else {
      await window.teamHub.mountMemberMcp(memberName2, mcpName2);
    }
    const mcps = await window.teamHub.getMemberMcps(memberName2);
    setMountedNames(new Set(mcps.map((m) => m.name)));
    setToggling((prev) => {
      const n = new Set(prev);
      n.delete(mcpName2);
      return n;
    });
  }, [memberName2]);
  if (loading2) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.container, children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.loading, children: "加载中..." }) });
  }
  if (!detail) {
    return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$4.container, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$4.backBtn, onClick: onBack, children: "← 返回" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.loading, children: "成员不存在" })
    ] });
  }
  const { profile, persona, memory, workLog } = detail;
  const status = liveMember?.status ?? detail.status;
  const project = liveMember?.project ?? detail.project;
  const task = liveMember?.task ?? detail.task;
  const lastSeen = liveMember?.lastSeen ?? detail.lastSeen;
  const statusLabel2 = { working: "工作中", online: "在线", offline: "离线", reserved: "预约中" }[status];
  const isLeadDisabled = status === "working" || status === "reserved" || availableClis === false;
  const leadTooltip = availableClis === false ? "未检测到 agent CLI" : status === "working" ? "成员正在工作中" : status === "reserved" ? "成员已预约" : void 0;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$4.container, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$4.topBar, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$4.backBtn, onClick: onBack, children: "←" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.topName, children: profile.name })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$4.profileCard, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(Avatar, { uid: profile.uid, displayName: profile.name, size: 56, status }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$4.profileInfo, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.displayName, children: profile.name }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$4.meta, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.roleBadge, children: profile.role }),
          profile.type === "temporary" && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.tempBadge, children: "临时" })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.subMeta, children: /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.uidLabel, children: profile.uid.slice(0, 8) }) })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: styles$4.leadBtn,
          disabled: isLeadDisabled,
          title: leadTooltip,
          onClick: () => setShowLeadModal(true),
          children: ">_"
        }
      )
    ] }),
    showLeadModal && /* @__PURE__ */ jsxRuntimeExports.jsx(
      LeadModal,
      {
        memberName: profile.name,
        onClose: () => setShowLeadModal(false)
      }
    ),
    status === "working" && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$4.statusBar, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.statusDot }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.statusProject, children: project }),
      task && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.statusTask, children: task })
    ] }),
    status !== "working" && lastSeen && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$4.statusBar, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.statusLabel, children: statusLabel2 }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: styles$4.statusTask, children: [
        "最后活跃: ",
        formatTime(lastSeen)
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.tabs, children: ["persona", "memory", "log", "projects", "config"].map((t) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "button",
      {
        className: `${styles$4.tab} ${tab2 === t ? styles$4.tabActive : ""}`,
        onClick: () => setTab(t),
        children: [
          { persona: "角色", memory: "经验", log: "记录", projects: "项目", config: "配置" }[t],
          t === "config" && mountedNames.size > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.configBadge, children: mountedNames.size }),
          t === "projects" && memberProjects.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.configBadge, children: memberProjects.length })
        ]
      },
      t
    )) }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$4.tabContent, children: [
      tab2 === "persona" && (persona ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.markdown, children: renderMarkdown(persona) }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.empty, children: "暂无角色定义" })),
      tab2 === "memory" && (memory ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.markdown, children: renderMarkdown(memory) }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.empty, children: "暂无积累经验" })),
      tab2 === "log" && (workLog.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.logList, children: workLog.slice().reverse().map((entry, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$4.logEntry, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: `${styles$4.logEvent} ${entry.event === "check_in" ? styles$4.logIn : styles$4.logOut}`, children: entry.event === "check_in" ? "签入" : "签出" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.logProject, children: entry.project }),
        entry.task && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.logTask, children: entry.task }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.logTime, children: formatTime(entry.timestamp) })
      ] }, i)) }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.empty, children: "暂无工作记录" })),
      tab2 === "projects" && (memberProjects.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.empty, children: "暂未参与项目" }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.projectList, children: memberProjects.map((p) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$4.projectRow, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.projectDot, style: { background: p.status === "done" ? "#22c55e" : p.status === "abandoned" ? "#6b7280" : "#3b82f6" } }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.projectRowName, children: p.name }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$4.projectRowStatus, children: { planning: "策划", designing: "设计", developing: "开发", testing: "测试", bugfixing: "Bug修复", done: "完毕", abandoned: "废弃" }[p.status] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: styles$4.projectRowProgress, children: [
          p.progress,
          "%"
        ] })
      ] }, p.id)) })),
      tab2 === "config" && (store.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.empty, children: "团队商店暂无 MCP，请先在商店中安装" }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.mcpList, children: store.map((mcp) => {
        const mounted = mountedNames.has(mcp.name);
        const busy = toggling.has(mcp.name);
        return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `${styles$4.mcpRow} ${mounted ? styles$4.mcpMounted : ""}`, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$4.mcpInfo, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.mcpName, children: mcp.name }),
            mcp.description && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$4.mcpDesc, children: mcp.description })
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "button",
            {
              className: mounted ? styles$4.mcpUnmountBtn : styles$4.mcpMountBtn,
              disabled: busy,
              onClick: () => handleToggle(mcp.name, mounted),
              children: busy ? "..." : mounted ? "卸载" : "挂载"
            }
          )
        ] }, mcp.name);
      }) }))
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$4.footer, children: [
      "加入于 ",
      formatDate(profile.joined_at)
    ] })
  ] });
}
const container$2 = "_container_1k3a1_1";
const subTabs = "_subTabs_1k3a1_10";
const subTab = "_subTab_1k3a1_10";
const subTabActive = "_subTabActive_1k3a1_39";
const countBadge = "_countBadge_1k3a1_45";
const searchBar = "_searchBar_1k3a1_55";
const searchInput = "_searchInput_1k3a1_60";
const empty$1 = "_empty_1k3a1_80";
const emptyIcon = "_emptyIcon_1k3a1_89";
const emptyText$1 = "_emptyText_1k3a1_101";
const emptyHint$1 = "_emptyHint_1k3a1_107";
const list$1 = "_list_1k3a1_112";
const card$1 = "_card_1k3a1_119";
const cardInstalled = "_cardInstalled_1k3a1_129";
const cardHeader = "_cardHeader_1k3a1_133";
const mcpIcon = "_mcpIcon_1k3a1_139";
const cardInfo = "_cardInfo_1k3a1_153";
const mcpName = "_mcpName_1k3a1_158";
const installedTag = "_installedTag_1k3a1_167";
const mcpDesc = "_mcpDesc_1k3a1_176";
const descBlock = "_descBlock_1k3a1_186";
const cardMeta = "_cardMeta_1k3a1_197";
const command = "_command_1k3a1_205";
const pkgId = "_pkgId_1k3a1_215";
const runtimeBadge = "_runtimeBadge_1k3a1_224";
const version = "_version_1k3a1_233";
const envBadge = "_envBadge_1k3a1_238";
const sourceBadge = "_sourceBadge_1k3a1_247";
const mountedBy = "_mountedBy_1k3a1_255";
const mountLabel = "_mountLabel_1k3a1_263";
const mountBadge = "_mountBadge_1k3a1_269";
const mountNone = "_mountNone_1k3a1_277";
const installBtn = "_installBtn_1k3a1_282";
const uninstallBtn = "_uninstallBtn_1k3a1_305";
const styles$3 = {
  container: container$2,
  subTabs,
  subTab,
  subTabActive,
  countBadge,
  searchBar,
  searchInput,
  empty: empty$1,
  emptyIcon,
  emptyText: emptyText$1,
  emptyHint: emptyHint$1,
  list: list$1,
  card: card$1,
  cardInstalled,
  cardHeader,
  mcpIcon,
  cardInfo,
  mcpName,
  installedTag,
  mcpDesc,
  descBlock,
  cardMeta,
  command,
  pkgId,
  runtimeBadge,
  version,
  envBadge,
  sourceBadge,
  mountedBy,
  mountLabel,
  mountBadge,
  mountNone,
  installBtn,
  uninstallBtn
};
function RuntimeBadge({ hint: hint2 }) {
  if (!hint2) return null;
  return /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$3.runtimeBadge, children: hint2 });
}
function buildCommand(pkg) {
  const hint2 = pkg.runtimeHint ?? "";
  const id = pkg.identifier;
  if (hint2 === "npx") return { command: "npx", args: ["-y", id] };
  if (hint2 === "uvx") return { command: "uvx", args: [id] };
  if (hint2 === "node") return { command: "node", args: [id] };
  if (hint2 === "docker") return { command: "docker", args: ["run", "-i", id] };
  if (pkg.registryType === "npm") return { command: "npx", args: ["-y", id] };
  if (pkg.registryType === "pypi") return { command: "uvx", args: [id] };
  return { command: id, args: [] };
}
function McpStore() {
  const [tab2, setTab] = useAtom(storeTabAtom);
  const { store, memberMounts } = useAtomValue(mcpStoreAtom);
  const setMcpStore = useSetAtom(mcpStoreAtom);
  const registry = useAtomValue(registryAtom);
  useAtomValue(membersAtom);
  const [search, setSearch] = useAtom(registrySearchAtom);
  const setRegistry = useSetAtom(registryAtom);
  const [installing, setInstalling] = reactExports.useState(/* @__PURE__ */ new Set());
  const installedNames = new Set(store.map((s) => s.name));
  const doSearch = reactExports.useCallback((q) => {
    setSearch(q);
    window.teamHub.getRegistry(q || void 0).then(setRegistry);
  }, [setSearch, setRegistry]);
  const refreshStore = reactExports.useCallback(() => {
    window.teamHub.getMcpStore().then(setMcpStore);
  }, [setMcpStore]);
  const handleInstall = reactExports.useCallback(async (server) => {
    const pkg = server.packages?.[0];
    if (!pkg) return;
    const { command: command2, args } = buildCommand(pkg);
    setInstalling((prev) => new Set(prev).add(server.name));
    await window.teamHub.installStoreMcp({
      name: server.name,
      command: command2,
      args,
      description: server.description
    });
    setInstalling((prev) => {
      const n = new Set(prev);
      n.delete(server.name);
      return n;
    });
    refreshStore();
  }, [refreshStore]);
  const handleUninstall = reactExports.useCallback(async (name) => {
    await window.teamHub.uninstallStoreMcp(name);
    refreshStore();
  }, [refreshStore]);
  function getMountedMembers(mcpName2) {
    return memberMounts.filter((m) => m.mcps.includes(mcpName2)).map((m) => m.name);
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$3.container, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$3.subTabs, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "button",
        {
          className: `${styles$3.subTab} ${tab2 === "installed" ? styles$3.subTabActive : ""}`,
          onClick: () => setTab("installed"),
          children: [
            "已安装 ",
            store.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$3.countBadge, children: store.length })
          ]
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "button",
        {
          className: `${styles$3.subTab} ${tab2 === "registry" ? styles$3.subTabActive : ""}`,
          onClick: () => setTab("registry"),
          children: [
            "仓库 ",
            registry.metadata.count > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$3.countBadge, children: registry.metadata.count })
          ]
        }
      )
    ] }),
    tab2 === "installed" && (store.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$3.empty, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.emptyIcon, children: "+" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.emptyText, children: "尚未安装 MCP" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.emptyHint, children: "切换到「仓库」浏览可用 MCP" })
    ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.list, children: store.map((mcp) => {
      const mountedBy2 = getMountedMembers(mcp.name);
      return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$3.card, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$3.cardHeader, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.mcpIcon, children: "M" }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$3.cardInfo, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.mcpName, children: mcp.name }),
            mcp.description && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.mcpDesc, children: mcp.description })
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$3.uninstallBtn, onClick: () => handleUninstall(mcp.name), children: "卸载" })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.cardMeta, children: /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: styles$3.command, children: [
          mcp.command,
          " ",
          mcp.args?.join(" ")
        ] }) }),
        mountedBy2.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$3.mountedBy, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$3.mountLabel, children: "已挂载" }),
          mountedBy2.map((name) => /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$3.mountBadge, children: name }, name))
        ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.mountedBy, children: /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$3.mountNone, children: "未被挂载" }) })
      ] }, mcp.name);
    }) })),
    tab2 === "registry" && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.searchBar, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: styles$3.searchInput,
          placeholder: "搜索 MCP...",
          value: search,
          onChange: (e) => doSearch(e.target.value)
        }
      ) }),
      registry.servers.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$3.empty, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.emptyIcon, children: "?" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.emptyText, children: search ? "无搜索结果" : "加载中..." })
      ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.list, children: registry.servers.map((item) => {
        const s = item.server;
        const pkg = s.packages?.[0];
        const installed = installedNames.has(s.name);
        return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `${styles$3.card} ${installed ? styles$3.cardInstalled : ""}`, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$3.cardHeader, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.mcpIcon, children: s.title ? s.title.charAt(0).toUpperCase() : "M" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.cardInfo, children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.mcpName, children: s.title || s.name }) }),
            installed ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$3.installedTag, children: "已安装" }) : /* @__PURE__ */ jsxRuntimeExports.jsx(
              "button",
              {
                className: styles$3.installBtn,
                disabled: installing.has(s.name),
                onClick: () => handleInstall(s),
                children: installing.has(s.name) ? "..." : "安装"
              }
            )
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$3.descBlock, children: s.description }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$3.cardMeta, children: [
            pkg && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(RuntimeBadge, { hint: pkg.runtimeHint }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$3.pkgId, children: pkg.identifier }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: styles$3.version, children: [
                "v",
                s.version
              ] }),
              pkg.environmentVariables && pkg.environmentVariables.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: styles$3.envBadge, children: [
                pkg.environmentVariables.length,
                " env"
              ] })
            ] }),
            s.repository?.source && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$3.sourceBadge, children: s.repository.source })
          ] })
        ] }, s.name);
      }) })
    ] })
  ] });
}
const container$1 = "_container_jrxeo_1";
const toolbar = "_toolbar_jrxeo_10";
const addBtn = "_addBtn_jrxeo_15";
const createRow = "_createRow_jrxeo_33";
const createInput = "_createInput_jrxeo_38";
const createConfirm = "_createConfirm_jrxeo_53";
const createCancel = "_createCancel_jrxeo_64";
const empty = "_empty_jrxeo_74";
const emptyText = "_emptyText_jrxeo_83";
const emptyHint = "_emptyHint_jrxeo_89";
const list = "_list_jrxeo_94";
const card = "_card_jrxeo_101";
const cardTop = "_cardTop_jrxeo_117";
const projectName = "_projectName_jrxeo_124";
const statusTag = "_statusTag_jrxeo_133";
const desc = "_desc_jrxeo_142";
const progressBar = "_progressBar_jrxeo_150";
const progressFill = "_progressFill_jrxeo_157";
const cardBottom = "_cardBottom_jrxeo_163";
const memberAvatars = "_memberAvatars_jrxeo_169";
const moreMembers = "_moreMembers_jrxeo_175";
const noMembers = "_noMembers_jrxeo_181";
const progressText = "_progressText_jrxeo_186";
const styles$2 = {
  container: container$1,
  toolbar,
  addBtn,
  createRow,
  createInput,
  createConfirm,
  createCancel,
  empty,
  emptyText,
  emptyHint,
  list,
  card,
  cardTop,
  projectName,
  statusTag,
  desc,
  progressBar,
  progressFill,
  cardBottom,
  memberAvatars,
  moreMembers,
  noMembers,
  progressText
};
const STATUS_LABELS = {
  planning: "策划中",
  designing: "设计中",
  developing: "开发中",
  testing: "测试中",
  bugfixing: "Bug修复",
  done: "完毕",
  abandoned: "废弃"
};
const STATUS_COLORS$1 = {
  planning: "#f59e0b",
  designing: "#8b5cf6",
  developing: "#3b82f6",
  testing: "#06b6d4",
  bugfixing: "#ef4444",
  done: "#22c55e",
  abandoned: "#6b7280"
};
function ProjectList() {
  const projects = useAtomValue(projectsAtom);
  const members = useAtomValue(membersAtom);
  const setSelected = useSetAtom(selectedProjectAtom);
  const setProjects = useSetAtom(projectsAtom);
  const [creating, setCreating] = reactExports.useState(false);
  const [newName, setNewName] = reactExports.useState("");
  const refreshProjects = reactExports.useCallback(() => {
    window.teamHub.listProjects().then(setProjects);
  }, [setProjects]);
  const handleCreate = reactExports.useCallback(async () => {
    if (!newName.trim()) return;
    await window.teamHub.createProject({
      name: newName.trim(),
      description: "",
      status: "planning",
      progress: 0,
      members: [],
      experience: "",
      forbidden: [],
      rules: []
    });
    setNewName("");
    setCreating(false);
    refreshProjects();
  }, [newName, refreshProjects]);
  const getMemberInfo = (name) => members.find((m) => m.name === name);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$2.container, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$2.toolbar, children: creating ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$2.createRow, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: styles$2.createInput,
          placeholder: "项目名称",
          value: newName,
          onChange: (e) => setNewName(e.target.value),
          onKeyDown: (e) => e.key === "Enter" && handleCreate(),
          autoFocus: true
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$2.createConfirm, onClick: handleCreate, children: "创建" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$2.createCancel, onClick: () => {
        setCreating(false);
        setNewName("");
      }, children: "取消" })
    ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$2.addBtn, onClick: () => setCreating(true), children: "+ 新建项目" }) }),
    projects.length === 0 && !creating ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$2.empty, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$2.emptyText, children: "暂无项目" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$2.emptyHint, children: "点击「新建项目」开始" })
    ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$2.list, children: projects.map((p) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$2.card, onClick: () => setSelected(p.id), children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$2.cardTop, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$2.projectName, children: p.name }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$2.statusTag, style: { background: STATUS_COLORS$1[p.status] + "18", color: STATUS_COLORS$1[p.status] }, children: STATUS_LABELS[p.status] })
      ] }),
      p.description && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$2.desc, children: p.description }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$2.progressBar, children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$2.progressFill, style: { width: `${p.progress}%`, background: STATUS_COLORS$1[p.status] } }) }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$2.cardBottom, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$2.memberAvatars, children: [
          p.members.slice(0, 5).map((name) => {
            const m = getMemberInfo(name);
            return /* @__PURE__ */ jsxRuntimeExports.jsx(Avatar, { uid: m?.uid ?? name, displayName: m?.name ?? name, size: 18 }, name);
          }),
          p.members.length > 5 && /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: styles$2.moreMembers, children: [
            "+",
            p.members.length - 5
          ] }),
          p.members.length === 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$2.noMembers, children: "无成员" })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: styles$2.progressText, children: [
          p.progress,
          "%"
        ] })
      ] })
    ] }, p.id)) })
  ] });
}
const container = "_container_br1el_1";
const loading = "_loading_br1el_8";
const topBar = "_topBar_br1el_17";
const backBtn = "_backBtn_br1el_25";
const topName = "_topName_br1el_42";
const nameInput = "_nameInput_br1el_53";
const statusRow = "_statusRow_br1el_66";
const statusSelect = "_statusSelect_br1el_70";
const statusBtn = "_statusBtn_br1el_77";
const statusActive = "_statusActive_br1el_93";
const progressRow = "_progressRow_br1el_97";
const progressBarBig = "_progressBarBig_br1el_103";
const progressFillBig = "_progressFillBig_br1el_111";
const progressNum = "_progressNum_br1el_117";
const progressInput = "_progressInput_br1el_130";
const tabs$2 = "_tabs_br1el_144";
const tab$1 = "_tab_br1el_144";
const tabActive = "_tabActive_br1el_167";
const tabContent = "_tabContent_br1el_173";
const overviewContent = "_overviewContent_br1el_180";
const section = "_section_br1el_186";
const sectionLabel = "_sectionLabel_br1el_192";
const sectionText = "_sectionText_br1el_200";
const textarea = "_textarea_br1el_217";
const memberContent = "_memberContent_br1el_231";
const memberHint = "_memberHint_br1el_237";
const memberGrid = "_memberGrid_br1el_243";
const memberCard = "_memberCard_br1el_249";
const memberIn = "_memberIn_br1el_265";
const memberName = "_memberName_br1el_270";
const memberCheck = "_memberCheck_br1el_275";
const rulesContent = "_rulesContent_br1el_282";
const ruleSection = "_ruleSection_br1el_288";
const ruleTitle = "_ruleTitle_br1el_294";
const ruleItem = "_ruleItem_br1el_300";
const ruleDot = "_ruleDot_br1el_308";
const ruleText = "_ruleText_br1el_315";
const ruleRemove = "_ruleRemove_br1el_320";
const ruleAdd = "_ruleAdd_br1el_340";
const ruleInput = "_ruleInput_br1el_346";
const ruleAddBtn = "_ruleAddBtn_br1el_361";
const footer = "_footer_br1el_377";
const styles$1 = {
  container,
  loading,
  topBar,
  backBtn,
  topName,
  nameInput,
  statusRow,
  statusSelect,
  statusBtn,
  statusActive,
  progressRow,
  progressBarBig,
  progressFillBig,
  progressNum,
  progressInput,
  tabs: tabs$2,
  tab: tab$1,
  tabActive,
  tabContent,
  overviewContent,
  section,
  sectionLabel,
  sectionText,
  textarea,
  memberContent,
  memberHint,
  memberGrid,
  memberCard,
  memberIn,
  memberName,
  memberCheck,
  rulesContent,
  ruleSection,
  ruleTitle,
  ruleItem,
  ruleDot,
  ruleText,
  ruleRemove,
  ruleAdd,
  ruleInput,
  ruleAddBtn,
  footer
};
const STATUS_LIST = [
  { key: "planning", label: "策划中" },
  { key: "designing", label: "设计中" },
  { key: "developing", label: "开发中" },
  { key: "testing", label: "测试中" },
  { key: "bugfixing", label: "Bug修复" },
  { key: "done", label: "完毕" },
  { key: "abandoned", label: "废弃" }
];
const STATUS_COLORS = {
  planning: "#f59e0b",
  designing: "#8b5cf6",
  developing: "#3b82f6",
  testing: "#06b6d4",
  bugfixing: "#ef4444",
  done: "#22c55e",
  abandoned: "#6b7280"
};
function ProjectDetail({ projectId, onBack }) {
  const allMembers = useAtomValue(membersAtom);
  const setProjects = useSetAtom(projectsAtom);
  const [project, setProject] = reactExports.useState(null);
  const [loading2, setLoading] = reactExports.useState(true);
  const [tab2, setTab] = reactExports.useState("overview");
  const [editing, setEditing] = reactExports.useState(null);
  const [editValue, setEditValue] = reactExports.useState("");
  const load = reactExports.useCallback(() => {
    window.teamHub.getProject(projectId).then((p) => {
      setProject(p);
      setLoading(false);
    });
  }, [projectId]);
  reactExports.useEffect(() => {
    load();
  }, [load]);
  const save = reactExports.useCallback(async (patch) => {
    const updated = await window.teamHub.updateProject(projectId, patch);
    if (updated) setProject(updated);
    window.teamHub.listProjects().then(setProjects);
  }, [projectId, setProjects]);
  const startEdit = (field, value) => {
    setEditing(field);
    setEditValue(value);
  };
  const commitEdit = (field) => {
    if (field === "description" || field === "experience") {
      save({ [field]: editValue });
    } else if (field === "name") {
      save({ name: editValue });
    } else if (field === "progress") {
      const n = Math.min(100, Math.max(0, parseInt(editValue) || 0));
      save({ progress: n });
    }
    setEditing(null);
  };
  const toggleMember = reactExports.useCallback((memberName2) => {
    if (!project) return;
    const has = project.members.includes(memberName2);
    const members = has ? project.members.filter((m) => m !== memberName2) : [...project.members, memberName2];
    save({ members });
  }, [project, save]);
  const addListItem = reactExports.useCallback((field, value) => {
    if (!project || !value.trim()) return;
    save({ [field]: [...project[field], value.trim()] });
  }, [project, save]);
  const removeListItem = reactExports.useCallback((field, index) => {
    if (!project) return;
    const list2 = [...project[field]];
    list2.splice(index, 1);
    save({ [field]: list2 });
  }, [project, save]);
  if (loading2) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$1.container, children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$1.loading, children: "加载中..." }) });
  }
  if (!project) {
    return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.container, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$1.backBtn, onClick: onBack, children: "← 返回" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$1.loading, children: "项目不存在" })
    ] });
  }
  const color = STATUS_COLORS[project.status];
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.container, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.topBar, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$1.backBtn, onClick: onBack, children: "←" }),
      editing === "name" ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: styles$1.nameInput,
          value: editValue,
          onChange: (e) => setEditValue(e.target.value),
          onBlur: () => commitEdit("name"),
          onKeyDown: (e) => e.key === "Enter" && commitEdit("name"),
          autoFocus: true
        }
      ) : /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$1.topName, onClick: () => startEdit("name", project.name), children: project.name })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.statusRow, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$1.statusSelect, children: STATUS_LIST.map((s) => /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: `${styles$1.statusBtn} ${project.status === s.key ? styles$1.statusActive : ""}`,
          style: project.status === s.key ? { background: STATUS_COLORS[s.key] + "20", color: STATUS_COLORS[s.key], borderColor: STATUS_COLORS[s.key] + "40" } : void 0,
          onClick: () => save({ status: s.key }),
          children: s.label
        },
        s.key
      )) }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.progressRow, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$1.progressBarBig, children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$1.progressFillBig, style: { width: `${project.progress}%`, background: color } }) }),
        editing === "progress" ? /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            className: styles$1.progressInput,
            type: "number",
            value: editValue,
            onChange: (e) => setEditValue(e.target.value),
            onBlur: () => commitEdit("progress"),
            onKeyDown: (e) => e.key === "Enter" && commitEdit("progress"),
            autoFocus: true
          }
        ) : /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: styles$1.progressNum, onClick: () => startEdit("progress", String(project.progress)), children: [
          project.progress,
          "%"
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$1.tabs, children: ["overview", "members", "rules"].map((t) => /* @__PURE__ */ jsxRuntimeExports.jsx(
      "button",
      {
        className: `${styles$1.tab} ${tab2 === t ? styles$1.tabActive : ""}`,
        onClick: () => setTab(t),
        children: { overview: "概览", members: `成员(${project.members.length})`, rules: "规则" }[t]
      },
      t
    )) }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.tabContent, children: [
      tab2 === "overview" && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.overviewContent, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.section, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$1.sectionLabel, children: "描述" }),
          editing === "description" ? /* @__PURE__ */ jsxRuntimeExports.jsx(
            "textarea",
            {
              className: styles$1.textarea,
              value: editValue,
              onChange: (e) => setEditValue(e.target.value),
              onBlur: () => commitEdit("description"),
              autoFocus: true,
              rows: 3
            }
          ) : /* @__PURE__ */ jsxRuntimeExports.jsx(
            "div",
            {
              className: styles$1.sectionText,
              onClick: () => startEdit("description", project.description),
              children: project.description || "点击添加描述..."
            }
          )
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.section, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$1.sectionLabel, children: "项目经验" }),
          editing === "experience" ? /* @__PURE__ */ jsxRuntimeExports.jsx(
            "textarea",
            {
              className: styles$1.textarea,
              value: editValue,
              onChange: (e) => setEditValue(e.target.value),
              onBlur: () => commitEdit("experience"),
              autoFocus: true,
              rows: 4
            }
          ) : /* @__PURE__ */ jsxRuntimeExports.jsx(
            "div",
            {
              className: styles$1.sectionText,
              onClick: () => startEdit("experience", project.experience),
              children: project.experience || "点击记录项目经验..."
            }
          )
        ] })
      ] }),
      tab2 === "members" && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.memberContent, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$1.memberHint, children: "点击成员可切换加入/移除" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$1.memberGrid, children: allMembers.map((m) => {
          const inProject = project.members.includes(m.name);
          return /* @__PURE__ */ jsxRuntimeExports.jsxs(
            "div",
            {
              className: `${styles$1.memberCard} ${inProject ? styles$1.memberIn : ""}`,
              onClick: () => toggleMember(m.name),
              children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx(Avatar, { uid: m.uid, displayName: m.name, size: 28, status: m.status }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$1.memberName, children: m.name }),
                inProject && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$1.memberCheck, children: "✓" })
              ]
            },
            m.uid
          );
        }) })
      ] }),
      tab2 === "rules" && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.rulesContent, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          RuleList,
          {
            title: "绝对禁止",
            color: "#ef4444",
            items: project.forbidden,
            onAdd: (v) => addListItem("forbidden", v),
            onRemove: (i) => removeListItem("forbidden", i)
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          RuleList,
          {
            title: "绝对遵循",
            color: "#22c55e",
            items: project.rules,
            onAdd: (v) => addListItem("rules", v),
            onRemove: (i) => removeListItem("rules", i)
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.footer, children: [
      "创建于 ",
      project.created_at.slice(0, 10),
      " · 更新于 ",
      project.updated_at.slice(0, 10)
    ] })
  ] });
}
function RuleList({ title: title2, color, items, onAdd, onRemove }) {
  const [value, setValue] = reactExports.useState("");
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.ruleSection, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles$1.ruleTitle, style: { color }, children: title2 }),
    items.map((item, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.ruleItem, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$1.ruleDot, style: { background: color } }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles$1.ruleText, children: item }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$1.ruleRemove, onClick: () => onRemove(i), children: "×" })
    ] }, i)),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles$1.ruleAdd, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: styles$1.ruleInput,
          placeholder: `添加${title2}项...`,
          value,
          onChange: (e) => setValue(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter" && value.trim()) {
              onAdd(value);
              setValue("");
            }
          }
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: styles$1.ruleAddBtn, onClick: () => {
        if (value.trim()) {
          onAdd(value);
          setValue("");
        }
      }, children: "+" })
    ] })
  ] });
}
const nav = "_nav_le6jx_1";
const tabs$1 = "_tabs_le6jx_10";
const tab = "_tab_le6jx_10";
const active = "_active_le6jx_35";
const badge = "_badge_le6jx_41";
const stats = "_stats_le6jx_51";
const styles = {
  nav,
  tabs: tabs$1,
  tab,
  active,
  badge,
  stats
};
const tabs = [
  { key: "team", label: "团队" },
  { key: "projects", label: "项目" },
  { key: "store", label: "商店" }
];
function NavBar() {
  const [page, setPage] = useAtom(pageAtom);
  const sessions = useAtomValue(sessionsAtom);
  const workingCount = useAtomValue(workingCountAtom);
  const reservedCount = useAtomValue(reservedCountAtom);
  const offlineCount = useAtomValue(offlineCountAtom);
  const { store } = useAtomValue(mcpStoreAtom);
  const activeProjects = useAtomValue(activeProjectsCountAtom);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles.nav, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: styles.tabs, children: tabs.map((tab2) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "button",
      {
        className: `${styles.tab} ${page === tab2.key ? styles.active : ""}`,
        onClick: () => setPage(tab2.key),
        children: [
          tab2.label,
          tab2.key === "store" && store.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles.badge, children: store.length }),
          tab2.key === "projects" && activeProjects > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: styles.badge, children: activeProjects })
        ]
      },
      tab2.key
    )) }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: styles.stats, children: [
      sessions.length,
      " Claude · ",
      workingCount,
      "忙 · ",
      reservedCount,
      "预约 · ",
      offlineCount,
      "离线"
    ] })
  ] });
}
function AppInner() {
  const status = useAtomValue(teamStatusAtom);
  const page = useAtomValue(pageAtom);
  const selectedMember = useAtomValue(selectedMemberAtom);
  const setSelectedMember = useSetAtom(selectedMemberAtom);
  const selectedProject = useAtomValue(selectedProjectAtom);
  const setSelectedProject = useSetAtom(selectedProjectAtom);
  if (!status) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel", style: { display: "flex", alignItems: "center", justifyContent: "center" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { color: "var(--text-idle)", fontSize: 12 }, children: "加载中..." }) });
  }
  if (selectedMember) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      MemberDetail,
      {
        memberName: selectedMember,
        onBack: () => setSelectedMember(null)
      }
    ) });
  }
  if (selectedProject) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "panel", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      ProjectDetail,
      {
        projectId: selectedProject,
        onBack: () => setSelectedProject(null)
      }
    ) });
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "panel", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(Header, {}),
    page === "team" && /* @__PURE__ */ jsxRuntimeExports.jsx(MemberList, { onMemberClick: (name) => setSelectedMember(name) }),
    page === "projects" && /* @__PURE__ */ jsxRuntimeExports.jsx(ProjectList, {}),
    page === "store" && /* @__PURE__ */ jsxRuntimeExports.jsx(McpStore, {}),
    /* @__PURE__ */ jsxRuntimeExports.jsx(NavBar, {})
  ] });
}
function App() {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(Provider, { children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(IpcBridge, {}),
    /* @__PURE__ */ jsxRuntimeExports.jsx(AppInner, {})
  ] });
}
client.createRoot(document.getElementById("root")).render(
  /* @__PURE__ */ jsxRuntimeExports.jsx(React.StrictMode, { children: /* @__PURE__ */ jsxRuntimeExports.jsx(App, {}) })
);
