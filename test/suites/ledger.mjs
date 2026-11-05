/**
 * The session ledger: what one dirty window saw.
 *
 * No git and no tracker: `tickLedger` takes a delta report — the same object the gate
 * already produces — so each transition is a pure function of two literals. That is
 * deliberate. The window rules are the contract, and a contract that only runs on a
 * machine with a dirty tree is not tested by CI.
 */

import { check, section } from '../harness.mjs';

/** A report in the shape the engine emits, with only the fields this module reads. */
function report(patch = {}) {
  return {
    repoPath: 'D:/fixtures/ledger',
    indexed: true,
    comparable: true,
    basis: 'index',
    indexedCommit: 'aaaaaaaaaaaaaaaa',
    headCommit: 'aaaaaaaaaaaaaaaa',
    entries: [],
    counts: countsOf(),
    needsRefresh: false,
    certain: true,
    truncated: false,
    notes: [],
    ...patch,
  };
}

/** An entry the way `readDelta` builds one. */
function entry(path, kind = 'modified', hash = 'h1') {
  return { path, kind, reason: null, hash };
}

function options(indexed = ['src/a.ts'], windowId = () => 'w1') {
  return { indexedPaths: new Set(indexed), windowId };
}

/** The engine's counts shape, with only the kinds the ledger reads. */
function countsOf(modified = 0, added = 0, deleted = 0, excluded = 0) {
  return { checked: modified + added + deleted, hashed: 0, unchanged: 0, modified, added, deleted, excluded };
}

const at = (iso) => new Date(iso);
const T0 = at('2026-11-04T10:00:00.000Z');

