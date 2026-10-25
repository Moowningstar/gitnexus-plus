/**
 * Record the commit an index was built from.
 *
 * `gitnexus analyze` writes `lastCommit` into its own manifest, and that field is what
 * turns the refresh gate from "无法确认" into "已是最新": the delta comparison anchors on
 * it. Inside a DSH session the analyzer cannot produce it — it reaches git through
 * `execSync` with a captured pipe, which the host sandbox denies — so every index built
 * from the panel records `lastCommit: ""` and the gate can never answer.
 *
 * This module closes that gap *after* a successful run, and only ever fills a blank:
 *
 *   - it never overwrites a commit the analyzer recorded itself (a terminal run may know
 *     something this process does not);
 *   - it never writes while the working tree has uncommitted changes, because the index
 *     then contains content that is not in that commit — claiming otherwise is what makes
 *     a "clean" verdict lie;
 *   - it re-reads `HEAD` here rather than trusting the analyzer, so the recorded commit is
 *     the one the tree is on now.
 *
 * The write is byte-level on purpose. The manifest is GitNexus's file, it is pretty-printed
 * with a stable key order, and re-serializing it would reorder or re-format fields this
 * plugin does not understand. One occurrence of `"lastCommit": ""` is replaced in place,
 * the result is checked to still parse, and it lands through a temporary file so an
 * interrupted write cannot truncate the manifest.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { hasGitMarker, normalizePathKey, readIndexMeta } from './index-meta.js';
import { gitText } from './git-capture.js';
import { isGitNexusManagedPath } from './managed-paths.js';

/** Default ceiling for one git call. Same order as the delta comparison's. */
const GIT_TIMEOUT_MS = 20_000;

/** How many dirty paths the report carries. The panel shows a few and counts the rest. */
const DIRTY_SAMPLE = 5;

/**
 * What happened to the baseline.
 *
 * `skipped` is internal bookkeeping rather than a state the panel promises: it covers the
 * cases where there was nothing safe to write (no manifest, unreadable git, a refused
 * write). The operator sees {@link AnchorReport.message} either way.
 */
export type AnchorVerdict = 'anchored' | 'already' | 'dirty' | 'no-git' | 'skipped';

/** One file the anchor tried to update. */
export interface AnchorTarget {
  /** absolute path of the file */
  file: string;
  /** whether this run changed it */
  written: boolean;
  /** why it was left alone, when it was; null when written */
  detail: string | null;
}

export interface AnchorReport {
  verdict: AnchorVerdict;
  /** the commit recorded (or already present) in the manifest, or null */
  commit: string | null;
  /** repo-relative dirty paths, capped at {@link DIRTY_SAMPLE} */
  dirtyPaths: string[];
  /** how many dirty paths there were in total (0 when unknown) */
  dirtyCount: number;
  targets: AnchorTarget[];
  /** operator-facing, one sentence, always set */
  message: string;
  /** epoch ms */
  at: number;
}

export interface AnchorOptions {
  /**
   * The registry directory this run's `analyze` was pointed at.
   *
   * Only its `registry.json` is touched, and only for the entry of this repository. When
   * absent the manifest is still updated and the registry is left alone: guessing which
   * registry holds the entry would update a different checkout's record.
   */
  gitnexusHome?: string;
  /** Whether the run indexed a folder without git (`--skip-git`). */
  skipGit?: boolean;
  gitTimeoutMs?: number;
  /** Test seam. */
  now?: () => number;
}

/** What git says about the tree right now. */
export interface GitTruth {
  /** 40-character sha, or null when git cannot answer (no repository, no commits). */
  head: string | null;
  /** repo-relative paths that differ from `HEAD`, or null when git cannot answer. */
  dirtyPaths: string[] | null;
}

/** Split `git -z` output, dropping the empty tail. */
function splitNul(text: string): string[] {
  return text.split('\u0000').filter((entry) => entry !== '');
}

