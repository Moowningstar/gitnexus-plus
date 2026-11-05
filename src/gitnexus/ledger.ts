/**
 * The session ledger: what changed in this dirty window, counted.
 *
 * WHY A WINDOW, AND WHERE ITS EDGES ARE
 * -------------------------------------
 * A dirty tree has no memory: `git status` at 18:05 says the same thing whether one file
 * changed once or five files changed ten times. The question an operator actually asks
 * after a long session — "what did this session change, and how much of it did I write
 * twice?" — is not recoverable from the final diff. So the ledger records observations
 * while the tree is dirty: a window opens the first time the comparison is non-empty,
 * accumulates one entry per path, and closes when the tree is clean again, when HEAD
 * moves, or when the tracker stops watching.
 *
 * WHAT IT REFUSES TO CLAIM
 * ------------------------
 * - **Not evidence of content.** `TrackerRecentChange` says "an editor wrote this path";
 *   only a hash from `readDelta` says the bytes differ from the index. Entries therefore
 *   carry `evidence: 'hash' | 'pending'`, and `pending` is what a window shows when a
 *   save was noticed but not yet compared.
 * - **No diffs, no lines, no contents.** A ledger that stored patches would be a second
 *   index, with all of the index's staleness problems and none of its uses.
 * - **No per-agent attribution.** `ToolExecContext` carries a signal, not an identity;
 *   attributing an edit to the tool that wrote it would be a guess dressed as a fact.
 * - **No baseline via `git stash create`.** 0.1.10's candidate B proposed one; the ledger
 *   needs paths, counts and times, and the index's own hashes already provide the
 *   baseline. Stash would also write `.git` from a `GET` route, which invariant ① forbids.
 *
 * Everything above is pure: `tickLedger` takes the previous state, one delta report and
 * a clock, and returns the next state. The tracker owns the state; this module owns the
 * rules.
 */

import type { DeltaEntry, DeltaReport } from './delta.js';

/** Why the window closed. `head` means the work landed; the other two mean it stopped. */
export type LedgerCloseReason = 'clean' | 'head' | 'idle';

export type LedgerKind = 'modified' | 'added' | 'deleted';

export interface LedgerFile {
  /** repo-relative, forward slashes */
  path: string;
  /** the latest observation's kind; a file can go modified → deleted within a window */
  kind: LedgerKind;
  firstSeenAt: string;
  lastSeenAt: string;
  /** observations where the content hash changed; a same-content save does not count */
  changes: number;
  /** whether the manifest records this path at all — `false` is the unindexed bucket */
  inIndex: boolean;
}

export interface SessionLedger {
  repoPath: string;
  /** `<openedAt epoch>-<n>`; unique within one tracker, not globally */
  windowId: string;
  openedAt: string;
  closedAt: string | null;
  closeReason: LedgerCloseReason | null;
  /** at most {@link LEDGER_MAX_FILES}, newest first */
  files: LedgerFile[];
  counts: { modified: number; added: number; deleted: number; unindexed: number };
  /** entries the index policy skipped; they never enter `files` */
  excluded: number;
  truncated: boolean;
  /** `hash` when every entry was compared; `pending` when a save is not yet verified */
  evidence: 'hash' | 'pending';
}

/** Enough to describe a session; a larger window is summarised, not extended. */
export const LEDGER_MAX_FILES = 200;

/** The mutable half: what the tracker holds between observations. */
export interface LedgerState {
  repoPath: string;
  windowId: string;
  openedAt: string;
  /** the commit this window started under; a change closes the window */
  headCommit: string | null;
  indexedPaths: ReadonlySet<string>;
  closedAt: string | null;
  closeReason: LedgerCloseReason | null;
  excluded: number;
  truncated: boolean;
  entries: Map<string, LedgerFile>;
  /** the hash each path had at its last observation; absent means never observed */
  hashes: Map<string, string | null>;
  /**
   * Files the cap dropped, counted by kind.
   *
   * Kept separately so `truncated` stays honest: the row list is capped, the counts are
   * not. Recomputing them from `entries` would turn a 400-file window into "200 changed".
   */
  dropped: { modified: number; added: number; deleted: number; unindexed: number };
  /**
   * Paths whose latest observation was not compared by content.
   *
   * Separate from `hashes`, which keeps the last *known* hash: a write with no hash tells
   * us nothing about the bytes, and the old proof must not be presented as if it covered
   * this observation. Presence here is what makes `evidence` say `pending`.
   */
  uncompared: Set<string>;
}

function iso(at: Date): string {
  return at.toISOString();
}

/** A new window with no entries. */
export function openLedger(
  repoPath: string,
  windowId: string,
  at: Date,
  indexedPaths: ReadonlySet<string>,
  headCommit: string | null,
): LedgerState {
  return {
    repoPath,
    windowId,
    openedAt: iso(at),
    headCommit,
    indexedPaths,
    closedAt: null,
    closeReason: null,
    excluded: 0,
    truncated: false,
    entries: new Map(),
    hashes: new Map(),
    dropped: { modified: 0, added: 0, deleted: 0, unindexed: 0 },
    uncompared: new Set(),
  };
}

/** Freeze the window. Idempotent: closing an already-closed window changes nothing. */
export function closeLedger(state: LedgerState, reason: LedgerCloseReason, at: Date): LedgerState {
  if (state.closedAt === null) {
    state.closedAt = iso(at);
    state.closeReason = reason;
  }
  return state;
}

