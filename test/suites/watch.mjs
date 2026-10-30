/**
 * The resident tracker: what it watches, when it re-evaluates, and what it refuses.
 *
 * This is the half of F4 that has no network and no graph: a temp repository, a fake
 * `.gitnexus`, and assertions about the snapshot the panel and the tools read. The risk
 * query itself is covered by `risk-query.mjs` (real index) and `risk-format.mjs` (wording);
 * what matters here is that the tracker never claims more than it checked.
 *
 * Timing: `ensureStarted()` kicks an evaluation in the background, so every assertion calls
 * `await tracker.settle()` first. That is the same single-flight path a real fs event takes;
 * the only thing not exercised is the debounce delay, which would make the suite slow and
 * flaky for no extra coverage.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { check, section } from '../harness.mjs';

async function tempRepo(prefix = 'gnp-tracker-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A store GitNexus would call owned: a manifest naming this repository. */
async function makeOwned(root) {
  const storage = path.join(root, '.gitnexus');
  await fs.mkdir(path.join(storage, 'lbug'), { recursive: true });
  await fs.writeFile(
    path.join(storage, 'gitnexus.json'),
    JSON.stringify({ repoPath: root, storagePath: storage, indexedAt: new Date().toISOString(), lastCommit: null }),
    'utf8',
  );
  return storage;
}

export async function watchTests() {
  const { RepoTracker, TrackerRegistry } = await import('../../lib/gitnexus/watch/registry.js');
  const { readStorageState } = await import('../../lib/gitnexus/storage-state.js');

  section('tracker: a store it cannot use is not watched');

  {
    const root = await tempRepo();
    try {
      const tracker = new RepoTracker({
        repoPath: root,
        runner: null,
        helperPath: path.join(root, 'no-helper.js'),
      });
      tracker.ensureStarted();
      const snapshot = tracker.snapshot();
      check('an unindexed directory starts no watcher', snapshot.watching === false, JSON.stringify(snapshot));
      check('and says nothing rather than saying "no risk"', tracker.line() === null, String(tracker.line()));
      tracker.dispose();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  section('tracker: an owned store is watched, and the change set is re-read');

  {
    const root = await tempRepo();
    try {
      await makeOwned(root);
      await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');
      const tracker = new RepoTracker({
        repoPath: root,
        runner: null,
        helperPath: path.join(root, 'no-helper.js'),
        now: () => 1_000,
      });
      tracker.ensureStarted();
      await tracker.settle();
      const snapshot = tracker.snapshot();
      check('an owned store is watched', snapshot.watching === true, JSON.stringify(snapshot));
      check(
        'the change set is read even without git (uncomparable, not silent)',
        snapshot.delta !== null && snapshot.delta.comparable === false,
        JSON.stringify(snapshot.delta && { comparable: snapshot.delta.comparable, notes: snapshot.delta.notes }),
      );
      check(
        'without a runner the verdict is "cannot evaluate", not "clear"',
        snapshot.risk !== null && snapshot.risk.evaluated === false,
        JSON.stringify(snapshot.risk),
      );
      check(
        'the line names the reason, and never says "no risk"',
        // The fixture has no git repository, so the change set is incomplete before the
        // runner is ever consulted; the point is that the sentence explains why instead of
        // claiming a clean result.
        tracker.line()?.includes('无法评估') === true &&
          tracker.line()?.includes('改动集不完整') === true &&
          tracker.line()?.includes('没有风险') === false,
        String(tracker.line()),
      );
      tracker.dispose();
      check('a disposed tracker is no longer watching', tracker.snapshot().watching === false, 'still watching');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  section('tracker: the registry caps how many can be attached');

  {
    const registry = new TrackerRegistry({ runner: null, helperPath: 'no-helper.js' });
    const roots = [];
    try {
      for (let i = 0; i < 4; i += 1) {
        const root = await tempRepo(`gnp-tracker-lru-${i}-`);
        roots.push(root);
        await makeOwned(root);
      }
      for (const root of roots) {
        registry.get(root, { runner: null, helperPath: 'no-helper.js' }).ensureStarted();
      }
      const listed = registry.list();
      check('four repositories asked, three attached', listed.length === 3, JSON.stringify(listed.map((t) => t.repoPath)));
      check(
        'the least recently used one was dropped',
        listed.every((tracker) => tracker.repoPath !== roots[0]),
        JSON.stringify(listed.map((t) => path.basename(t.repoPath))),
      );
      // Asking about a dropped repository again must produce a working tracker, not a
      // disposed one: the LRU list is about resources, not about refusing service.
      const again = registry.get(roots[0], { runner: null, helperPath: 'no-helper.js' });
      again.ensureStarted();
      check('a dropped repository is attached again on the next question', again.snapshot().watching === true, 'not watching');
      check('the registry is capped again after the re-add', registry.list().length === 3, String(registry.list().length));
    } finally {
      registry.dispose();
      for (const root of roots) {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  }

  section('tracker: storage is re-read, not cached across a rebuild');

  {
    const root = await tempRepo();
    try {
      await makeOwned(root);
      const tracker = new RepoTracker({
        repoPath: root,
        runner: null,
        helperPath: path.join(root, 'no-helper.js'),
      });
      tracker.ensureStarted();
      await tracker.settle();
      check('starts healthy', readStorageState(root).state === 'owned', readStorageState(root).state);
      // A rebuild replaces the manifest; the tracker's next evaluation must see the new
      // store rather than treating the first verdict as permanent.
      await fs.writeFile(path.join(root, '.gitnexus', 'gitnexus.json'), '{ not json', 'utf8');
      await tracker.settle();
      check(
        'a store that stops being readable reads as blocked on the next pass',
        readStorageState(root).usable === false,
        readStorageState(root).state,
      );
      tracker.dispose();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}
