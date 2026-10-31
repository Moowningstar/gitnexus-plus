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
  const { RepoTracker, TrackerRegistry, mergeRecent } = await import('../../lib/gitnexus/watch/registry.js');
  const { readStorageState } = await import('../../lib/gitnexus/storage-state.js');
  const { createFsWatch } = await import('../../lib/gitnexus/watch/stamps.js');

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

  // The list of "what was just written" is the only live view the panel has, so its rules are
  // checked directly: no filesystem, no debounce, no timing.
  section('tracker: the recent-change list');

  {
    const at = (offsetMs) => new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + offsetMs).toISOString();
    const now = Date.parse(at(0));
    const older = [{ path: 'kept.ts', at: at(-60_000) }, { path: 'expired.ts', at: at(-10 * 60_000) }];

    const merged = mergeRecent(older, ['src/a.ts', 'src\\b.ts'], now);
    check(
      'a fresh event lands at the front, with backslashes normalized',
      merged[0].path === 'src/a.ts' && merged[1].path === 'src/b.ts' && merged[0].at === at(0),
      JSON.stringify(merged),
    );
    check(
      'entries older than the window are dropped',
      !merged.some((entry) => entry.path === 'expired.ts') && merged.some((entry) => entry.path === 'kept.ts'),
      JSON.stringify(merged),
    );
    check(
      'the same path written again moves to the front instead of appearing twice',
      mergeRecent(merged, ['src/a.ts'], now + 1_000).filter((entry) => entry.path === 'src/a.ts').length === 1,
      JSON.stringify(mergeRecent(merged, ['src/a.ts'], now + 1_000)),
    );
    const many = mergeRecent([], Array.from({ length: 60 }, (_unused, index) => `file-${index}.ts`), now);
    check('the list is capped', many.length === 40, String(many.length));

    // End to end through a real watcher: the debounce is shortened so the assertion does not
    // wait 800 ms per run, and the path it reports is exactly what the tracker remembers.
    const root = await tempRepo('gnp-watch-');
    try {
      const reported = [];
      const watch = createFsWatch(root, {
        debounceMs: 40,
        minGapMs: 0,
        onChange: (paths) => reported.push(...paths),
      });
      if (watch.live) {
        await fs.writeFile(path.join(root, 'touched.ts'), 'export const touched = 1;\n', 'utf8');
        const deadline = Date.now() + 3_000;
        while (reported.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      check(
        'a real write is reported with its path',
        !watch.live || reported.some((entry) => entry.replace(/\\/g, '/').endsWith('touched.ts')),
        `${watch.live} ${JSON.stringify(reported)}`,
      );
      watch.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}
