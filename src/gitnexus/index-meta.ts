/**
 * Read the on-disk GitNexus index metadata.
 *
 * `.gitnexus/gitnexus.json` is the only fully machine-readable artifact GitNexus
 * writes: the graph itself lives in a single LadybugDB file (`lbug`) and there is
 * no persisted graph JSON/CSV. Everything this plugin shows about an index that
 * is not the graph comes from here or from `~/.gitnexus/registry.json`.
 */

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Directory GitNexus keeps its global state in, honouring `GITNEXUS_HOME`. */
export function globalDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.GITNEXUS_HOME && env.GITNEXUS_HOME.trim() !== ''
    ? path.resolve(env.GITNEXUS_HOME)
    : path.join(os.homedir(), '.gitnexus');
}

/** The environment a caller may thread through instead of the real one. */
export interface RegistryOptions {
  env?: NodeJS.ProcessEnv;
}

/** The counters every manifest and registry entry carries. */
export interface IndexStats {
  files: number;
  nodes: number;
  edges: number;
  communities: number;
  processes: number;
  embeddings: number;
}

export interface RegistryEntry {
  name: string;
  path: string;
  storagePath: string;
  indexedAt: string;
  lastCommit: string;
  remoteUrl?: string;
  branch?: string;
  stats: IndexStats;
}

/**
 * Read the global registry. Never throws: an absent or malformed registry yields
 * an empty list, because "GitNexus has never run here" is a normal state.
 *
 * The registry is written by GitNexus, not by this plugin, so entries are taken
 * as written: the guard checks the one field a lookup needs (`path`) and nothing
 * else, exactly as the untyped revision did.
 */
export async function readRegistry(options: RegistryOptions = {}): Promise<RegistryEntry[]> {
  const file = path.join(globalDir(options.env ?? process.env), 'registry.json');
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry: unknown): entry is RegistryEntry =>
            Boolean(entry) && typeof (entry as { path?: unknown }).path === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * Normalize a path for comparison.
 *
 * Windows paths in the registry are not case-stable in practice — this machine's
 * registry holds both `D:\Project\...` and `D:\project\...` for the same tree.
 * Comparing raw strings would treat one repository as two.
 */
