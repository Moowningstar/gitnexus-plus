/**
 * A reactive core with no rendering side, shaped after Angular's signals.
 *
 * The tracker needs three things from a reactive system: a value that remembers whether it
 * actually changed, a derived value that is only recomputed when somebody asks, and a way
 * to tell "the world moved" from "the answer moved". Angular already names all three
 * (signal, computed, effect), and its equality rule is the part worth copying verbatim:
 * **a write that compares equal is not a change**, so nothing downstream runs.
 *
 * What is deliberately *not* copied:
 *
 * - There is no dependency graph discovery inside a computation. Our producers are
 *   asynchronous (`readDelta` hashes files, the risk query crosses a process boundary), and
 *   a tracker that starts tracking at the first `await` records an empty set — worse than no
 *   tracking, because it looks like it works. `derived()` therefore takes its sources
 *   explicitly, which is also what makes the dependency order reviewable.
 * - There is no zone, no scheduler tick and no owner. Effects run on a `queueMicrotask`
 *   after the outermost `batch()`, which is the smallest thing that coalesces a burst of file
 *   events into one evaluation.
 *
 * Every node exposes `version`, which only increases when the value changes by the node's own
 * `equals`. `peek()` never triggers work: it is what a route or a tool answer may read while
 * a background evaluation is still in flight.
 */

/** Equality used to decide whether a write is a change. `Object.is` tolerates NaN. */
export type Equals<T> = (a: T, b: T) => boolean;

/** Anything whose `version` advances when its value changes. */
export interface Versioned {
  readonly version: number;
}

export interface Signal<T> extends Versioned {
  /** Read and record a dependency when called inside an effect. */
  (): T;
  /** Read without recording a dependency. */
  peek(): T;
  set(value: T): void;
  update(change: (value: T) => T): void;
  /** Runs after a change, or at the end of the enclosing batch. */
  subscribe(listener: () => void): () => void;
}

export interface Derived<T> extends Versioned {
  /**
   * The value, computing it if a source moved since the last success.
   *
   * Concurrent callers share one computation. A failed computation is remembered for the
   * same source versions, so a broken helper is asked once per change rather than once per
   * reader; `invalidate()` clears that memory.
   */
  get(): Promise<T>;
  /** The last successful value, or `undefined` before the first one. */
  peek(): T | undefined;
  /** True while a computation is in flight. */
  readonly pending: boolean;
  /** Forget the cached value and any remembered failure. */
  invalidate(): void;
  /** Runs after the value changed, or after a failed computation. */
  subscribe(listener: () => void): () => void;
}

let activeEffect: EffectNode | null = null;
let batchDepth = 0;
const pendingEffects = new Set<EffectNode>();
let flushQueued = false;

interface EffectNode {
  readonly run: () => void;
  readonly deps: Set<Signal<unknown>>;
  disposed: boolean;
}

/**
 * Effects reading each signal, kept off the signal object itself.
 *
 * A `WeakMap` keyed by the signal lets `effect()`'s disposer unhook a node without the
 * signal carrying bookkeeping it does not care about.
 */
const readersBySignal = new WeakMap<object, Set<EffectNode>>();

function readersOf(signal: object): Set<EffectNode> {
  let set = readersBySignal.get(signal);
  if (set === undefined) {
    set = new Set();
    readersBySignal.set(signal, set);
  }
  return set;
}

function scheduleEffect(node: EffectNode): void {
  if (node.disposed) return;
  pendingEffects.add(node);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(flushEffects);
}

function flushEffects(): void {
  flushQueued = false;
  if (batchDepth > 0) return;
  // Copy first: an effect may schedule another one, and running from the live set would
  // evaluate it inside the same flush without a stable order.
  const ready = [...pendingEffects];
  pendingEffects.clear();
  for (const node of ready) {
    if (node.disposed) continue;
    node.run();
  }
}

/** Group writes so subscribers run once. Nesting is counted, not flagged. */
export function batch(run: () => void): void {
  batchDepth += 1;
  try {
    run();
  } finally {
    batchDepth -= 1;
    if (batchDepth === 0) flushEffects();
  }
}

