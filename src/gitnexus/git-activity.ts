/**
 * Git activity, correlated with the index.
 *
 * WHAT THIS ADDS THAT PLAIN `git log` DOES NOT
 * -------------------------------------------
 * GitNexus is built on git, and its manifest records a content hash for every file
 * it indexed. Crossing recent git activity with that set answers a question neither
 * tool answers alone:
 *
 *     of the files people are actively changing right now,
 *     how many does the knowledge graph even see?
 *
 * A file that is edited weekly but absent from the index contributes nothing to
 * `impact`, `context` or `query` — and nothing in GitNexus's own UI says so. That
 * is the `indexed` flag on every row here.
 *
 * BOUNDS ARE PART OF THE CONTRACT
 * -------------------------------
 * `git log --numstat` on a large repository is unbounded work, so every dimension
 * is capped and the result says when a cap was hit (`window.truncated`). A silently
 * truncated activity list reads as "this is all the activity there was", which is
 * the one thing it must not mean.
 */

import type { CommitDiff, FileHistory, FileHistoryCommit } from 'dsh-gitnexus-wire';
import { captureGit } from './git-capture.js';
import { normalizePathKey } from './index-meta.js';
import {
  LOG_FIELD_SEPARATOR,
  LOG_RECORD_SEPARATOR,
  parseLogWindow,
  parseNumstatLines,
} from './git-log.js';
import type { FileTally } from './git-log.js';

/** Generous but finite: the log is informational, and it must not outlast the scan. */
const TIMEOUT_MS = 20_000;

/** Record separator (RS) opens each commit; unit separator (US) separates its fields. */
const RS = LOG_RECORD_SEPARATOR;
const US = LOG_FIELD_SEPARATOR;

const DEFAULTS = Object.freeze({
  sinceDays: 90,
  maxCommits: 300,
  maxFiles: 200,
  maxAuthors: 20,
  maxBranches: 20,
});

async function git(repoPath: string, args: string[], maxBuffer = 32 * 1024 * 1024): Promise<string | null> {
  // A confined host denies the pipe `execFile` needs, so the log is read through the
  // file-descriptor capture; without it this whole panel is empty in the host it ships for.
  const result = await captureGit(repoPath, args, { timeoutMs: TIMEOUT_MS, maxBytes: maxBuffer });
  // The size cap is a hard failure on purpose: a partial parse would understate activity.
  return result.ok ? result.text : null;
}

/**
 *   indexed  — the manifest holds this path, so the graph can answer about it.
 *   excluded — a fresh scan would not select it either (dotfile, ignore rule, or
 *              over the size cap). Absent by design; not a staleness signal.
 *   missing  — a fresh scan *would* select it, but the index does not hold it.
 *              This is the only verdict that means the index is behind.
 */
export type FileVerdict = 'indexed' | 'excluded' | 'missing';

export interface ActivityFile {
  path: string;
  /** commits touching this file */
  changes: number;
  insertions: number;
  deletions: number;
  /** ISO date of the most recent change */
  lastChange: string;
  indexed: boolean;
  verdict: FileVerdict;
}

export interface ActivityAuthor {
  name: string;
  email: string;
  commits: number;
  insertions: number;
  deletions: number;
  /** distinct files touched */
  files: number;
  lastCommit: string;
  /** machine account, judged from the conventional markers */
  bot: boolean;
}

export interface ActivityBranch {
  name: string;
  lastCommitDate: string;
  lastAuthor: string;
  current: boolean;
}

/** One commit in the activity window, with the index verdict of its touched files. */
export interface ActivityCommit {
  sha: string;
  shortSha: string;
  date: string;
  author: string;
  subject: string;
  files: number;
  insertions: number;
  deletions: number;
  verdict: FileVerdict;
}

/** One row of the activity × index cross-tab. */
export interface ActivityCrossRow {
  verdict: FileVerdict;
  files: number;
  changes: number;
  insertions: number;
  deletions: number;
}

export interface ActivityCross {
  rows: ActivityCrossRow[];
  totalFiles: number;
  totalChanges: number;
}

/** What changed since the commit the index was built from. */
export interface ActivityBaseline {
  ref: string | null;
  /** `window` is the explicit fallback when the index recorded no commit. */
  source: 'index' | 'window';
  available: boolean;
  shortSha: string | null;
  date: string | null;
  subject: string | null;
  author: string | null;
  commits: number;
  files: number;
  insertions: number;
  deletions: number;
  changedFiles: ActivityFile[];
  reason: string | null;
}

