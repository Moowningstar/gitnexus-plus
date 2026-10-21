/**
 * Find the GitNexus indexes under a workspace.
 *
 * WHY SEARCH BELOW THE WORKSPACE
 * ------------------------------
 * The panel reports the project the operator is *in*, and on this machine that is
 * often a container rather than a repository: `D:\Project\geo` holds `admin/`,
 * `backend/`, `frontend/` and others, any one of which may be the tree GitNexus
 * indexed. Requiring the workspace itself to carry `.gitnexus` made the panel answer
 * a workspace-shaped path with a 404 and no numbers at all.
 *
 * So the search starts at the workspace and walks down breadth-first. Every directory
 * carrying a readable manifest becomes a candidate; an indexed directory is a project
 * boundary, so the walk does not descend into its source tree (the project's own
 * subdirectories are not separate projects). The caller decides which candidate is
 * active; this module only reports them, ordered so the nearest complete index is
 * first.
 *
 * The walk is bounded (depth, directory count, wall clock) because a workspace can be
 * a home directory or a drive. Dependency and build directories are skipped by name,
 * hidden directories are skipped wholesale, and symlinks are not followed, so the
 * walk cannot leave the workspace or loop.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readIndexMeta } from './index-meta.js';

/** One project found under the workspace. */
export interface ProjectCandidate {
  /** Absolute directory carrying `.gitnexus` or `.git`. */
  path: string;
  /** Basename, for a compact switcher label. */
  name: string;
  /** Path relative to the workspace; empty for the workspace itself. */
  relPath: string;
  /**
   * `index` — a readable GitNexus manifest;
   * `git` — a git repository without an index;
   * `workspace` — the workspace itself, with neither.
   */
  kind: 'index' | 'git' | 'workspace';
  /** Whether the directory carries a `.git` marker. */
  hasGit: boolean;
  /** Whether this is the workspace itself or a descendant. */
  direction: 'self' | 'descendant';
  /** Distance below the workspace; 0 for the workspace itself. */
  depth: number;
  indexedAt: string | null;
  lastCommit: string | null;
  branch: string | null;
  /** The manifest's counters, when it recorded them. */
  stats: {
    files: number;
    nodes: number;
    edges: number;
    communities: number;
    processes: number;
    embeddings: number;
  } | null;
  /** Whether the graph store is present, not just the manifest. */
  complete: boolean;
  /** Which manifest the values came from. */
  metaFile: string | null;
}

/** The result of one workspace search. */
export interface ProjectSearchResult {
  root: string;
  projects: ProjectCandidate[];
  /** Directories examined, including the root. */
  visited: number;
  /** Whether a depth/count/time bound stopped the walk early. */
  truncated: boolean;
}

export interface ProjectSearchOptions {
  /** How many directory levels below the root to inspect. */
  maxDepth?: number;
  /** Hard cap on directories examined. */
  maxDirectories?: number;
  /** Wall-clock budget for the whole search. */
  timeoutMs?: number;
  /** Injectable clock, so a test can prove the budget is enforced. */
  now?: () => number;
}

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_DIRECTORIES = 4000;
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Directories that never hold the project the operator opened.
 *
 * Lower-cased because Windows paths are case-insensitive and a dependency tree can be
 * named `Node_Modules` on a case-sensitive filesystem mounted there.
 */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'output',
  'target',
  'bin',
  'obj',
  'coverage',
  'tmp',
  'temp',
  'logs',
  'venv',
  'env',
  '__pycache__',
]);

/** A directory the walk may enter: real directory, not hidden, not a dependency tree. */
function isSearchableDirectory(entry: { name: string; isDirectory(): boolean }): boolean {
  if (!entry.isDirectory()) return false;
  if (entry.name.startsWith('.')) return false;
  return !SKIP_DIRECTORIES.has(entry.name.toLowerCase());
}

/** Whether the graph store exists beside the manifest. */
function hasGraphStore(dir: string): boolean {
  try {
    return existsSync(path.join(dir, '.gitnexus', 'lbug'));
  } catch {
    return false;
  }
}

