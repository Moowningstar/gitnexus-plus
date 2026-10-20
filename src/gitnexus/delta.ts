/**
 * Tier 0 staleness: is a refresh worth running at all?
 *
 * WHY THIS EXISTS
 * ---------------
 * The panel's only maintenance action used to be "run `gitnexus analyze`", and it ran
 * the analyzer every time — on a repository where nothing had changed since the index
 * was written. That is not a correctness bug, it is a cost bug with a bad shape: the
 * work is measured in seconds on a small repository and in minutes on a large one, and
 * the user has no way to know beforehand whether they are about to spend it.
 *
 * The index already records what it saw: `.gitnexus/gitnexus.json` carries
 * `fileHashes`, a map of repo-relative path to sha256. Comparing the working tree
 * against those hashes answers "would a re-analysis change anything?" exactly, and it
 * needs nothing but git and a hash function.
 *
 * WHAT IS COMPARED, AND AGAINST WHAT
 * ----------------------------------
 * The baseline is the **index snapshot**, not `HEAD`. Those differ whenever the index
 * was built from a dirty tree, and the manifest records that case in
 * `indexCoverage.dirtyPaths`. Comparing against `HEAD` would call a file unchanged
 * merely because it was committed, even though the index remembered different content
 * — which is the direction that produces a stale graph the panel says is current.
 *
 * The candidate set is therefore everything that differs from the *indexed commit*:
 *
 *   `git diff --no-renames --name-only <lastCommit>`  tracked files, working tree vs
 *                                                     that commit (staged and unstaged)
 *   `git ls-files --others --exclude-standard`        untracked files git would include
 *
 * `--no-renames` on purpose: with rename detection on, git reports only the new path,
 * so a rename looks like a pure addition and the index's old path silently disappears
 * from the comparison. Forcing add+delete pairs lets each side be classified on its
 * own evidence.
 *
 * Hash comparison is per candidate, not per indexed file, which is what keeps this
 * cheap: a clean working tree produces an empty candidate set and no file is read at
 * all. `mtime` is *not* used as a prefilter even though the plan called for one — the
 * manifest stores a hash and no mtime, so "the mtime did not move" cannot prove the
 * content matches, and using it would trade an exact answer for a fast wrong one.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It never runs the analyzer, never writes, and never reads the graph. It also does not
 * decide *which* tier of refresh to run — that needs the analyzer's own judgement about
 * schema and FTS state. It answers one question: has indexed content changed?
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { formatBytes } from './coverage.js';
import { readIndexMeta, type IndexMeta } from './index-meta.js';

/**
 * `execFile`, promisified, resolved as decoded text.
 *
 * No shell: the repository path is caller-supplied and only ever travels as `cwd`.
 * `-z` output is NUL-separated rather than newline-separated precisely because a path
 * may contain a newline, and `git status` would otherwise quote it into an unparseable
 * form.
 */