export interface HistogramBucket {
  label: string;
  commits: number;
  insertions: number;
  deletions: number;
}

export interface ActivityHistogram {
  bucketDays: number;
  buckets: HistogramBucket[];
}

/** One commit-stamp feeding the histogram. */
export interface ActivityStamp {
  date: string;
  insertions: number;
  deletions: number;
}

export interface ActivityWindow {
  sinceDays: number;
  since: string;
  maxCommits: number;
  maxFiles: number;
  truncated: boolean;
  oldestCommit: string | null;
  newestCommit: string | null;
}

export interface ActivityTotals {
  commits: number;
  authors: number;
  bots: number;
  files: number;
  insertions: number;
  deletions: number;
  verdicts: Record<FileVerdict, number>;
  indexKnown: boolean;
  filesTouchedThatAreIndexed: number;
  filesTouchedThatAreNotIndexed: number;
}

export interface ActivityInfo {
  window: ActivityWindow;
  totals: ActivityTotals;
  authors: ActivityAuthor[];
  byChanges: ActivityFile[];
  byRecency: ActivityFile[];
  missingFiles: ActivityFile[];
  branches: ActivityBranch[];
  histogram: ActivityHistogram;
  currentBranch: string | null;
  /** Activity × index cross-tab over every file in the window. */
  cross: ActivityCross;
  /** Changes since the index's recorded commit, or null when there is no baseline. */
  baseline: ActivityBaseline | null;
  /** Newest commits first, capped; each carries its aggregate index verdict. */
  timeline: ActivityCommit[];
  /** True when the activity window held more commits than the timeline cap. */
  timelineTruncated: boolean;
}

/** One commit's patch for a single file, bounded for the panel. */
export type { CommitDiff } from 'dsh-gitnexus-wire';

/** Patch is capped: a minified vendor file can carry megabytes in one commit. */
const DIFF_LIMIT_BYTES = 120 * 1024;

/**
 * The change a commit made to one file.
 *
 * `git show <sha> -- <path>` is the only command that answers this without checking
 * out anything, and it is read-only. The path has already been resolved inside the
 * project by the route; the sha is validated here because it reaches git as an argument.
 */
export async function readCommitDiff(
  repoPath: string,
  filePath: string,
  sha: string,
): Promise<CommitDiff> {
  const clean = String(sha ?? '').trim();
  if (!/^[0-9a-fA-F]{7,40}$/.test(clean)) {
    return { path: filePath, sha: clean, available: false, patch: '', truncated: false, reason: '提交号不合法' };
  }
  const out = await git(
    repoPath,
    ['show', '--format=', '--no-color', '--unified=3', clean, '--', filePath],
    DIFF_LIMIT_BYTES * 2,
  );
  if (out === null) {
    return { path: filePath, sha: clean, available: false, patch: '', truncated: false, reason: 'git 无法读取该提交的改动' };
  }
  const truncated = Buffer.byteLength(out, 'utf8') > DIFF_LIMIT_BYTES;
  return {
    path: filePath,
    sha: clean,
    available: true,
    patch: truncated ? out.slice(0, DIFF_LIMIT_BYTES) : out,
    truncated,
    reason: null,
  };
}

/** One commit touching a specific file, and a file's bounded history. */
export type { FileHistory, FileHistoryCommit } from 'dsh-gitnexus-wire';

export interface ReadFileHistoryOptions {
  days?: number;
  maxCommits?: number;
}

export interface ReadGitActivityOptions {
  sinceDays?: number;
  maxCommits?: number;
  maxFiles?: number;
  maxAuthors?: number;
  maxBranches?: number;
  indexedPaths?: Iterable<string>;
  scannablePaths?: Iterable<string>;
  /** The index's recorded commit; when set, also review HEAD against it. */
  baselineRef?: string | null;
}

/**
 * Whether an author is a machine account.
 *
 * Worth separating because a bot's commit count and its file count disagree in a
 * way a human's never does — measured on a real repository, `dependabot[bot]` was
 * the second-busiest author with 80 commits against just 12 files. Left in the same
 * list, it makes "who is active here" unreadable.
 */
function looksLikeBot(name: string, email: string): boolean {
  return (
    /\[bot\]$/i.test(name) ||
    /(^|[-_.])bot@/i.test(email) ||
    /^(dependabot|renovate|github-actions|greenkeeper)/i.test(name)
  );
}

