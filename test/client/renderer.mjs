/**
 * A stateful render harness, for the interaction the page is actually good at.
 *
 * The rest of the client tests render once and read the text: enough for a pure view,
 * and honest about what it skips. It skips everything that only happens after a click —
 * a commit opening its files, a file opening its patch — which is precisely the part a
 * regression would silently break. Asserting the props of a row proves the row is wired;
 * it does not prove the click reaches the fetch.
 *
 * `react-dom` is not installed, so this is a small renderer rather than a test-library
 * mount. It supports the subset the client needs: function components, fragments, host
 * elements, and the five hooks (`useState`, `useEffect`, `useRef`, `useMemo`,
 * `useCallback`) with real re-render and real effects. Two deliberate limits:
 *
 *   identity — a component instance is keyed by its position in the tree, not by its
 *              `key` prop. Lists that reorder under an open row would lose state; the
 *              panel does not do that, and pretending otherwise would need a reconciler.
 *   batching — `setState` marks the mount dirty and the caller settles it with
 *              `settle()`. There is no scheduler, no priority, no concurrent mode.
 *
 * Both limits are the reason this file stays ~200 lines instead of growing into a
 * re-implementation of React.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const React = require('react');
const FRAGMENT = Symbol.for('react.fragment');

/** The mount whose components are rendering now. Hooks outside one are React's own. */
let active = null;

const originalHooks = {
  useState: React.useState,
  useEffect: React.useEffect,
  useRef: React.useRef,
  useMemo: React.useMemo,
  useCallback: React.useCallback,
};

/**
 * Whatever was installed before us — in this repo that is `client.mjs`'s single-pass
 * shim, which the other suites still use. Captured at install time, restored at
 * unmount, so a mount never leaks into the next test.
 *
 * @type {typeof originalHooks | null}
 */
let displaced = null;

/**
 * The object the bundle actually calls hooks on. `client.mjs` hands the bundle a React
 * facade (real `createElement`, stubbed hooks); patching the real module instead would
 * be invisible to it.
 *
 * @type {any}
 */
let hookHost = React;

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** @param {() => any} make */
function nextSlot(make) {
  if (active === null) throw new Error('renderer: hook called with no mount');
  const frame = active.stack[active.stack.length - 1];
  if (frame === undefined) throw new Error('renderer: hook called outside a component');
  const index = frame.cursor++;
  const slots = frame.instance.slots;
  if (!(index in slots)) slots[index] = make();
  return { mount: active, frame, index, slot: slots[index] };
}

/** @param {any} initial */
function useState(initial) {
  if (active === null) return originalHooks.useState(initial);
  const { mount, index, slot } = nextSlot(() => ({
    kind: 'state',
    value: typeof initial === 'function' ? initial() : initial,
  }));
  const instance = mount.stack[mount.stack.length - 1].instance;
  const set = (next) => {
    const currentSlot = instance.slots[index];
    const value = typeof next === 'function' ? next(currentSlot.value) : next;
    if (Object.is(value, currentSlot.value)) return;
    currentSlot.value = value;
    mount.dirty = true;
  };
  return [slot.value, set];
}

/** @param {() => any} fn @param {any[]} [deps] */
function useEffect(fn, deps) {
  if (active === null) return originalHooks.useEffect(fn, deps);
  const { mount, slot } = nextSlot(() => ({
    kind: 'effect',
    seen: false,
    deps: undefined,
    cleanup: undefined,
  }));
  slot.fn = fn;
  const changed = slot.seen === false || deps === undefined || !sameDeps(slot.deps, deps);
  slot.seen = true;
  if (!changed) return undefined;
  slot.deps = deps;
  mount.pending.push(slot);
  return undefined;
}

/** @param {any} initial */
function useRef(initial) {
  if (active === null) return originalHooks.useRef(initial);
  const { slot } = nextSlot(() => ({ kind: 'ref', current: initial }));
  return slot;
}

/** @param {() => any} fn @param {any[]} [deps] */
function useMemo(fn, deps) {
  if (active === null) return originalHooks.useMemo(fn, deps);
  const { slot } = nextSlot(() => ({ kind: 'memo', seen: false, deps: undefined, value: undefined }));
  const changed = slot.seen === false || deps === undefined || !sameDeps(slot.deps, deps);
  slot.seen = true;
  if (!changed) return slot.value;
  slot.deps = deps;
  slot.value = fn();
  return slot.value;
}

/** @param {any} fn @param {any[]} [deps] */
function useCallback(fn, deps) {
  return useMemo(() => fn, deps);
}

/** @param {any[] | undefined} left @param {any[] | undefined} right */
function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

// The client bundle holds this exact module object and calls `React.useState(...)`.
// Replacing the exports is the only way to intercept those calls without a bundler —
// but only for the duration of a mount: the other suites render through their own
// single-pass shim and would see a renderer stack that is not there.
function installHooks() {
  if (displaced !== null) return;
  displaced = {
    useState: hookHost.useState,
    useEffect: hookHost.useEffect,
    useRef: hookHost.useRef,
    useMemo: hookHost.useMemo,
    useCallback: hookHost.useCallback,
  };
  hookHost.useState = useState;
  hookHost.useEffect = useEffect;
  hookHost.useRef = useRef;
  hookHost.useMemo = useMemo;
  hookHost.useCallback = useCallback;
}

