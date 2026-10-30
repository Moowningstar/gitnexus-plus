/**
 * The reactive core, tested as a core: no tracker, no files, no timers.
 *
 * Every rule here is one the tracker relies on to stay quiet — a write that compares equal
 * must not run an effect, a derived value must not compute before it is read, a failure must
 * be remembered for the versions it failed at. Those are exactly the properties that are
 * invisible on a happy path and expensive to discover in a running panel.
 */

import { check, section } from '../harness.mjs';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function signalsTests() {
  section('signals: a write that compares equal is not a change');
  const { signal, batch, untracked, effect, derived } = await import('../../lib/gitnexus/watch/signals.js');

  const count = signal(0);
  let reads = 0;
  const stop = effect(() => {
    count();
    reads += 1;
  });

  check('an effect runs once at creation', reads === 1);
  count.set(0);
  await flush();
  check('writing the same value does not re-run it', reads === 1);
  check('and the version did not move', count.version === 0);

  count.set(1);
  await flush();
  check('writing a new value does', reads === 2);
  check('the version moved', count.version === 1);

  check('peek does not record a dependency', untracked(() => count.peek()) === 1);
  count.set(2);
  await flush();
  check('an untracked read never subscribed', reads === 3);

  batch(() => {
    count.set(3);
    count.set(4);
  });
  await flush();
  check('two writes inside one batch collapse into one run', reads === 4);
  check('but both writes were applied', count.peek() === 4);

  stop();
  count.set(5);
  await flush();
  check('a disposed effect stops seeing changes', reads === 4);

  section('signals: a derived value computes on read, once');
  const source = signal(1);
  let computations = 0;
  const double = derived(async () => {
    computations += 1;
    return source.peek() * 2;
  }, [source]);

  check('nothing computed before the first read', computations === 0);
  check('the first read computes', (await double.get()) === 2 && computations === 1);
  check('a second read is cached', (await double.get()) === 2 && computations === 1);

  source.set(2);
  check('a moved source makes it stale without computing', computations === 1);
  check('the next read recomputes', (await double.get()) === 4 && computations === 2);
  check('the version advanced on the value change', double.version === 2);

  const same = derived(async () => 'constant', [source]);
  await same.get();
  const before = same.version;
  source.set(3);
  await same.get();
  check('an equal value does not advance the version', same.version === before);

  const failing = derived(async () => {
    throw new Error('boom');
  }, [source]);
  let first = 'none';
  try {
    await failing.get();
  } catch (error) {
    first = error instanceof Error ? error.message : String(error);
  }
  check('a failure reaches the caller', first === 'boom');
  let second = 'none';
  try {
    await failing.get();
  } catch (error) {
    second = error instanceof Error ? error.message : String(error);
  }
  check('the failure is remembered for the same versions', second === 'boom');
  failing.invalidate();
  check('invalidate makes it try again', failing.peek() === undefined);

  let concurrent = 0;
  const slow = derived(async () => {
    concurrent += 1;
    await flush();
    return 'x';
  }, [source]);
  await Promise.all([slow.get(), slow.get(), slow.get()]);
  check('concurrent readers share one computation', concurrent === 1);

  let notified = 0;
  const watched = signal(0);
  const stopWatching = watched.subscribe(() => {
    notified += 1;
  });
  watched.set(1);
  check('a subscriber hears a change', notified === 1);
  watched.set(1);
  check('a subscriber does not hear an equal write', notified === 1);
  stopWatching();
  watched.set(2);
  check('an unsubscribed listener is gone', notified === 1);
}