/**
 * Bucket commit stamps into a time histogram.
 *
 * Daily buckets while the window is short enough to read, weekly once it is not:
 * 90 daily columns in a sidebar is a smear, not a chart. The bucket width is
 * returned so the axis can be labelled with the real unit instead of implying one.
 *
 * Empty buckets are materialised rather than skipped — a gap in a bar chart must
 * read as "no commits that day", and inferring that from irregular spacing is
 * exactly the misreading the chart exists to prevent.
 */
export function buildHistogram(stamps: ActivityStamp[], sinceDays: number): ActivityHistogram {
  if (stamps.length === 0) return { bucketDays: 1, buckets: [] };
  const bucketDays = sinceDays > 60 ? 7 : 1;

  const sorted = [...stamps].sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = Date.parse(sorted[0].date);
  const last = Date.parse(sorted[sorted.length - 1].date);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return { bucketDays, buckets: [] };

  const dayMs = 86_400_000;
  const byIndex = new Map<number, HistogramBucket>();

  for (const stamp of sorted) {
    const at = Date.parse(stamp.date);
    if (!Number.isFinite(at)) continue;
    const index = Math.floor((at - first) / dayMs / bucketDays);
    let bucket = byIndex.get(index);
    if (bucket === undefined) {
      const startMs = first + index * bucketDays * dayMs;
      bucket = {
        label: new Date(startMs).toISOString().slice(0, 10),
        commits: 0,
        insertions: 0,
        deletions: 0,
      };
      byIndex.set(index, bucket);
    }
    bucket.commits += 1;
    bucket.insertions += stamp.insertions;
    bucket.deletions += stamp.deletions;
  }

  const count = Math.max(...byIndex.keys()) + 1;
  const buckets: HistogramBucket[] = [];
  for (let i = 0; i < count; i += 1) {
    const existing = byIndex.get(i);
    if (existing !== undefined) {
      buckets.push(existing);
      continue;
    }
    const startMs = first + i * bucketDays * dayMs;
    buckets.push({
      label: new Date(startMs).toISOString().slice(0, 10),
      commits: 0,
      insertions: 0,
      deletions: 0,
    });
  }
  return { bucketDays, buckets };
}

/**
 * Read recent commits, authors, changed files and branches.
 *
 * Returns `null` when git cannot answer at all.
 */
