/**
 * The two git facts the panel needs, read without a shell.
 *
 * Deliberately not `exec`: a repository path is caller-supplied, and the only way
 * to keep it from becoming an argument is to pass it as `cwd` and never as part of
 * a command string. No shell is spawned, so nothing in the path can be
 * interpreted.
 *
 * Both calls are bounded and both fail soft. A repository with no commits, a
 * detached worktree, or no git at all is a normal state for an index that still
 * has a valid manifest — the panel should say "unknown", not refuse to render.
 */

import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

/** What the promisified `execFile` resolves to once stdout is decoded as text. */
interface ExecFileTextResult {
  stdout: string;
  stderr: string;
}

/**
 * `execFile`, promisified.
 *
 * The assertion picks out the text-encoding result: no `encoding` is passed, so
 * Node decodes stdout as UTF-8, and the `Buffer` arm the generic overload admits
 * is one this call never takes.
 */
const run = promisify(execFile) as (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<ExecFileTextResult>;

/** Short cap: `rev-parse` and `status` on a large repo are fast, and a hang here
 *  would block the whole panel for a value that is merely informative. */
const TIMEOUT_MS = 8000;

/**
 * @returns trimmed stdout, or null on any failure
 */
async function git(repoPath: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, {
      cwd: repoPath,
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * How far each side has moved from the other, as `rev-list --left-right --count`
 * reports it: commits the indexed commit has that HEAD does not, and the reverse.
 */
export interface AheadBehind {
  /** commits the index side has that HEAD does not */
  behind: number;
  /** commits HEAD has that the index side does not */
  ahead: number;
}

export interface GitState {
  /** git answered at all */
  available: boolean;
  /** full sha of HEAD */
  headCommit: string | null;
  /** current branch, or null when detached */
  branch: string | null;
  /** tracked modifications plus untracked files */
  dirtyCount: number | null;
  /** commits ahead/behind the indexed commit */
  aheadBehind: AheadBehind | null;
}

/**
 * Read HEAD, branch and working-tree dirtiness.
 *
 * @returns the state, with every unanswerable field left `null`
 */
export async function readGitState(
  repoPath: string,
  indexedCommit: string | null = null,
): Promise<GitState> {
  const head = await git(repoPath, ['rev-parse', 'HEAD']);
  if (head === null) {
    return {
      available: false,
      headCommit: null,
      branch: null,
      dirtyCount: null,
      aheadBehind: null,
    };
  }

  const [branchRaw, statusRaw] = await Promise.all([
    git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repoPath, ['status', '--porcelain']),
  ]);

  let dirtyCount: number | null = null;
  if (statusRaw !== null) {
    dirtyCount = statusRaw.split('\n').filter((line) => line.trim() !== '').length;
  }

  // How far HEAD has moved from the indexed commit, when both are known. Counted
  // in one direction only: what matters for staleness is whether the index is
  // behind, and a diverged history is reported as such rather than counted.
  let aheadBehind: AheadBehind | null = null;
  const indexed = typeof indexedCommit === 'string' && indexedCommit !== '' ? indexedCommit : null;
  if (indexed !== null) {
    const counts = await git(repoPath, ['rev-list', '--left-right', '--count', `${indexed}...HEAD`]);
    if (counts !== null) {
      const [behind, ahead] = counts.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
      if (Number.isFinite(behind) && Number.isFinite(ahead)) aheadBehind = { behind, ahead };
    }
  }

  return {
    available: true,
    headCommit: head.trim(),
    branch: branchRaw === null ? null : branchRaw.trim() === 'HEAD' ? null : branchRaw.trim(),
    dirtyCount,
    aheadBehind,
  };
}

/** The states {@link classifyStaleness} can report. */
export type StalenessState = 'current' | 'behind' | 'diverged' | 'unknown';

/** What {@link classifyStaleness} judges: the indexed commit and the live git state. */
export interface StalenessInput {
  lastCommit: string | null;
  git: GitState;
}

/**
 * Classify staleness the way `gitnexus status` does, so the panel and the CLI
 * cannot disagree.
 *
 * READING `rev-list --left-right --count <indexed>...<HEAD>`
 * ---------------------------------------------------------
 * The output is `<left> <right>`: commits reachable from the first ref but not the
 * second, then the reverse. With the indexed commit first:
 *
 *   left  = commits the INDEX has that HEAD does not  → histories have split
 *   right = commits HEAD has that the index does not  → how far the index lags
 *
 * So a linear fast-forward is `left = 0, right = N`: the index is simply N commits
 * behind, and calling that "diverged" is wrong. Divergence requires `left > 0` —
 * the indexed commit carries work that HEAD no longer reaches, which is when the
 * distance between them stops measuring how stale the index is.
 *
 * A first revision had this exactly backwards, and the panel told an operator their
 * index had diverged when it was one ordinary commit behind. The condition is
 * asserted in both directions by `test/run.mjs` for that reason.
 */
export function classifyStaleness({ lastCommit, git }: StalenessInput): StalenessState {
  if (!git.available || git.headCommit === null) return 'unknown';
  if (typeof lastCommit !== 'string' || lastCommit === '') return 'unknown';
  if (git.headCommit === lastCommit) return 'current';
  if (git.aheadBehind === null) return 'unknown';
  // `left > 0` means the indexed commit holds commits HEAD does not reach.
  return git.aheadBehind.behind > 0 ? 'diverged' : 'behind';
}