export async function ledgerTests() {
  section('ledger: the dirty window, its transitions and its evidence');
  const { tickLedger, closeLedger, materialize, LEDGER_MAX_FILES } = await import('../../lib/gitnexus/ledger.js');

  /** The wire shape of a tick, which is what a caller and a test both read. */
  const view = (tick) => (tick.state === null ? null : materialize(tick.state));

  // --- opening ------------------------------------------------------------------
  {
    const clean = tickLedger(null, report(), T0, options());
    check('a clean tree opens no window', clean.state === null && clean.opened === false, JSON.stringify(clean));

    const first = tickLedger(null, report({ entries: [entry('src/a.ts')], counts: countsOf(1) }), T0, options());
    check('the first change opens a window', first.opened === true && view(first)?.openedAt === T0.toISOString());
    check(
      'the file is counted once and marked indexed',
      view(first)?.files[0].changes === 1 && view(first)?.files[0].inIndex === true,
      JSON.stringify(view(first)?.files),
    );
    check('a hashed comparison is evidence, not a hint', view(first)?.evidence === 'hash');
  }

  // --- the counter is about content, not writes ---------------------------------
  {
    const one = tickLedger(null, report({ entries: [entry('src/a.ts', 'modified', 'h1')], counts: countsOf(1) }), T0, options());
    const same = tickLedger(
      one.state,
      report({ entries: [entry('src/a.ts', 'modified', 'h1')], counts: countsOf(1) }),
      at('2026-11-04T10:00:05.000Z'),
      options(),
    );
    check('saving without changing a byte does not count again', view(same)?.files[0].changes === 1, JSON.stringify(view(same)?.files));
    check(
      'but the last-seen time moves',
      view(same)?.files[0].lastSeenAt === '2026-11-04T10:00:05.000Z',
      JSON.stringify(view(same)?.files),
    );

    const edited = tickLedger(
      same.state,
      report({ entries: [entry('src/a.ts', 'modified', 'h2')], counts: countsOf(1) }),
      at('2026-11-04T10:00:10.000Z'),
      options(),
    );
    check('a second real edit counts twice', view(edited)?.files[0].changes === 2);
    check('the window is still open', view(edited)?.closedAt === null && edited.opened === false);
  }

  // --- a hash nobody computed is "not checked", never "unchanged" ----------------
  {
    const one = tickLedger(null, report({ entries: [entry('src/a.ts', 'modified', 'h1')], counts: countsOf(1) }), T0, options());
    const pending = tickLedger(
      one.state,
      report({ entries: [entry('src/a.ts', 'modified', null)], counts: countsOf(1) }),
      at('2026-11-04T10:00:05.000Z'),
      options(),
    );
    check('an unhashed observation keeps the count', view(pending)?.files[0].changes === 1, JSON.stringify(view(pending)?.files));
    check('and drops the window to pending', view(pending)?.evidence === 'pending');
  }

  // --- added, then deleted ------------------------------------------------------
  {
    const one = tickLedger(
      null,
      report({ entries: [entry('src/new.ts', 'added', 'n1')], counts: countsOf(0, 1) }),
      T0,
      options(['src/a.ts']),
    );
    check('a new file is not in the index', view(one)?.files[0].inIndex === false);
    check('and it is counted as unindexed', view(one)?.counts.unindexed === 1, JSON.stringify(view(one)?.counts));

    const gone = tickLedger(
      one.state,
      report({ entries: [entry('src/new.ts', 'deleted', null)], counts: countsOf(0, 0, 1) }),
      at('2026-11-04T10:00:05.000Z'),
      options(['src/a.ts']),
    );
    check('deleting it moves the kind, it does not add a row', view(gone)?.files.length === 1, JSON.stringify(view(gone)?.files));
    check('the kind follows', view(gone)?.files[0].kind === 'deleted');
  }

  // --- closing: a commit --------------------------------------------------------
  {
    const one = tickLedger(null, report({ entries: [entry('src/a.ts')], counts: countsOf(1) }), T0, options());
    const moved = tickLedger(
      one.state,
      report({
        headCommit: 'bbbbbbbbbbbbbbbb',
        indexedCommit: 'bbbbbbbbbbbbbbbb',
        entries: [entry('src/b.ts')],
        counts: countsOf(1),
      }),
      at('2026-11-04T10:05:00.000Z'),
      options(['src/a.ts', 'src/b.ts'], () => 'w2'),
    );
    check('a moved HEAD opens a new window', moved.opened === true && view(moved)?.windowId === 'w2');
    check('the new window starts from what is still dirty', view(moved)?.files.length === 1 && view(moved)?.files[0].path === 'src/b.ts');
  }

  {
    const one = tickLedger(null, report({ entries: [entry('src/a.ts')], counts: countsOf(1) }), T0, options());
    const committed = tickLedger(
      one.state,
      report({ headCommit: 'bbbbbbbbbbbbbbbb', indexedCommit: 'bbbbbbbbbbbbbbbb' }),
      at('2026-11-04T10:05:00.000Z'),
      options(),
    );
    check(
      'a commit with a clean tree closes the window as `head`',
      view(committed)?.closeReason === 'head' && view(committed)?.closedAt === '2026-11-04T10:05:00.000Z',
      JSON.stringify({ reason: view(committed)?.closeReason, at: view(committed)?.closedAt }),
    );
    check('and does not open a new one', committed.opened === false);
  }

  // --- closing: the tree went clean ---------------------------------------------
  {
    const one = tickLedger(null, report({ entries: [entry('src/a.ts')], counts: countsOf(1) }), T0, options());
    const clean = tickLedger(one.state, report(), at('2026-11-04T10:06:00.000Z'), options());
    check('a clean tree closes the window as `clean`', view(clean)?.closeReason === 'clean', JSON.stringify(view(clean)?.closeReason));
    const stillClean = tickLedger(clean.state, report(), at('2026-11-04T10:07:00.000Z'), options());
    check('the frozen window is kept, not dropped', view(stillClean)?.closedAt !== null && stillClean.opened === false);
  }

  // --- closing: the tracker stopped ---------------------------------------------
  {
    const one = tickLedger(null, report({ entries: [entry('src/a.ts')], counts: countsOf(1) }), T0, options());
    const once = closeLedger(one.state, 'idle', at('2026-11-04T11:00:00.000Z'));
    check('a stopped tracker closes the window as `idle`', once.closeReason === 'idle' && once.closedAt === '2026-11-04T11:00:00.000Z');
    const twice = closeLedger(once, 'clean', at('2026-11-04T11:30:00.000Z'));
    check(
      'closing is idempotent: the first reason and time win',
      twice.closeReason === 'idle' && twice.closedAt === '2026-11-04T11:00:00.000Z',
      JSON.stringify({ reason: twice.closeReason, at: twice.closedAt }),
    );
    check('an idle window keeps its last time, not the close time', materialize(once).files[0].lastSeenAt === T0.toISOString());
  }

  // --- the cap and the counts ---------------------------------------------------
  {
    const files = Array.from({ length: LEDGER_MAX_FILES + 5 }, (_, index) => entry(`src/f${index}.ts`));
    const big = tickLedger(null, report({ entries: files, counts: countsOf(files.length) }), T0, options(files.map((item) => item.path)));
    check(
      `the window keeps at most ${LEDGER_MAX_FILES} files`,
      view(big)?.files.length === LEDGER_MAX_FILES,
      String(view(big)?.files.length),
    );
    check('and says so', view(big)?.truncated === true);
    check(
      'the counts stay complete, not capped',
      view(big)?.counts.modified === files.length,
      JSON.stringify(view(big)?.counts),
    );
  }

  // --- excluded files are a number, not a row -----------------------------------
  {
    const excluded = [
      { path: 'assets/logo.bin', kind: 'excluded', reason: '索引不收录该文件类型', hash: null },
      { path: 'assets/icon.bin', kind: 'excluded', reason: '索引不收录该文件类型', hash: null },
    ];
    const one = tickLedger(
      null,
      report({ entries: [entry('src/a.ts'), ...excluded], counts: countsOf(1, 0, 0, excluded.length) }),
      T0,
      options(),
    );
    check('excluded files are counted, not listed', view(one)?.excluded === 2, JSON.stringify(view(one)?.excluded));
    check('and they do not open rows', view(one)?.files.length === 1, String(view(one)?.files.length));
  }

  // --- ordering -----------------------------------------------------------------
  {
    const one = tickLedger(
      null,
      report({ entries: [entry('src/a.ts', 'modified', 'a1'), entry('src/b.ts', 'modified', 'b1')], counts: countsOf(2) }),
      T0,
      options(['src/a.ts', 'src/b.ts']),
    );
    const later = tickLedger(
      one.state,
      report({ entries: [entry('src/a.ts', 'modified', 'a2')], counts: countsOf(1) }),
      at('2026-11-04T10:01:00.000Z'),
      options(['src/a.ts', 'src/b.ts']),
    );
    check('the most recent file is first', view(later)?.files[0].path === 'src/a.ts', JSON.stringify(view(later)?.files));
  }
}