export async function readGitActivity(
  repoPath: string,
  options: ReadGitActivityOptions = {},
): Promise<ActivityInfo | null> {
  // The window is expressed in days rather than as a git date expression so the
  // result can be *labelled* without parsing one back out. A first revision passed
  // the raw spec straight into the UI, which rendered "近 90 days ago 内".
  const sinceDays = options.sinceDays ?? DEFAULTS.sinceDays;
  const since = `${sinceDays} days ago`;
  const maxCommits = options.maxCommits ?? DEFAULTS.maxCommits;
  const maxFiles = options.maxFiles ?? DEFAULTS.maxFiles;
  const maxAuthors = options.maxAuthors ?? DEFAULTS.maxAuthors;
  const maxBranches = options.maxBranches ?? DEFAULTS.maxBranches;

  const indexed = new Set([...(options.indexedPaths ?? [])].map((p) => normalizePathKey(p)));
  const scannable = new Set([...(options.scannablePaths ?? [])].map((p) => normalizePathKey(p)));
  const classified = indexed.size > 0 || scannable.size > 0;

  /**
   * Three-way, because "not in the index" is two different facts. A `.gitignore`
   * or a `package-lock.json` is absent by design; a source file a fresh scan would
   * pick up is absent because the index is behind. Reporting them as one number
   * would make every repository look badly stale.
   */
  const classify = (filePath: string): FileVerdict => {
    const key = normalizePathKey(filePath);
    if (indexed.has(key)) return 'indexed';
    if (scannable.size > 0 && scannable.has(key)) return 'missing';
    return 'excluded';
  };

  // The branch list does not depend on the log, so it starts before the log is parsed
  // and is awaited where it is used. Two windows of git work overlap instead of queue.
  const branchPromise = git(repoPath, [
    'for-each-ref',
    `--count=${maxBranches}`,
    '--sort=-committerdate',
    `--format=%(refname:short)${US}%(committerdate:iso-strict)${US}%(authorname)${US}%(HEAD)`,
    'refs/heads',
  ]);

  const log = await git(repoPath, [
    'log',
    `--since=${since}`,
    // One commit past the window: asking for exactly `maxCommits` cannot distinguish
    // "the window holds exactly that many" from "there were more", and a `>=` guess
    // flags every busy repository as truncated.
    `--max-count=${maxCommits + 1}`,
    '--numstat',
    '--no-renames',
    `--format=${RS}%H${US}%an${US}%ae${US}%aI${US}%s`,
  ]);
  if (log === null) return null;

  const tally = parseLogWindow(log, maxCommits);
  const { commits, files, authorMap, stamps, commitCount, capped } = tally;
  const { newestCommit, oldestCommit, totalInsertions, totalDeletions } = tally;
  const authors: ActivityAuthor[] = [];

  const toActivityFile = (file: FileTally): ActivityFile => {
    const verdict: FileVerdict = classified ? classify(file.path) : 'excluded';
    return { ...file, indexed: verdict === 'indexed', verdict };
  };

  /**
   * `HEAD` against the commit the index was built from.
   *
   * Deliberately not part of the rolling window: the baseline can be older than
   * 90 days and the question is still "what changed since we indexed?", so this uses
   * a direct diff with its own bounded buffer rather than a wider log.
   */
  const readBaseline = async (
    ref: string,
    source: ActivityBaseline['source'],
  ): Promise<ActivityBaseline> => {
    const short = ref.slice(0, 8);
    // Three independent reads of the same ref pair: the subject, the numstat, and the
    // commit count. Running them together keeps the baseline to one git round-trip
    // instead of three, which is most of what this panel load used to spend.
    const [show, diff, countRaw] = await Promise.all([
      git(repoPath, ['show', '-s', `--format=%H${US}%aI${US}%an${US}%s`, ref]),
      git(repoPath, ['diff', '--numstat', '--no-renames', `${ref}..HEAD`]),
      git(repoPath, ['rev-list', '--count', `${ref}..HEAD`]),
    ]);
    if (show === null) {
      return {
        ref,
        source,
        available: false,
        shortSha: short,
        date: null,
        subject: null,
        author: null,
        commits: 0,
        files: 0,
        insertions: 0,
        deletions: 0,
        changedFiles: [],
        reason: '索引记录的基线提交在当前仓库中不可读（可能被 rebase 或 force-push 丢弃）',
      };
    }
    const [sha, date, author, subject]: (string | undefined)[] = show.trim().split(US);
    const base = {
      ref,
      source,
      shortSha: (sha ?? ref).slice(0, 8),
      date: date ?? null,
      subject: subject ?? null,
      author: author ?? null,
    };

    if (diff === null) {
      return {
        ...base,
        available: false,
        commits: 0,
        files: 0,
        insertions: 0,
        deletions: 0,
        changedFiles: [],
        reason: '基线提交可读，但 diff 超出上限或失败',
      };
    }

    const changed = new Map<string, { insertions: number; deletions: number }>();
    let insertions = 0;
    let deletions = 0;
    for (const row of parseNumstatLines(diff)) {
      insertions += row.insertions;
      deletions += row.deletions;
      changed.set(row.path, { insertions: row.insertions, deletions: row.deletions });
    }

    const commitCount = countRaw === null ? 0 : Number.parseInt(countRaw.trim(), 10);

    const changedFiles: ActivityFile[] = [...changed.entries()]
      .sort((a, b) => b[1].insertions + b[1].deletions - (a[1].insertions + a[1].deletions))
      .slice(0, 50)
      .map(([filePath, delta]) => {
        const verdict: FileVerdict = classified ? classify(filePath) : 'excluded';
        return {
          path: filePath,
          changes: 1,
          insertions: delta.insertions,
          deletions: delta.deletions,
          lastChange: base.date ?? '',
          indexed: verdict === 'indexed',
          verdict,
        };
      });

    return {
      ...base,
      available: true,
      commits: Number.isFinite(commitCount) ? commitCount : 0,
      files: changed.size,
      insertions,
      deletions,
      changedFiles,
      reason: null,
    };
  };

  const baselineRef = typeof options.baselineRef === 'string' ? options.baselineRef.trim() : '';
  // The manifest can legitimately have no recorded commit. Falling back to the
  // oldest commit in the activity window still answers "what changed recently?",
  // but the source is carried so the UI never calls it an index baseline.
  // `oldestCommit` is the oldest *date*; the fallback needs the oldest SHA, which
  // is the last commit after `git log` has produced newest-first entries.
  const windowBaseline = commits.length > 0 ? commits[commits.length - 1].sha : '';
  // Started here and awaited at the end: the baseline is two or three more git calls,
  // and it does not depend on the branch list that is awaited in between.
  const baselinePromise: Promise<ActivityBaseline | null> | null =
    baselineRef !== ''
      ? readBaseline(baselineRef, 'index')
      : windowBaseline !== ''
        ? readBaseline(windowBaseline, 'window')
        : null;

  const byChanges = [...files.values()]
    .sort((a, b) => b.changes - a.changes || (a.path < b.path ? -1 : 1))
    .slice(0, maxFiles)
    .map(toActivityFile);

  const byRecency = [...files.values()]
    .sort((a, b) => (a.lastChange < b.lastChange ? 1 : a.lastChange > b.lastChange ? -1 : 0))
    .slice(0, maxFiles)
    .map(toActivityFile);

  authors.push(
    ...[...authorMap.values()]
      .sort((a, b) => b.commits - a.commits)
      .slice(0, maxAuthors)
      .map(({ fileSet, ...rest }) => ({
        ...rest,
        files: fileSet.size,
        bot: looksLikeBot(rest.name, rest.email),
      })),
  );

  const branchRaw = await branchPromise;
  const branches: ActivityBranch[] = [];
  if (branchRaw !== null) {
    for (const line of branchRaw.split('\n')) {
      if (line.trim() === '') continue;
      const [name, date, author, head]: (string | undefined)[] = line.split(US);
      if (name === undefined) continue;
      branches.push({
        name,
        lastCommitDate: date ?? '',
        lastAuthor: author ?? '',
        current: head === '*',
      });
    }
  }

  const verdictCounts: Record<FileVerdict, number> = { indexed: 0, excluded: 0, missing: 0 };
  for (const path of files.keys()) {
    verdictCounts[classified ? classify(path) : 'excluded'] += 1;
  }

  // Kept out of the `byChanges`/`byRecency` display caps on purpose. Those caps
  // exist to bound a list a reader browses; "missing from the index" is the
  // actionable subset, and a first revision lost it there — the summary reported
  // "1 MISSING" and then listed nothing, because the file was not among the 200
  // most-changed. A count with no rows is worse than no count.
  const missingFiles = [...files.values()]
    .filter((file) => classified && classify(file.path) === 'missing')
    .sort((a, b) => b.changes - a.changes || (a.path < b.path ? -1 : 1))
    .slice(0, 50)
    .map(toActivityFile);

  // The cross-tab keeps the three-way verdict and adds the volume that made each
  // row matter: a "missing" file changed once is different from 40 commits.
  const crossRows: ActivityCrossRow[] = (['indexed', 'excluded', 'missing'] as const).map(
    (verdict) => ({
      verdict,
      files: 0,
      changes: 0,
      insertions: 0,
      deletions: 0,
    }),
  );
  const crossByVerdict = new Map(crossRows.map((row) => [row.verdict, row]));
  let totalChanges = 0;
  for (const file of files.values()) {
    const verdict: FileVerdict = classified ? classify(file.path) : 'excluded';
    const row = crossByVerdict.get(verdict);
    if (row === undefined) continue;
    row.files += 1;
    row.changes += file.changes;
    row.insertions += file.insertions;
    row.deletions += file.deletions;
    totalChanges += file.changes;
  }
  const cross: ActivityCross = { rows: crossRows, totalFiles: files.size, totalChanges };

  const timelineCap = 100;
  const timeline: ActivityCommit[] = commits.slice(0, timelineCap).map((commit) => {
    let anyMissing = false;
    let anyIndexed = false;
    for (const path of commit.fileSet) {
      if (!classified) continue;
      const verdict = classify(path);
      if (verdict === 'missing') anyMissing = true;
      else if (verdict === 'indexed') anyIndexed = true;
    }
    return {
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 8),
      date: commit.date,
      author: commit.author,
      subject: commit.subject,
      files: commit.fileSet.size,
      insertions: commit.insertions,
      deletions: commit.deletions,
      verdict: anyMissing ? 'missing' : anyIndexed ? 'indexed' : 'excluded',
    };
  });

  const baseline = baselinePromise === null ? null : await baselinePromise;

  return {
    window: {
      sinceDays,
      since,
      maxCommits,
      maxFiles,
      // A capped log that does not say so reads as "this is all the activity there
      // was" — the one conclusion the caller must not draw. The flag is exact: the
      // extra commit asked for above either arrived (capped) or did not.
      truncated: capped,
      oldestCommit: oldestCommit === '' ? null : oldestCommit,
      newestCommit: newestCommit === '' ? null : newestCommit,
    },
    totals: {
      commits: commitCount,
      authors: authorMap.size,
      bots: authors.filter((a) => a.bot).length,
      files: files.size,
      insertions: totalInsertions,
      deletions: totalDeletions,
      verdicts: verdictCounts,
      indexKnown: classified,
      // Kept under their original names so a caller written against the first
      // revision keeps working; `verdicts` is the richer view.
      filesTouchedThatAreIndexed: verdictCounts.indexed,
      filesTouchedThatAreNotIndexed: verdictCounts.excluded + verdictCounts.missing,
    },
    authors,
    byChanges,
    byRecency,
    missingFiles,
    branches,
    histogram: buildHistogram(stamps, sinceDays),
    currentBranch: branches.find((b) => b.current)?.name ?? null,
    cross,
    baseline,
    timeline,
    timelineTruncated: commits.length > timelineCap,
  };
}