export function normalizePathKey(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Find the registry entry for a repository path or alias.
 *
 * @param target absolute path or registry alias
 */
export async function findRegistryEntry(
  target: string,
  options: RegistryOptions = {},
): Promise<RegistryEntry | null> {
  const entries = await readRegistry(options);
  const wanted = normalizePathKey(target);
  const byPath = entries.find((e) => {
    try {
      return normalizePathKey(e.path) === wanted;
    } catch {
      return false;
    }
  });
  if (byPath) return byPath;
  return entries.find((e) => e.name === target) ?? null;
}

/**
 * Whether a directory holds a GitNexus index.
 *
 * The panel shows the project the user is *in*, which need not appear in the global
 * registry at all — and a plugin that refused to describe the user's own working
 * directory because a global file elsewhere had not heard of it would be wrong.
 * This is not by itself the route bound any more: a git project with no index still
 * has a readable working tree, so the routes that need a graph use
 * {@link isProjectRoot}, which accepts either an index or a `.git` marker, and the
 * scan/delta routes use {@link isExistingDirectory}, which also accepts a plain
 * folder that GitNexus could index with `--skip-git`.
 */
export async function hasIndex(repoPath: string): Promise<boolean> {
  const dir = path.join(repoPath, '.gitnexus');
  for (const name of ['gitnexus.json', 'meta.json']) {
    try {
      await fs.access(path.join(dir, name));
      return true;
    } catch {
      /* try the next name */
    }
  }
  return false;
}

/**
 * Whether a directory carries a `.git` marker.
 *
 * `.git` may be a directory or a file (worktrees and submodules), so this checks
 * existence rather than type. The distinction matters to the maintenance commands:
 * GitNexus refuses to analyze a folder without a `.git` unless `--skip-git` is
 * passed, and it reports the resulting index as having no commit baseline.
 */
export function hasGitMarker(repoPath: string): boolean {
  try {
    return existsSync(path.join(repoPath, '.git'));
  } catch {
    return false;
  }
}

/**
 * Whether a directory is a project the read routes may describe.
 *
 * Deliberately wider than {@link hasIndex}: a git repository with no index still has
 * a readable working tree, and both the scan-only coverage report and the initialize
 * action are for exactly that state. A directory with neither an index nor a `.git`
 * marker is refused by the routes that need git or a graph (search, graph, file
 * history); the coverage and delta routes use {@link isExistingDirectory} instead,
 * because GitNexus can index a plain folder with `--skip-git`.
 */
export async function isProjectRoot(repoPath: string): Promise<boolean> {
  if (await hasIndex(repoPath)) return true;
  return hasGitMarker(repoPath);
}

/**
 * Whether a path is an existing directory.
 *
 * This is the bound for the scan-only coverage report and the delta gate. The panel
 * reports the working directory the operator is *in*, and that directory need not be
 * a git repository: GitNexus indexes any folder with `--skip-git`, and the scan and
 * the language breakdown need neither git nor an index. Refusing such a directory
 * left the panel with a raw 404 and no numbers at all — the reported bug.
 *
 * This is still not a directory listing: the route describes exactly the path it is
 * given and offers no way to browse a parent or a sibling. Filesystem roots are
 * excluded by {@link isFilesystemRoot}, because scanning a whole drive is not a
 * project report.
 */
export async function isExistingDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a path is a filesystem root (`D:\`, `/`, a UNC share root). */
export function isFilesystemRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return path.dirname(resolved) === resolved;
}

/** `indexCoverage` as the `analyze` that produced the index wrote it. */
export interface RawIndexCoverage {
  maxFileSizeBytes?: unknown;
  dirtyPaths?: unknown;
  [key: string]: unknown;
}

/** `runnerIdentity`, the analyzer-provenance receipt (schema v4). */
export interface RunnerIdentity {
  cliVersion?: string;
  [key: string]: unknown;
}

/**
 * The budgets the process detector ran under, as the analyzer recorded them.
 *
 * Every field is nullable on purpose: `maxProcesses: null` means "the flow count was
 * not clamped by a process budget", which is not the same as "the detector found
 * every flow" — branching and entry-point budgets can still drop flows. Absent
 * manifests (1.6.12) have no block at all, and callers must treat that as unknown
 * rather than as an absence of limits.
 */
export interface ProcessDetection {
  /** Null when the flow count was not capped. */
  maxProcesses: number | null;
  /** Branches explored per symbol during trace; every skipped branch is a dropped flow. */
  maxProcessBranching: number | null;
  /** Trace depth cap; deeper chains are cut. */
  maxProcessTraceDepth: number | null;
  /** Entry points considered for ranking; the rest never enter the ranking at all. */
  maxEntryPointCandidates: number | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Parse `processDetection` from a manifest.
 *
 * A newer manifest may carry a partial block; a missing field stays `null` rather
 * than being defaulted to 0, because 0 would read as "no budget" and 0 flows. The
 * block itself is only reported as present when it is an object — 1.6.12 writes no
 * block at all, and the caller must keep that distinction.
 */
export function readProcessDetection(raw: unknown): ProcessDetection | null {
  if (raw === null || typeof raw !== 'object') return null;
  const detection = raw as Record<string, unknown>;
  return {
    maxProcesses: numberOrNull(detection.maxProcesses),
    maxProcessBranching: numberOrNull(detection.maxProcessBranching),
    maxProcessTraceDepth: numberOrNull(detection.maxProcessTraceDepth),
    maxEntryPointCandidates: numberOrNull(detection.maxEntryPointCandidates),
  };
}


/**
 * The parsed manifest, as far as this plugin reads it.
 *
 * Named fields are the ones read here or in the report built from them; the index
 * signature carries the rest of a manifest GitNexus is free to extend, so a newer
 * manifest stays readable without a change here. Nothing in this file validates
 * the manifest — a field of the wrong type is reported as absent, not repaired.
 */
export interface RawIndexManifest {
  storagePath?: unknown;
  repoPath?: unknown;
  indexedAt?: unknown;
  lastCommit?: unknown;
  branch?: unknown;
  stats?: IndexStats;
  fileHashes?: Record<string, unknown> | null;
  indexCoverage?: RawIndexCoverage | null;
  capabilities?: Record<string, unknown>;
  schemaFingerprint?: unknown;
  runnerIdentity?: RunnerIdentity;
  remoteUrl?: string;
  contentRetention?: string | null;
  ftsProfile?: string | null;
  analysisFeatures?: Record<string, number>;
  crossLanguageProperties?: unknown[];
  unresolvedReceiverMembers?: unknown;
  /** Present on 1.6.13+; absent on 1.6.12, where it must stay unknown. */
  processDetection?: unknown;
  [key: string]: unknown;
}

export interface IndexMeta {
  /** which of the two manifest names the values came from */
  metaFile: string | null;
  storagePath: string;
  repoPath: string;
  indexedAt: string;
  lastCommit: string;
  branch?: string;
  stats: IndexStats;
  /** repo-relative path -> sha256 */
  fileHashes: Record<string, string>;
  /** size cap in force when the index was written */
  coverageMaxFileSizeBytes: number | null;
  /** files that were dirty vs HEAD when indexed */
  dirtyPaths: string[];
  capabilities: Record<string, unknown>;
  schemaFingerprint?: string;
  runnerIdentity?: RunnerIdentity;
  /** Process-detection budgets, or null when the manifest predates the field. */
  processDetection: ProcessDetection | null;
  /** the full parsed manifest */
  raw: RawIndexManifest;
}

/**
 * Read the index manifest for a repository.
 *
 * Two file names exist in the wild and both must be honoured:
 *
 *   `gitnexus.json` — current format, written by the `analyze` that produced the
 *                     index. Carries `indexCoverage`, `storagePath`, `branch`,
 *                     `runnerIdentity` on top of the shared fields.
 *   `meta.json`     — the older name, still present on indexes built by earlier
 *                     releases. Observed on this machine holding a 28 536-entry
 *                     `fileHashes` with **no** `indexCoverage` at all.
 *
 * Reading only `gitnexus.json` makes the tool report a perfectly good 28k-file
 * index as "not indexed" — which is how this fallback came to exist. Absent
 * coverage fields are reported as absent (`null`), never defaulted: claiming a cap
 * the index never recorded would misattribute files as "skipped".
 *
 * @param repoPath absolute repository root
 * @returns `null` when the repository is not indexed.
 */
export async function readIndexMeta(repoPath: string): Promise<IndexMeta | null> {
  const dir = path.join(repoPath, '.gitnexus');
  let raw: RawIndexManifest | null = null;
  let source: string | null = null;
  for (const name of ['gitnexus.json', 'meta.json']) {
    try {
      raw = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as RawIndexManifest;
      source = name;
      break;
    } catch {
      /* try the next name */
    }
  }
  if (raw === null) return null;

  const fileHashes: Record<string, string> = {};
  if (raw.fileHashes && typeof raw.fileHashes === 'object') {
    for (const [key, value] of Object.entries(raw.fileHashes)) {
      if (typeof value === 'string') fileHashes[key.replace(/\\/g, '/')] = value;
    }
  }

  const coverage = raw.indexCoverage;

  return {
    metaFile: source,
    storagePath: typeof raw.storagePath === 'string' ? raw.storagePath : path.join(repoPath, '.gitnexus'),
    repoPath: typeof raw.repoPath === 'string' ? raw.repoPath : repoPath,
    indexedAt: typeof raw.indexedAt === 'string' ? raw.indexedAt : '',
    lastCommit: typeof raw.lastCommit === 'string' ? raw.lastCommit : '',
    branch: typeof raw.branch === 'string' ? raw.branch : undefined,
    stats: raw.stats ?? { files: 0, nodes: 0, edges: 0, communities: 0, processes: 0, embeddings: 0 },
    fileHashes,
    // Absent on indexes written before this field existed — callers must not
    // invent a cap when it is missing.
    coverageMaxFileSizeBytes:
      coverage && typeof coverage.maxFileSizeBytes === 'number' ? coverage.maxFileSizeBytes : null,
    dirtyPaths: Array.isArray(coverage?.dirtyPaths) ? (coverage.dirtyPaths as string[]) : [],
    capabilities: raw.capabilities ?? {},
    schemaFingerprint: typeof raw.schemaFingerprint === 'string' ? raw.schemaFingerprint : undefined,
    runnerIdentity: raw.runnerIdentity,
    processDetection: readProcessDetection(raw.processDetection),
    raw,
  };
}