const run = promisify(execFile) as (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

/**
 * How much a changed file is, for the panel's purposes.
 *
 * `updated` covers both "content differs from the hash" and "the file is gone", but the
 * distinction matters to the operator — a deletion is not a modification of the same
 * unit — so they stay separate kinds.
 */
export type DeltaKind = 'modified' | 'added' | 'deleted' | 'excluded';

export interface DeltaEntry {
  /** repo-relative, forward slashes — the same form `fileHashes` uses */
  path: string;
  kind: DeltaKind;
  /** why this path was classified as excluded; null for every other kind */
  reason: string | null;
}

/** Which side the candidate set came from. */
export type DeltaBasis =
  /** the index recorded a commit that git still knows: exact comparison */
  | 'index'
  /** the index recorded no usable commit: only working-tree-vs-HEAD was checked */
  | 'worktree';

export interface DeltaCounts {
  /** candidates examined */
  checked: number;
  /** content actually read for a hash — the cost signal */
  hashed: number;
  /** hashes that matched the index */
  unchanged: number;
  modified: number;
  added: number;
  deleted: number;
  /** changed, but the index's own policy would skip these */
  excluded: number;
}

export interface DeltaReport {
  repoPath: string;
  /** whether an index manifest was found at all */
  indexed: boolean;
  /**
   * Whether a content comparison was possible. `false` with a `notes` entry is the
   * answer for a project with no index, an older manifest without `fileHashes`, or no
   * usable git — in each case the caller should fall back to asking the analyzer.
   */
  comparable: boolean;
  basis: DeltaBasis | null;
  indexedCommit: string | null;
  headCommit: string | null;
  /** actionable + excluded entries, sorted by path */
  entries: DeltaEntry[];
  counts: DeltaCounts;
  /**
   * Whether a refresh would plausibly change the index. Excluded files do not count:
   * re-running the analyzer would skip them again.
   *
   * Only meaningful together with {@link certain}. A `false` from a worktree-basis
   * comparison means "no uncommitted change", not "the index is current".
   */
  needsRefresh: boolean;
  /**
   * Whether the answer is anchored to the index's own commit.
   *
   * When the manifest records no usable commit, the comparison degrades to
   * working-tree-vs-HEAD, which cannot see commits made after the index was built. That
   * is exactly the case a staleness gate must not report as clean — measured on this
   * repository: a rebuild wrote an empty `lastCommit`, the tree was clean, and the gate
   * said 无需刷新 while any later commit would have made it stale.
   */
  certain: boolean;
  /** the candidate set hit the cap; entries may be incomplete */
  truncated: boolean;
  /** operator-facing explanation of the verdict, in order of importance */
  notes: string[];
  durationMs: number;
  readAt: string;
}

export interface DeltaOptions {
  /**
   * Candidate cap. A candidate set this large means the index is far behind or the
   * repository has thousands of dirty files; at that point the precise answer stops
   * being worth the reads and the caller should just refresh.
   */
  maxFiles?: number;
  /** Parallel file reads while hashing. Small: these are local reads. */
  hashConcurrency?: number;
  /** `git` timeout for one call. */
  gitTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_FILES = 4000;
const DEFAULT_HASH_CONCURRENCY = 8;
const DEFAULT_GIT_TIMEOUT_MS = 15_000;

/** Run one git command, or report that git could not answer. */
async function git(repoPath: string, args: string[], timeoutMs: number): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, {
      cwd: repoPath,
      timeout: timeoutMs,
      windowsHide: true,
      // Name lists on a very large repository can exceed the default 1 MB cap. The
      // cap exists so a runaway command cannot exhaust memory; 32 MB of paths is
      // already an unreasonable candidate set, and `maxFiles` truncates it anyway.
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/** Split `-z` output on NUL and drop the trailing empty record. */
function splitNul(text: string): string[] {
  return text.split('\0').filter((part) => part !== '');
}

/** The key form `fileHashes` uses: forward slashes, no leading `./`. */
function toKey(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Stream one file through sha256. Returns null when it cannot be read. */
async function hashFile(absolutePath: string): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(absolutePath);
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolvePromise());
    });
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/** The counts of an empty report, so every early return carries the same shape. */
const ZERO_COUNTS: DeltaCounts = {
  checked: 0,
  hashed: 0,
  unchanged: 0,
  modified: 0,
  added: 0,
  deleted: 0,
  excluded: 0,
};

/**
 * Compare the working tree against the content the index recorded.
 *
 * @param repoPath absolute repository root
 */
export async function readDelta(repoPath: string, options: DeltaOptions = {}): Promise<DeltaReport> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const absRepo = path.resolve(repoPath);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const concurrency = Math.max(1, options.hashConcurrency ?? DEFAULT_HASH_CONCURRENCY);
  const gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;

  const empty = (patch: Partial<DeltaReport>): DeltaReport => ({
    repoPath: absRepo,
    indexed: false,
    comparable: false,
    basis: null,
    indexedCommit: null,
    headCommit: null,
    entries: [],
    counts: { ...ZERO_COUNTS },
    needsRefresh: false,
    certain: false,
    truncated: false,
    notes: [],
    durationMs: now() - startedAt,
    readAt: new Date().toISOString(),
    ...patch,
  });

  const meta: IndexMeta | null = await readIndexMeta(absRepo);
  if (meta === null) {
    return empty({ notes: ['该项目还没有 GitNexus 索引，先初始化再说'] });
  }

  const indexedCommit = meta.lastCommit === '' ? null : meta.lastCommit;
  const base: Partial<DeltaReport> = { indexed: true, indexedCommit };

  // The map is normalized-key -> original key, and the hash is read through the
  // original: `fileHashes` is written by GitNexus, and a manifest whose keys use
  // backslashes (Windows builds did) must still match the forward-slash key git
  // reports. Rewriting the manifest's keys instead would mutate what we only read.
  const hashByKey = new Map<string, string>();
  for (const [rawPath, hash] of Object.entries(meta.fileHashes)) {
    hashByKey.set(toKey(rawPath), hash.toLowerCase());
  }
  if (hashByKey.size === 0) {
    return empty({
      ...base,
      notes: ['该索引没有记录文件哈希（旧格式 manifest），无法判断内容是否变化 —— 直接刷新'],
    });
  }

  const headCommit = (await git(absRepo, ['rev-parse', 'HEAD'], gitTimeoutMs))?.trim() ?? null;

  let basis: DeltaBasis | null = null;
  let candidates: string[] = [];

  if (indexedCommit !== null && headCommit !== null) {
    const diff = await git(
      absRepo,
      ['diff', '--no-renames', '--name-only', '-z', indexedCommit, '--'],
      gitTimeoutMs,
    );
    if (diff !== null) {
      basis = 'index';
      candidates = splitNul(diff);
    }
  }

  if (basis === null && headCommit !== null) {
    // The recorded commit is gone (rebase, branch rewrite, shallow clone) or the
    // manifest never had one. Working tree vs HEAD is the honest fallback: it finds
    // uncommitted and newly committed files, and it cannot see a difference that was
    // committed before the index was written. Say so rather than implying otherwise.
    const againstHead = await git(
      absRepo,
      ['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--'],
      gitTimeoutMs,
    );
    if (againstHead !== null) {
      basis = 'worktree';
      candidates = splitNul(againstHead);
    }
  }

  if (basis === null) {
    return empty({
      ...base,
      headCommit,
      notes: [
        indexedCommit === null
          ? '索引没有记录提交基线，且 git 也无法读取 HEAD —— 无法比较，直接刷新'
          : '索引记录的提交在本地 git 历史中已不可用，且无法读取 HEAD —— 无法比较，直接刷新',
      ],
    });
  }

  const untracked = await git(
    absRepo,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    gitTimeoutMs,
  );
  if (untracked !== null) {
    candidates.push(...splitNul(untracked));
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of candidates) {
    const key = toKey(candidate);
    if (key === '' || seen.has(key)) continue;
    // The index's own storage is never indexed content. `.gitnexus/` self-ignores in
    // most repositories (GitNexus writes a `*` .gitignore there), so this only matters
    // where it does not — but in exactly that case every read would report the index
    // manifest itself as a new file and ask for a refresh forever.
    if (key.startsWith('.gitnexus/') || key.startsWith('.git/')) continue;
    seen.add(key);
    unique.push(key);
  }
  unique.sort();

  const truncated = unique.length > maxFiles;
  const examined = truncated ? unique.slice(0, maxFiles) : unique;

  const entries: DeltaEntry[] = [];
  const counts: DeltaCounts = { ...ZERO_COUNTS };
  counts.checked = examined.length;

  // Bounded parallelism rather than one read at a time: a 4000-file candidate set read
  // sequentially is dominated by syscall latency, and these are local files.
  for (let offset = 0; offset < examined.length; offset += concurrency) {
    const batch = examined.slice(offset, offset + concurrency);
    const settled = await Promise.all(
      batch.map(async (key): Promise<DeltaEntry | null> => {
        const absolute = path.join(absRepo, key);
        let size: number;
        try {
          const stat = await fs.stat(absolute);
          if (!stat.isFile()) return null;
          size = stat.size;
        } catch {
          // Gone from the working tree. Only worth reporting when the index had it;
          // an untracked file deleted between `ls-files` and this stat is not news.
          return hashByKey.has(key) ? { path: key, kind: 'deleted', reason: null } : null;
        }

        const recorded = hashByKey.get(key);
        if (recorded === undefined) {
          const cap = meta.coverageMaxFileSizeBytes;
          if (cap !== null && size > cap) {
            return {
              path: key,
              kind: 'excluded',
              reason: `超过索引记录的大小上限（${formatBytes(cap)}），刷新也会被跳过`,
            };
          }
          return { path: key, kind: 'added', reason: null };
        }

        counts.hashed += 1;
        const current = await hashFile(absolute);
        if (current === null) {
          // Unreadable is not unchanged. Treating it as modified makes the panel ask
          // for a refresh; treating it as unchanged would report a stale index as
          // current, which is the one error this module exists to prevent.
          return { path: key, kind: 'modified', reason: '无法读取文件内容，按已变更处理' };
        }
        if (current === recorded) {
          counts.unchanged += 1;
          return null;
        }
        return { path: key, kind: 'modified', reason: null };
      }),
    );
    for (const entry of settled) {
      if (entry !== null) entries.push(entry);
    }
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of entries) counts[entry.kind] += 1;

  const actionable = counts.modified + counts.added + counts.deleted;
  const certain = basis === 'index';
  const notes: string[] = [];
  if (basis === 'worktree') {
    notes.push(
      '索引没有记录可用的提交基线：只比较了工作区相对 HEAD 的改动，索引建立之后已提交的改动看不到',
    );
  }
  if (truncated) {
    notes.push(`候选文件超过 ${maxFiles} 个，只检查了前 ${maxFiles} 个 —— 建议直接刷新`);
  }
  if (actionable === 0) {
    // A clean worktree is not the same claim as a clean index. Saying "一致" on the
    // worktree basis is how a stale index gets reported as current: the next commit
    // makes it stale and this comparison will still be empty.
    notes.push(
      certain
        ? counts.checked === 0
          ? '工作区与索引记录一致：没有任何文件相对索引提交发生改动'
          : `工作区与索引记录一致：${counts.checked} 个候选文件中 ${counts.unchanged} 个内容哈希匹配` +
              (counts.excluded > 0 ? `，${counts.excluded} 个属索引策略排除` : '')
        : '工作区相对 HEAD 没有改动，但无法确认索引已包含当前提交 —— 需要刷新才能确定',
    );
    if (counts.excluded > 0) {
      notes.push('被排除的文件刷新也会再次跳过，因此不需要为它们刷新索引');
    }
  } else {
    const parts: string[] = [];
    if (counts.modified > 0) parts.push(`${counts.modified} 个修改`);
    if (counts.added > 0) parts.push(`${counts.added} 个新增`);
    if (counts.deleted > 0) parts.push(`${counts.deleted} 个删除`);
    notes.unshift(`索引内容已落后：${parts.join('、')}`);
  }

  return {
    repoPath: absRepo,
    indexed: true,
    comparable: true,
    basis,
    indexedCommit,
    headCommit,
    entries,
    counts,
    needsRefresh: actionable > 0,
    certain,
    truncated,
    notes,
    durationMs: now() - startedAt,
    readAt: new Date().toISOString(),
  };
}

/** One-line verdict for a tool result or a log line. */
export function describeDelta(report: DeltaReport): string {
  if (!report.comparable) {
    return `无法差量判断：${report.notes[0] ?? '原因未知'}`;
  }
  if (!report.needsRefresh) {
    return report.certain
      ? `无需刷新（${report.counts.checked} 个候选，${report.counts.hashed} 次哈希，${report.durationMs}ms）`
      : `无法确认（${report.counts.checked} 个候选，${report.durationMs}ms）：${report.notes[0] ?? '索引没有记录提交基线'}`;
  }
  const changed = report.entries.filter((entry) => entry.kind !== 'excluded');
  const preview = changed
    .slice(0, 10)
    .map((entry) => `${entry.kind === 'modified' ? 'M' : entry.kind === 'added' ? 'A' : 'D'} ${entry.path}`)
    .join('\n');
  const more = changed.length > 10 ? `\n…还有 ${changed.length - 10} 个` : '';
  return (
    `需要刷新：${report.counts.modified} 改 / ${report.counts.added} 增 / ${report.counts.deleted} 删` +
    `（${report.durationMs}ms）\n${preview}${more}`
  );
}