/**
 * Read one file's commits for its own timeline.
 *
 * Kept separate from {@link readGitActivity} because "show me this file's history"
 * should not pay for the whole repository's numstat. `--follow` is intentional: a
 * renamed file's timeline that stops at the rename is a misleading one.
 */
export async function readFileActivity(
  repoPath: string,
  filePath: string,
  options: ReadFileHistoryOptions = {},
): Promise<FileHistory> {
  const normalized = filePath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  const invalid =
    normalized === '' ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes('\0') ||
    normalized.split('/').includes('..');
  const rawDays = typeof options.days === 'number' && Number.isFinite(options.days) ? options.days : 7;
  // The UI offers 7/14/30; clamp here too, so a hand-written URL cannot turn this
  // into an unbounded history read.
  const days = Math.max(1, Math.min(30, Math.floor(rawDays)));
  const maxCommits = Math.max(
    1,
    Math.min(200, Math.floor(options.maxCommits ?? 100)),
  );
  if (invalid) {
    return {
      path: normalized,
      available: false,
      days,
      commits: 0,
      insertions: 0,
      deletions: 0,
      timeline: [],
      reason: '文件路径必须在项目内',
    };
  }

  const log = await git(
    repoPath,
    [
      'log',
      '--follow',
      `--since=${days} days ago`,
      `--max-count=${maxCommits}`,
      '--numstat',
      `--format=${RS}%H${US}%an${US}%ae${US}%aI${US}%s`,
      '--',
      normalized,
    ],
  );
  if (log === null) {
    return {
      path: normalized,
      available: false,
      days,
      commits: 0,
      insertions: 0,
      deletions: 0,
      timeline: [],
      reason: 'git 不可用或无法读取该文件的历史',
    };
  }

  const timeline: FileHistoryCommit[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const chunk of log.split(RS)) {
    if (chunk.trim() === '') continue;
    const newline = chunk.indexOf('\n');
    const header = newline === -1 ? chunk : chunk.slice(0, newline);
    const body = newline === -1 ? '' : chunk.slice(newline + 1);
    const [sha, author, , date, subject]: (string | undefined)[] = header.split(US);
    if (sha === undefined || date === undefined) continue;

    let commitInsertions = 0;
    let commitDeletions = 0;
    for (const line of body.split('\n')) {
      if (line.trim() === '') continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [addedRaw, deletedRaw] = parts;
      const added = Number.parseInt(addedRaw, 10);
      const deleted = Number.parseInt(deletedRaw, 10);
      const ins = Number.isFinite(added) ? added : 0;
      const del = Number.isFinite(deleted) ? deleted : 0;
      commitInsertions += ins;
      commitDeletions += del;
    }
    insertions += commitInsertions;
    deletions += commitDeletions;
    timeline.push({
      sha,
      shortSha: sha.slice(0, 8),
      date,
      author: author ?? '?',
      subject: subject ?? '',
      insertions: commitInsertions,
      deletions: commitDeletions,
    });
  }

  return {
    path: normalized,
    available: true,
    days,
    commits: timeline.length,
    insertions,
    deletions,
    timeline,
    reason: null,
  };
}