/**
 * Apply one observation of a path.
 *
 * The first sighting counts as one change: the file differs from the index, which is the
 * claim the window exists to make. After that only a different hash counts — saving the
 * same bytes ten times is one change, which is the number a person would recognise.
 */
function observeEntry(state: LedgerState, entry: DeltaEntry, at: string): void {
  const existing = state.entries.get(entry.path);
  const nextHash = entry.hash ?? null;
  if (existing === undefined) {
    state.entries.set(entry.path, {
      path: entry.path,
      kind: entry.kind === 'excluded' ? 'modified' : entry.kind,
      firstSeenAt: at,
      lastSeenAt: at,
      changes: 1,
      inIndex: state.indexedPaths.has(entry.path),
    });
    state.hashes.set(entry.path, nextHash);
    if (nextHash === null) state.uncompared.add(entry.path);
    return;
  }
  existing.kind = entry.kind === 'excluded' ? existing.kind : entry.kind;
  existing.lastSeenAt = at;
  const previousHash = state.hashes.get(entry.path) ?? null;
  if (nextHash !== null && nextHash !== previousHash) existing.changes += 1;
  // A null hash means "not compared this time", not "no content": keep the last proof,
  // and remember that this observation is one the proof does not cover.
  if (nextHash === null) state.uncompared.add(entry.path);
  else state.uncompared.delete(entry.path);
  state.hashes.set(entry.path, nextHash ?? previousHash);
}

/** Drop the oldest entries once the cap is reached. The count stays truthful. */
function enforceCap(state: LedgerState): void {
  if (state.entries.size <= LEDGER_MAX_FILES) return;
  const ordered = [...state.entries.values()].sort((a, b) =>
    a.lastSeenAt === b.lastSeenAt ? a.path.localeCompare(b.path) : a.lastSeenAt < b.lastSeenAt ? 1 : -1,
  );
  for (const dropped of ordered.slice(LEDGER_MAX_FILES)) {
    state.entries.delete(dropped.path);
    state.uncompared.delete(dropped.path);
    state.dropped[dropped.kind] += 1;
    if (!dropped.inIndex) state.dropped.unindexed += 1;
  }
  state.truncated = true;
}

function applyReport(state: LedgerState, report: DeltaReport, at: Date): LedgerState {
  const stamp = iso(at);
  let excluded = 0;
  for (const entry of report.entries) {
    if (entry.kind === 'excluded') {
      excluded += 1;
      continue;
    }
    observeEntry(state, entry, stamp);
  }
  state.excluded = excluded;
  enforceCap(state);
  return state;
}

export interface LedgerTick {
  /** null when nothing is open and the report had nothing actionable */
  state: LedgerState | null;
  /** true when this tick opened a window */
  opened: boolean;
}

export interface LedgerTickOptions {
  /** the manifest's `fileHashes` keys: the answer to "was this file indexed?" */
  indexedPaths: ReadonlySet<string>;
  /** a new window id; called only when a window is opened */
  windowId: () => string;
}

/**
 * Advance the window by one delta report.
 *
 * The three transitions are the plan's: a moved HEAD closes the window (`head`), an
 * empty comparison closes it (`clean`), and the next change opens a fresh one. `idle`
 * is not derivable from a report — the tracker calls {@link closeLedger} for that.
 */
export function tickLedger(
  previous: LedgerState | null,
  report: DeltaReport,
  at: Date,
  options: LedgerTickOptions,
): LedgerTick {
  const actionable = report.counts.modified + report.counts.added + report.counts.deleted;

  let current = previous;
  if (current !== null && current.closedAt === null) {
    const headMoved =
      report.headCommit !== null && current.headCommit !== null && report.headCommit !== current.headCommit;
    if (headMoved) {
      closeLedger(current, 'head', at);
      if (actionable === 0) return { state: current, opened: false };
      current = null;
    } else if (actionable === 0 && report.comparable) {
      closeLedger(current, 'clean', at);
      return { state: current, opened: false };
    }
  }

  if (current === null || current.closedAt !== null) {
    if (actionable === 0) return { state: previous, opened: false };
    current = null;
  }

  if (current === null) {
    const opened = openLedger(
      report.repoPath,
      options.windowId(),
      at,
      options.indexedPaths,
      report.headCommit,
    );
    return { state: applyReport(opened, report, at), opened: true };
  }
  return { state: applyReport(current, report, at), opened: false };
}

/** Project the mutable state to the JSON the route returns. */
export function materialize(state: LedgerState): SessionLedger {
  const files = [...state.entries.values()].sort((a, b) =>
    a.lastSeenAt === b.lastSeenAt ? a.path.localeCompare(b.path) : a.lastSeenAt < b.lastSeenAt ? 1 : -1,
  );
  const counts = { ...state.dropped };
  for (const file of files) {
    counts[file.kind] += 1;
    if (!file.inIndex) counts.unindexed += 1;
  }
  let evidence: 'hash' | 'pending' = 'hash';
  for (const file of files) {
    if (state.uncompared.has(file.path)) {
      evidence = 'pending';
      break;
    }
  }
  return {
    repoPath: state.repoPath,
    windowId: state.windowId,
    openedAt: state.openedAt,
    closedAt: state.closedAt,
    closeReason: state.closeReason,
    files,
    counts,
    excluded: state.excluded,
    truncated: state.truncated,
    evidence,
  };
}