function restoreHooks() {
  if (displaced === null) return;
  hookHost.useState = displaced.useState;
  hookHost.useEffect = displaced.useEffect;
  hookHost.useRef = displaced.useRef;
  hookHost.useMemo = displaced.useMemo;
  hookHost.useCallback = displaced.useCallback;
  displaced = null;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Mount a tree and hand back a controller.
 *
 * @param {any} element
 * @param {{ react?: any }} [options] the object the bundle calls hooks on, when that is
 *   not the real `react` module (`client.mjs` hands the bundle a facade).
 * @param {any} element
 * @returns {{
 *   nodes: () => Array<{type: string, props: any, children: any[]}>,
 *   find: (predicate: (node: any) => boolean) => any,
 *   findAll: (predicate: (node: any) => boolean) => any[],
 *   text: () => string,
 *   textOf: (node: any) => string,
 *   fire: (node: any, prop: string, event?: any) => boolean,
 *   click: (node: any) => boolean,
 *   settle: (rounds?: number) => Promise<void>,
 *   unmount: () => void,
 * }}
 */
export function mount(element, options = {}) {
  if (options.react !== undefined) hookHost = options.react;
  /** @type {any} */
  const mountState = {
    element,
    root: [],
    instances: new Map(),
    stack: [],
    pending: [],
    dirty: false,
    renders: 0,
    depth: 0,
  };

  /** @param {string} key @param {any} type */
  const instanceAt = (key, type) => {
    const existing = mountState.instances.get(key);
    if (existing !== undefined && existing.component === type) return existing;
    const created = { component: type, slots: [] };
    mountState.instances.set(key, created);
    return created;
  };

  /** @param {any} el @param {string} key @returns {any} */
  const renderElement = (el, key) => {
    if (el === null || el === undefined || typeof el === 'boolean') return null;
    if (typeof el === 'string' || typeof el === 'number') {
      return { kind: 'text', value: String(el) };
    }
    if (Array.isArray(el)) {
      return el.map((child, index) => renderElement(child, `${key}[${index}]`));
    }
    if (typeof el !== 'object' || el.type === undefined) return null;

    const type = el.type;
    const props = el.props ?? {};

    if (type === FRAGMENT) return renderElement(props.children, `${key}:f`);

    if (typeof type === 'function') {
      const instance = instanceAt(key, type);
      mountState.stack.push({ instance, cursor: 0 });
      let output;
      mountState.depth += 1;
      if (mountState.depth > 200) throw new Error('renderer: component tree too deep');
      try {
        output = type(props);
      } finally {
        mountState.depth -= 1;
        mountState.stack.pop();
      }
      return renderElement(output, `${key}>`);
    }

    return {
      kind: 'host',
      type: String(type),
      props,
      children: flatten(renderElement(props.children, `${key}/${String(type)}`)),
    };
  };

  const runEffects = () => {
    const ready = mountState.pending;
    mountState.pending = [];
    for (const slot of ready) {
      if (typeof slot.cleanup === 'function') slot.cleanup();
      const cleanup = slot.fn();
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
  };

  const run = () => {
    let guard = 0;
    for (;;) {
      mountState.dirty = false;
      mountState.renders += 1;
      if (mountState.renders > 400) throw new Error('renderer: render loop did not settle');
      mountState.stack.length = 0;
      mountState.depth = 0;
      mountState.pending = [];
      const previous = active;
      active = mountState;
      try {
        mountState.root = flatten(renderElement(mountState.element, 'root'));
        runEffects();
      } finally {
        active = previous;
      }
      guard += 1;
      if (!mountState.dirty) break;
      if (guard > 50) throw new Error('renderer: state never settled');
    }
  };

  /** @param {any} node @param {any[]} out */
  const collect = (node, out) => {
    if (node === null || node === undefined) return out;
    if (Array.isArray(node)) {
      for (const child of node) collect(child, out);
      return out;
    }
    if (node.kind !== 'host') return out;
    out.push(node);
    collect(node.children, out);
    return out;
  };

  /** @param {any} node */
  const textOf = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (Array.isArray(node)) return node.map(textOf).filter((part) => part !== '').join(' ');
    if (node.kind === 'text') return node.value;
    if (node.kind === 'host') return textOf(node.children);
    return '';
  };

  const controller = {
    nodes: () => collect(mountState.root, []),
    find: (predicate) => collect(mountState.root, []).find(predicate),
    findAll: (predicate) => collect(mountState.root, []).filter(predicate),
    text: () => textOf(mountState.root),
    textOf,
    fire: (node, prop, event) => {
      const handler = node?.props?.[prop];
      if (typeof handler !== 'function') return false;
      const previous = active;
      active = mountState;
      try {
        handler(event ?? { preventDefault() {}, key: 'Enter', stopPropagation() {} });
      } finally {
        active = previous;
      }
      run();
      return true;
    },
    click: (node) => controller.fire(node, 'onClick'),
    settle: async (rounds = 8) => {
      for (let index = 0; index < rounds; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        run();
      }
    },
    unmount: () => {
      for (const instance of mountState.instances.values()) {
        for (const slot of instance.slots) {
          if (slot !== null && typeof slot === 'object' && typeof slot.cleanup === 'function') {
            slot.cleanup();
          }
        }
      }
      mountState.instances.clear();
      mountState.root = [];
      restoreHooks();
    },
  };

  installHooks();
  run();
  return controller;
}

/** Flatten nested child arrays; a renderer that returns arrays has no use for them. */
/** @param {any} node */
function flatten(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  return [node];
}