function toKey(candidate: string): string {
  return candidate.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * The working tree's truth, independent of anything the analyzer recorded.
 *
 * `git diff HEAD` covers staged and unstaged changes in one call; `ls-files --others`
 * adds files git does not track yet, and those matter most of all — GitNexus indexes the
 * working tree, so an untracked file that the index contains is content `HEAD` does not
 * have. Both are asked in `-z` form because a path may contain a newline.
 */
export async function readGitTruth(
  repoPath: string,
  options: { gitTimeoutMs?: number } = {},
): Promise<GitTruth> {
  const timeout = options.gitTimeoutMs ?? GIT_TIMEOUT_MS;
  const cwd = path.resolve(repoPath);
  const call = (args: string[]): Promise<string | null> => gitText(cwd, args, timeout);

  const headRaw = await call(['rev-parse', 'HEAD']);
  const head = headRaw === null ? null : headRaw.trim();
  const headSha = head !== null && /^[0-9a-f]{7,40}$/i.test(head) ? head : null;

  // Managed paths are excluded by the callers that consume this list, but filtering here
  // too keeps the "is the tree clean" answer honest for every caller.
  const keep = (candidate: string): boolean => {
    const key = toKey(candidate);
    if (key === '' || key.startsWith('.git/')) return false;
    return !isGitNexusManagedPath(key);
  };

  const changed = await call(['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--']);
  if (changed === null) return { head: headSha, dirtyPaths: null };
  const untracked = await call(['ls-files', '--others', '--exclude-standard', '-z']);
  // An untracked-only tree is still knowable; a failed `ls-files` is not.
  if (untracked === null) return { head: headSha, dirtyPaths: null };

  const seen = new Set<string>();
  const dirty: string[] = [];
  for (const candidate of [...splitNul(changed), ...splitNul(untracked)]) {
    const key = toKey(candidate);
    if (!keep(key) || seen.has(key)) continue;
    seen.add(key);
    dirty.push(key);
  }
  dirty.sort();
  return { head: headSha, dirtyPaths: dirty };
}

/** Shorten a sha for prose without ever making it ambiguous to a human reader. */
function shortSha(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * Replace the one empty `lastCommit` in a manifest with `commit`.
 *
 * Refuses when the field is not exactly one empty string: a manifest that already has a
 * value is not ours to rewrite, and two candidates mean the shape is not the one this
 * function was written against.
 */
async function writeManifestCommit(file: string, commit: string): Promise<AnchorTarget> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    return { file, written: false, detail: `读取失败：${describeError(error)}` };
  }

  const blank = /"lastCommit"\s*:\s*""/g;
  const matches = text.match(blank);
  if (matches === null) {
    return { file, written: false, detail: '清单里没有空白的 lastCommit 字段' };
  }
  if (matches.length > 1) {
    return { file, written: false, detail: `清单里有多处空白 lastCommit（${matches.length}），不猜是哪一处` };
  }

  const next = text.replace(/"lastCommit"\s*:\s*""/, `"lastCommit": ${JSON.stringify(commit)}`);
  try {
    const parsed = JSON.parse(next) as { lastCommit?: unknown };
    if (parsed.lastCommit !== commit) {
      return { file, written: false, detail: '替换后回读的 lastCommit 不是期望值' };
    }
  } catch (error) {
    return { file, written: false, detail: `替换后不再是合法 JSON：${describeError(error)}` };
  }

  return writeAtomically(file, next);
}

/**
 * Point the registry entry for this repository at `commit`.
 *
 * The registry is a display index — GitNexus reads it to render `gitnexus status` and to
 * resolve repositories by name — so it is updated for consistency rather than because the
 * gate needs it. Upstream owns this file and other tools add fields to it, so we do not
 * re-serialize it: we parse it to find *which* entry is ours, then patch only the blank
 * `lastCommit` inside that entry's byte range. Every other byte stays as its author left it.
 */
async function writeRegistryCommit(
  home: string,
  repoPath: string,
  commit: string,
): Promise<AnchorTarget> {
  const file = path.join(home, 'registry.json');
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return { file, written: false, detail: '注册表不存在，跳过' };
  }

  let entries: unknown;
  try {
    entries = JSON.parse(text);
  } catch {
    return { file, written: false, detail: '注册表不是合法 JSON，跳过' };
  }
  if (!Array.isArray(entries)) {
    return { file, written: false, detail: '注册表不是数组，跳过' };
  }

  const wanted = normalizePathKey(repoPath);
  const targets: number[] = [];
  (entries as unknown[]).forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;
    if (typeof record.path !== 'string') return;
    if (normalizePathKey(record.path) !== wanted) return;
    targets.push(index);
  });
  if (targets.length === 0) {
    return { file, written: false, detail: '注册表里没有本仓库的条目' };
  }

  const spans = entrySpans(text);
  if (spans === null || spans.length !== entries.length) {
    return { file, written: false, detail: '注册表的条目边界与解析结果对不上，跳过' };
  }

  let next = text;
  for (const index of targets) {
    const span = spans[index];
    if (span === undefined) return { file, written: false, detail: '注册表条目边界缺失，跳过' };
    const slice = next.slice(span.start, span.end);
    if (!/"lastCommit"\s*:\s*""/.test(slice)) {
      return { file, written: false, detail: '该条目已有提交基线，不覆盖' };
    }
    next = next.slice(0, span.start) + slice.replace(/"lastCommit"\s*:\s*""/, `"lastCommit": ${JSON.stringify(commit)}`) + next.slice(span.end);
  }

  try {
    const reread = JSON.parse(next) as Array<{ lastCommit?: unknown }>;
    if (targets.some((index) => reread[index]?.lastCommit !== commit)) {
      return { file, written: false, detail: '替换后回读的 lastCommit 不是期望值' };
    }
  } catch (error) {
    return { file, written: false, detail: `替换后不再是合法 JSON：${describeError(error)}` };
  }

  return writeAtomically(file, next);
}

/**
 * Byte ranges of the top-level objects inside a JSON array.
 *
 * String-aware so a brace inside a path (`D:\Project\{tmp}`) does not move a boundary.
 * Returns null when the text holds no object at all — the caller then refuses to patch,
 * because it could not prove which bytes belong to which entry.
 */
