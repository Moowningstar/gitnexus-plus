/**
 * Parsing for the two `--numstat` shapes this plugin reads.
 *
 * Both the rolling log and the baseline diff arrive as the same thing — `added`,
 * `deleted`, `path` per line, tab separated, with `-` in place of a number for a
 * binary file — so the reading lives here once instead of twice. The log has a
 * second layer on top (commit headers, per-author and per-file tallies, the exact
 * truncation flag), which is `parseLogWindow`.
 *
 * Nothing here touches the filesystem or spawns git: the callers own the process,
 * this module owns the text.
 */

import type { ActivityAuthor, ActivityCommit, ActivityFile, ActivityStamp } from './git-activity.js';

/** Field separator inside one log header line (`%an`, `%ae`, …). */
export const LOG_FIELD_SEPARATOR = '\u001f';
/** Record separator in front of every commit header in the log. */
export const LOG_RECORD_SEPARATOR = '\u001e';

/** One file's line deltas, as both numstat shapes express them. */
export interface NumstatRow {
  path: string;
  insertions: number;
  deletions: number;
}

/**
 * Read `git --numstat` output into rows.
 *
 * `-` marks a binary file: it counts as a change with no line delta, which is the
 * truthful reading. The path is everything after the second tab — a path may itself
 * contain tabs, so joining the remainder is not defensive coding but correctness.
 */
export function parseNumstatLines(text: string): NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addedRaw, deletedRaw, ...pathParts] = parts;
    const filePath = pathParts.join('\t');
    if (filePath === '') continue;
    const added = Number.parseInt(addedRaw, 10);
    const deleted = Number.parseInt(deletedRaw, 10);
    rows.push({
      path: filePath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return rows;
}

/** A file row before it is crossed with the index, so no verdict exists yet. */
export type FileTally = Omit<ActivityFile, 'indexed' | 'verdict'>;

/** A commit before its aggregate index verdict is known. */
export type CommitTally = Omit<ActivityCommit, 'files' | 'shortSha' | 'verdict'> & {
  sha: string;
  fileSet: Set<string>;
};

/** An author row before it is emitted: `bot` is decided at emit time. */
export type AuthorEntry = Omit<ActivityAuthor, 'bot'> & { fileSet: Set<string> };

/** Everything one log window yields, before the index is crossed with it. */
export interface LogTally {
  commits: CommitTally[];
  files: Map<string, FileTally>;
  authorMap: Map<string, AuthorEntry>;
  stamps: ActivityStamp[];
  commitCount: number;
  /** True once the loop met the commit past the window: a fact, not an inference. */
  capped: boolean;
  newestCommit: string;
  oldestCommit: string;
  totalInsertions: number;
  totalDeletions: number;
}

/**
 * Turn `git log --numstat` output into tallies.
 *
 * The caller asks for one commit past `maxCommits`; meeting it sets `capped` and
 * breaks before counting it, so "the window holds exactly the cap" and "there was
 * more" stay distinguishable.
 */
export function parseLogWindow(raw: string, maxCommits: number): LogTally {
  const files = new Map<string, FileTally>();
  const authorMap = new Map<string, AuthorEntry>();
  const commits: CommitTally[] = [];
  const stamps: ActivityStamp[] = [];

  let commitCount = 0;
  let capped = false;
  let totalInsertions = 0;
  let totalDeletions = 0;
  let newestCommit = '';
  let oldestCommit = '';

  for (const chunk of raw.split(LOG_RECORD_SEPARATOR)) {
    if (chunk.trim() === '') continue;
    const newline = chunk.indexOf('\n');
    const header = newline === -1 ? chunk : chunk.slice(0, newline);
    const body = newline === -1 ? '' : chunk.slice(newline + 1);
    // `split` yields a plain array, so a short header really can leave these
    // undefined even though the declared element type says otherwise.
    const [sha, author, email, date, subject]: (string | undefined)[] = header.split(LOG_FIELD_SEPARATOR);
    if (sha === undefined || date === undefined) continue;

    if (commitCount >= maxCommits) {
      capped = true;
      break;
    }
    commitCount += 1;
    const commit: CommitTally = {
      sha,
      date,
      author: author ?? '?',
      subject: subject ?? '',
      insertions: 0,
      deletions: 0,
      fileSet: new Set(),
    };
    if (newestCommit === '' || date > newestCommit) newestCommit = date;
    if (oldestCommit === '' || date < oldestCommit) oldestCommit = date;

    const key = `${author ?? '?'} <${email ?? '?'}>`;
    let entry = authorMap.get(key);
    if (entry === undefined) {
      entry = {
        name: author ?? '?',
        email: email ?? '?',
        commits: 0,
        insertions: 0,
        deletions: 0,
        files: 0,
        lastCommit: date,
        fileSet: new Set(),
      };
      authorMap.set(key, entry);
    }
    entry.commits += 1;
    if (date > entry.lastCommit) entry.lastCommit = date;

    let commitInsertions = 0;
    let commitDeletions = 0;

    for (const row of parseNumstatLines(body)) {
      totalInsertions += row.insertions;
      totalDeletions += row.deletions;
      commitInsertions += row.insertions;
      commitDeletions += row.deletions;
      entry.insertions += row.insertions;
      entry.deletions += row.deletions;
      entry.fileSet.add(row.path);
      commit.insertions += row.insertions;
      commit.deletions += row.deletions;
      commit.fileSet.add(row.path);

      let file = files.get(row.path);
      if (file === undefined) {
        file = { path: row.path, changes: 0, insertions: 0, deletions: 0, lastChange: date };
        files.set(row.path, file);
      }
      file.changes += 1;
      file.insertions += row.insertions;
      file.deletions += row.deletions;
      if (date > file.lastChange) file.lastChange = date;
    }

    stamps.push({ date, insertions: commitInsertions, deletions: commitDeletions });
    commits.push(commit);
  }

  return {
    commits,
    files,
    authorMap,
    stamps,
    commitCount,
    capped,
    newestCommit,
    oldestCommit,
    totalInsertions,
    totalDeletions,
  };
}
