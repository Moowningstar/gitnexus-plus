/**
 * The paths GitNexus itself writes inside a repository.
 *
 * `gitnexus analyze` regenerates its own agent-facing documents — `AGENTS.md`,
 * `CLAUDE.md`, the `.claude`/`.cursor`/`.agents` skill trees — unless it is run with
 * `--index-only`. Those files are therefore *output* of an analyze, not input, and a
 * refresh that compares the working tree against the index snapshot will otherwise
 * report them as changed and ask for another refresh forever.
 *
 * Upstream reached the same conclusion (#1233, "the index looks stale the moment it is
 * written") and ships the same list in `gitnexus/storage/gitnexus-managed-paths.js`.
 * This module is a copy rather than an import on purpose: the plugin may run against any
 * 1.6.x, and a list that silently lost an entry would show up as a refresh loop rather
 * than as a broken import.
 *
 * `.gitnexus/` is on the list and is also excluded separately by the callers that walk
 * git output, because its contents are the index itself.
 */

/** Repository-root-relative names GitNexus owns, in the form `git` reports them. */
export const GITNEXUS_MANAGED_PATHS = [
  '.gitnexus',
  '.claude',
  '.cursor',
  '.agents',
  'AGENTS.md',
  'CLAUDE.md',
] as const;

/**
 * Normalize a repository-relative path for comparison.
 *
 * `git` reports forward slashes on every platform, but paths also reach these helpers
 * from callers that built them with `path.join` on Windows — and the two forms must not
 * be compared raw, or `CLAUDE.md` and `.claude\skills` would both slip through.
 */
function repoKey(candidate: string): string {
  return candidate.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Whether a repository-relative path belongs to a file GitNexus writes.
 *
 * Matches the path itself and anything beneath it: `.claude` covers `.claude/skills/x.md`.
 * A sibling that merely shares a prefix (`.clauderc`, `AGENTS.md.bak`) is *not* managed —
 * a prefix match there would hide real operator edits.
 */
export function isGitNexusManagedPath(candidate: string): boolean {
  const key = repoKey(candidate);
  if (key === '') return false;
  for (const managed of GITNEXUS_MANAGED_PATHS) {
    if (key === managed || key.startsWith(`${managed}/`)) return true;
  }
  return false;
}