function entrySpans(text: string): Array<{ start: number; end: number }> | null {
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      if (depth === 1) start = index;
      continue;
    }
    if (char === '}') {
      if (depth === 1 && start >= 0) {
        spans.push({ start, end: index + 1 });
        start = -1;
      }
      depth -= 1;
    }
  }
  return spans.length > 0 ? spans : null;
}

/** Write through a sibling temporary file so an interrupted write cannot truncate. */
async function writeAtomically(file: string, content: string): Promise<AnchorTarget> {
  const temporary = `${file}.anchor-${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, file);
    return { file, written: true, detail: null };
  } catch (error) {
    try {
      await fs.rm(temporary, { force: true });
    } catch {
      /* nothing left to clean up */
    }
    return { file, written: false, detail: `写入失败：${describeError(error)}` };
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function report(
  verdict: AnchorVerdict,
  patch: Partial<Omit<AnchorReport, 'verdict'>>,
  now: () => number,
): AnchorReport {
  return {
    verdict,
    commit: null,
    dirtyPaths: [],
    dirtyCount: 0,
    targets: [],
    message: '',
    at: now(),
    ...patch,
  };
}

/**
 * Give the index a commit baseline, if — and only if — the tree can honestly carry one.
 *
 * Called after a successful `analyze`, so the manifest is expected to exist; a missing one
 * is reported rather than treated as an error.
 */
export async function anchorIndex(
  repoPath: string,
  options: AnchorOptions = {},
): Promise<AnchorReport> {
  const now = options.now ?? Date.now;
  const absRepo = path.resolve(repoPath);

  const meta = await readIndexMeta(absRepo);
  if (meta === null) {
    return report(
      'skipped',
      { message: '刷新完成，但没有找到索引清单（.gitnexus/gitnexus.json），没有写入提交基线。' },
      now,
    );
  }

  if (meta.lastCommit !== '') {
    return report(
      'already',
      {
        commit: meta.lastCommit,
        message:
          `索引已记录提交 ${shortSha(meta.lastCommit)}，无需改动。` +
          (meta.branch ? `（分支 ${meta.branch}）` : ''),
      },
      now,
    );
  }

  // A folder indexed with `--skip-git` has no commit to record, and telling the operator
  // the index is "unbaselined" because of a sandbox would be wrong there.
  if (options.skipGit === true || !hasGitMarker(absRepo)) {
    return report(
      'no-git',
      { message: '这个目录没有 git 仓库，索引不记录提交基线（与 gitnexus 的 --skip-git 行为一致）。' },
      now,
    );
  }

  const truth = await readGitTruth(absRepo, {
    ...(options.gitTimeoutMs === undefined ? {} : { gitTimeoutMs: options.gitTimeoutMs }),
  });

  if (truth.head === null) {
    return report(
      'no-git',
      { message: '这个仓库还没有提交（HEAD 不存在），索引无法记录提交基线。' },
      now,
    );
  }

  if (truth.dirtyPaths === null) {
    return report(
      'skipped',
      {
        commit: truth.head,
        message:
          '刷新完成，但读不到工作区状态（git 命令失败），无法判断能否记录提交基线 —— 没有写入。',
      },
      now,
    );
  }

  if (truth.dirtyPaths.length > 0) {
    const sample = truth.dirtyPaths.slice(0, DIRTY_SAMPLE).join('、');
    const more = truth.dirtyPaths.length > DIRTY_SAMPLE ? ` 等 ${truth.dirtyPaths.length} 个` : '';
    return report(
      'dirty',
      {
        commit: truth.head,
        dirtyPaths: truth.dirtyPaths.slice(0, DIRTY_SAMPLE),
        dirtyCount: truth.dirtyPaths.length,
        message:
          `刷新完成，但工作区还有未提交改动（${sample}${more}），所以没有写入提交基线 ——` +
          '索引里已经包含这些改动，把当前提交记上去会让门禁误报"已是最新"。提交后再刷新即可。',
      },
      now,
    );
  }

  const targets: AnchorTarget[] = [];
  for (const name of ['gitnexus.json', 'meta.json']) {
    const file = path.join(absRepo, '.gitnexus', name);
    try {
      await fs.access(file);
    } catch {
      continue;
    }
    targets.push(await writeManifestCommit(file, truth.head));
  }

  if (targets.some((target) => target.written)) {
    if (options.gitnexusHome !== undefined && options.gitnexusHome.trim() !== '') {
      targets.push(await writeRegistryCommit(options.gitnexusHome, absRepo, truth.head));
    }
    return report(
      'anchored',
      {
        commit: truth.head,
        targets,
        message:
          `已把提交 ${shortSha(truth.head)} 写入索引基线 —— 刷新门禁现在可以回答"已是最新"，` +
          '不必再去终端跑一次 analyze。',
      },
      now,
    );
  }

  const detail = targets.map((target) => `${path.basename(target.file)}：${target.detail ?? '未写入'}`);
  return report(
    'skipped',
    {
      commit: truth.head,
      targets,
      message: `刷新完成，但没能写入提交基线（${detail.join('；')}）。索引本身可用。`,
    },
    now,
  );
}