/**
 * Rank candidates for display and for a default selection.
 *
 * The workspace itself comes first; indexed projects before unindexed git repositories;
 * a complete index before one whose graph store is missing; the more recently indexed
 * project before an older one; the path is the final deterministic tie-break.
 */
function rankProjects(a: ProjectCandidate, b: ProjectCandidate): number {
  if (a.direction !== b.direction) return a.direction === 'self' ? -1 : 1;
  const kindRank = (project: ProjectCandidate): number =>
    project.kind === 'index' ? 0 : project.kind === 'git' ? 1 : 2;
  if (kindRank(a) !== kindRank(b)) return kindRank(a) - kindRank(b);
  if (a.depth !== b.depth) return a.depth - b.depth;
  if (a.complete !== b.complete) return a.complete ? -1 : 1;
  const aAt = a.indexedAt ?? '';
  const bAt = b.indexedAt ?? '';
  if (aAt !== bAt) return aAt < bAt ? 1 : -1;
  return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
}

/**
 * Find every project at or below `root`: indexed directories, git repositories without
 * an index, and the workspace itself when it is only a container.
 *
 * Never throws: an unreadable directory is skipped. The caller decides what each kind
 * means; the panel shows unindexed git projects so they can be initialized instead of
 * reporting a bare "no index" for a workspace that clearly has subprojects.
 *
 * @param root absolute working directory to search from
 */
export async function findIndexProjects(
  root: string,
  options: ProjectSearchOptions = {},
): Promise<ProjectSearchResult> {
  const absolute = path.resolve(root);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const startedAt = now();

  const queue: Array<{ dir: string; depth: number }> = [{ dir: absolute, depth: 0 }];
  let head = 0;
  let visited = 0;
  let truncated = false;
  const projects: ProjectCandidate[] = [];

  while (head < queue.length) {
    if (now() - startedAt > timeoutMs) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue[head];
    head += 1;
    visited += 1;
    if (visited > maxDirectories) {
      truncated = true;
      break;
    }

    const meta = await readIndexMeta(dir);
    const hasGit = existsSync(path.join(dir, '.git'));
    if (meta !== null) {
      projects.push({
        path: dir,
        name: path.basename(dir),
        relPath: path.relative(absolute, dir).replace(/\\/g, '/'),
        kind: 'index',
        hasGit,
        direction: dir === absolute ? 'self' : 'descendant',
        depth,
        indexedAt: meta.indexedAt === '' ? null : meta.indexedAt,
        lastCommit: meta.lastCommit === '' ? null : meta.lastCommit,
        branch: meta.branch ?? null,
        stats: meta.stats ?? null,
        complete: hasGraphStore(dir),
        metaFile: meta.metaFile,
      });
      // A project boundary: its own subdirectories are source, not sibling projects.
      continue;
    }

    if (hasGit) {
      projects.push({
        path: dir,
        name: path.basename(dir),
        relPath: path.relative(absolute, dir).replace(/\\/g, '/'),
        kind: 'git',
        hasGit: true,
        direction: dir === absolute ? 'self' : 'descendant',
        depth,
        indexedAt: null,
        lastCommit: null,
        branch: null,
        stats: null,
        complete: false,
        metaFile: null,
      });
      // A git project without an index is still a project: its source is not a set of
      // sibling projects. It appears in the switcher so the operator can initialize it.
      continue;
    }

    if (dir === absolute) {
      projects.push({
        path: dir,
        name: path.basename(dir),
        relPath: '',
        kind: 'workspace',
        hasGit: false,
        direction: 'self',
        depth: 0,
        indexedAt: null,
        lastCommit: null,
        branch: null,
        stats: null,
        complete: false,
        metaFile: null,
      });
      // The workspace is a container; keep walking for its indexed/git children.
    }

    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    if (depth >= maxDepth) {
      // Nothing is enqueued at the cap; say so only when there was something to skip.
      if (entries.some(isSearchableDirectory)) truncated = true;
      continue;
    }

    // Sorted for a deterministic answer when several siblings carry an index; the
    // order is only a tie-break, because breadth-first already prefers the nearest.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!isSearchableDirectory(entry)) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }

  projects.sort(rankProjects);
  return { root: absolute, projects, visited, truncated };
}