/** Read `peek()` semantics for work that must not register a dependency. */
export function untracked<T>(read: () => T): T {
  const previous = activeEffect;
  activeEffect = null;
  try {
    return read();
  } finally {
    activeEffect = previous;
  }
}

/** Create a writable value. */
export function signal<T>(initial: T, equals: Equals<T> = Object.is): Signal<T> {
  let value = initial;
  let version = 0;
  const listeners = new Set<() => void>();

  const read = (() => {
    const node = activeEffect;
    if (node !== null) {
      node.deps.add(read as Signal<unknown>);
      readersOf(read).add(node);
    }
    return value;
  }) as Signal<T>;

  Object.defineProperty(read, 'version', { get: () => version });

  read.peek = () => value;
  read.set = (next: T) => {
    if (equals(value, next)) return;
    value = next;
    version += 1;
    for (const listener of [...listeners]) listener();
    // Inside a batch, effects are collected and flushed once at the end; outside one a
    // microtask is still the right boundary, because a burst of writes should collapse.
    for (const node of [...readersOf(read)]) {
      if (batchDepth > 0) pendingEffects.add(node);
      else scheduleEffect(node);
    }
  };
  read.update = (change: (current: T) => T) => {
    read.set(change(value));
  };
  read.subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return read;
}

/**
 * Create a value computed from other nodes, on demand.
 *
 * `sources` is read for its `version`s only. The computation runs when `get()` is called and
 * any source has advanced since the last success — never eagerly, because the expensive ones
 * (a hash pass over the working tree, a graph query in a child process) must not run for a
 * repository nobody is looking at.
 */
export function derived<T>(
  compute: () => Promise<T>,
  sources: readonly Versioned[],
  equals: Equals<T> = Object.is,
): Derived<T> {
  let value: T | undefined;
  let hasValue = false;
  let version = 0;
  let computedAt: string | null = null;
  let inFlight: Promise<T> | null = null;
  let failure: { at: string; error: unknown } | null = null;
  const listeners = new Set<() => void>();

  const signature = (): string => sources.map((source) => source.version).join(':');
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const node: Derived<T> = {
    get version() {
      return version;
    },
    get pending() {
      return inFlight !== null;
    },
    peek: () => value,
    invalidate() {
      computedAt = null;
      failure = null;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get(): Promise<T> {
      const now = signature();
      if (inFlight !== null) return inFlight;
      if (computedAt === now) {
        if (failure !== null) return Promise.reject(failure.error);
        if (hasValue) return Promise.resolve(value as T);
      }
      const started = now;
      const run = (async () => {
        try {
          const next = await compute();
          computedAt = started;
          failure = null;
          inFlight = null;
          if (!hasValue || !equals(value as T, next)) {
            value = next;
            hasValue = true;
            version += 1;
            notify();
          }
          return next;
        } catch (error) {
          computedAt = started;
          failure = { at: started, error };
          inFlight = null;
          notify();
          throw error;
        }
      })();
      inFlight = run;
      return run;
    },
  };
  return node;
}

/**
 * Run `run` now, then again whenever a signal it read changes.
 *
 * This is the one tracking consumer in the core, and it only sees synchronous reads. An
 * effect that awaits records nothing after the `await`, which is exactly why the tracker
 * keeps its asynchronous work in `derived()` nodes and uses effects only for cheap dispatch.
 */
export function effect(run: () => void): () => void {
  const node: EffectNode = { run: track, deps: new Set(), disposed: false };

  function track(): void {
    if (node.disposed) return;
    const previous = activeEffect;
    node.deps.clear();
    activeEffect = node;
    try {
      run();
    } finally {
      activeEffect = previous;
    }
  }

  track();
  return () => {
    node.disposed = true;
    pendingEffects.delete(node);
    for (const dep of node.deps) readersOf(dep).delete(node);
    node.deps.clear();
  };
}
