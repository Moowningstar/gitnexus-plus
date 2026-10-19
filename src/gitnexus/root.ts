/**
 * Locate the installed GitNexus package and reuse its own scan primitives.
 *
 * WHY REUSE INSTEAD OF REIMPLEMENT
 * --------------------------------
 * "Which files did GitNexus skip?" has exactly one correct answer: the set
 * `walkRepositoryPaths` produced during `analyze`. Reimplementing that decision
 * here would drift from it silently — the plugin would report a large-file list
 * that no longer matches the index, and nothing would fail loudly.
 *
 * `gitnexus/package.json` declares no `exports` map, so its `dist/**` files are
 * deep-importable. That is what makes reuse possible; it is also why every entry
 * point below is guarded. If a future release closes the exports map or renames a
 * module, `loadScanPrimitives` returns `null` and the caller falls back to the
 * local scan (`./scan-fallback.js`) rather than throwing.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Deep paths inside the `gitnexus` package that this plugin depends on. */
const DIST = Object.freeze({
  walker: 'dist/core/ingestion/filesystem-walker.js',
  maxFileSize: 'dist/core/ingestion/utils/max-file-size.js',
  ignore: 'dist/config/ignore-service.js',
});

/** What a caller may say about where to look for the installed package. */
export interface RootDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
  discover?: boolean;
  /**
   * The prefix a panel-authorised install wrote to. Consulted before PATH and the
   * declared dependency, because it is the only copy whose version the plugin
   * chose — and, after an install from the panel, the only copy on the machine.
   */
  managedPrefix?: string;
}

/**
 * Candidate directories that may contain an installed `gitnexus` package.
 * Ordered most-specific first: an explicit override beats PATH discovery, which
 * beats a plain resolution from this package.
 *
 * Discovery always consults the real process environment for `PATH`, even when a
 * caller passes its own `env`. The `env` option governs *configuration*
 * (`GITNEXUS_MAX_FILE_SIZE`, `GITNEXUS_HOME`); which GitNexus is installed on this
 * machine is a fact about the machine, not a per-call setting, and letting a
 * sanitized env blank it out would silently downgrade every caller to the
 * fallback scan.
 *
 * @returns absolute candidate directories (not yet validated)
 */
function candidateRoots(options: RootDiscoveryOptions = {}): string[] {
  if (options.discover === false) return [];
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
  const roots: string[] = [];

  if (env.GITNEXUS_PACKAGE_ROOT) roots.push(env.GITNEXUS_PACKAGE_ROOT);

  // The copy this plugin installed. Ahead of PATH and the dependency because it is
  // the version the operator selected by installing; finding a different one later
  // would make the report describe a tree the refresh will not use.
  if (typeof options.managedPrefix === 'string' && options.managedPrefix !== '') {
    roots.push(path.join(options.managedPrefix, 'node_modules', 'gitnexus'));
  }

  // Probe every PATH entry for a sibling `node_modules/gitnexus` directly.
  //
  // Deliberately NOT "find the gitnexus shim, then derive its prefix": the shim
  // is `.ps1` under nvm4w, and `PATHEXT` on Windows does not list `.ps1`, so
  // shim-based discovery silently finds nothing on the very machines where the
  // CLI is most likely to be installed. Testing the directory is
  // extension-independent and needs no PATHEXT reasoning.
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    roots.push(path.join(dir, 'node_modules', 'gitnexus'));
    roots.push(path.join(dir, '..', 'node_modules', 'gitnexus'));
    roots.push(path.join(dir, '..', '..', 'node_modules', 'gitnexus'));
  }

  // nvm-for-windows keeps the real tree off PATH behind a junction.
  if (env.NVM_SYMLINK) roots.push(path.join(env.NVM_SYMLINK, 'node_modules', 'gitnexus'));
  if (env.NVM_HOME) roots.push(path.join(env.NVM_HOME, 'node_modules', 'gitnexus'));

  // Resolve from this package (a real dependency edge, if declared).
  try {
    const here = options.moduleUrl ? path.dirname(new URL(options.moduleUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1')) : undefined;
    const req = createRequire(here ? path.join(here, 'noop.js') : import.meta.url);
    roots.push(path.dirname(req.resolve('gitnexus/package.json')));
  } catch {
    /* not resolvable from here — the other candidates may still work */
  }

  return [...new Set(roots.map((r) => path.resolve(r)))];
}

/**
 * Resolve the GitNexus package root, or `null` when no usable install is found.
 */
export function findGitnexusRoot(options: RootDiscoveryOptions = {}): string | null {
  for (const root of candidateRoots(options)) {
    try {
      if (existsSync(path.join(root, 'package.json')) && existsSync(path.join(root, DIST.walker))) {
        return root;
      }
    } catch {
      /* unreadable candidate — keep looking */
    }
  }
  return null;
}

/**
 * Read the installed GitNexus version. Returned for provenance so a report can
 * state which analyzer produced the index it is judging.
 */
export function readGitnexusVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** The URL a deep-imported `dist` module is loaded from. */
const distUrl = (root: string, relative: string): string => pathToFileURL(path.join(root, relative)).href;

/** `walkRepositoryPaths(repoPath, onProgress?, options?)` — GitNexus's own walk. */
export type WalkRepositoryPaths = (
  repoPath: string,
  onProgress?: unknown,
  options?: object,
) => Promise<Array<{ path: string; size: number }>>;

/** `createIgnoreFilter(repoPath, options?)` — the matcher `glob` is handed. */
export type CreateIgnoreFilter = (repoPath: string, options?: object) => Promise<unknown>;

/** The slice of the `glob` package this plugin calls. */
export type GlobFunction = (pattern: string, options: object) => Promise<string[]>;

/** `dist/core/ingestion/filesystem-walker.js`, as far as this plugin reads it. */
interface FilesystemWalkerModule {
  walkRepositoryPaths?: WalkRepositoryPaths;
}

/** `dist/core/ingestion/utils/max-file-size.js`. */
interface MaxFileSizeModule {
  getMaxFileSizeBytes?: () => number;
  DEFAULT_MAX_FILE_SIZE_BYTES?: number;
  MAX_FILE_SIZE_UPPER_BOUND_BYTES?: number;
}

/** `dist/config/ignore-service.js`. */
interface IgnoreServiceModule {
  createIgnoreFilter?: CreateIgnoreFilter;
}

/**
 * The `glob` package as resolved from GitNexus's own dependency tree: a named
 * `glob` export, or a default export carrying one. The runtime guard below is
 * what decides; these shapes only say what the guard is looking for.
 */
interface GlobModule {
  glob?: GlobFunction;
  default?: GlobModule;
}

/**
 * The scan primitives this plugin reuses, all sourced from one GitNexus install.
 */
export interface ScanPrimitives {
  gitnexusRoot: string;
  gitnexusVersion: string | null;
  glob: GlobFunction;
  createIgnoreFilter: CreateIgnoreFilter;
  walkRepositoryPaths: WalkRepositoryPaths;
  getMaxFileSizeBytes: () => number;
  DEFAULT_MAX_FILE_SIZE_BYTES: number;
  MAX_FILE_SIZE_UPPER_BOUND_BYTES: number;
  source: 'gitnexus' | 'fallback';
}

/** What a caller may override when loading the primitives. */
export interface LoadScanPrimitivesOptions extends RootDiscoveryOptions {
  root?: string;
}

/**
 * Load GitNexus's own scan primitives by deep-importing its dist modules.
 *
 * Every exported member is validated before use: a partial or reshaped module
 * degrades to the fallback rather than producing a wrong answer.
 *
 * @returns `null` when reuse is not possible.
 */
export async function loadScanPrimitives(
  options: LoadScanPrimitivesOptions = {},
): Promise<ScanPrimitives | null> {
  const root = options.root ?? findGitnexusRoot(options);
  if (root === null) return null;

  try {
    const [walker, maxSize, ignore] = await Promise.all([
      import(distUrl(root, DIST.walker)) as Promise<FilesystemWalkerModule>,
      import(distUrl(root, DIST.maxFileSize)) as Promise<MaxFileSizeModule>,
      import(distUrl(root, DIST.ignore)) as Promise<IgnoreServiceModule>,
    ]);

    const createIgnoreFilter = ignore.createIgnoreFilter;
    const walkRepositoryPaths = walker.walkRepositoryPaths;
    const getMaxFileSizeBytes = maxSize.getMaxFileSizeBytes;
    const DEFAULT_MAX_FILE_SIZE_BYTES = maxSize.DEFAULT_MAX_FILE_SIZE_BYTES;

    if (
      typeof createIgnoreFilter !== 'function' ||
      typeof walkRepositoryPaths !== 'function' ||
      typeof getMaxFileSizeBytes !== 'function' ||
      typeof DEFAULT_MAX_FILE_SIZE_BYTES !== 'number'
    ) {
      return null;
    }

    // `glob` is resolved from GitNexus's own dependency tree so the version that
    // built the ignore filter is the version that consumes it.
    const req = createRequire(path.join(root, 'package.json'));
    const globModule = (await import(pathToFileURL(req.resolve('glob')).href)) as GlobModule;
    const glob = globModule.glob ?? globModule.default?.glob ?? globModule.default;
    if (typeof glob !== 'function') return null;

    return {
      gitnexusRoot: root,
      gitnexusVersion: readGitnexusVersion(root),
      glob,
      createIgnoreFilter,
      walkRepositoryPaths,
      getMaxFileSizeBytes,
      DEFAULT_MAX_FILE_SIZE_BYTES,
      MAX_FILE_SIZE_UPPER_BOUND_BYTES:
        typeof maxSize.MAX_FILE_SIZE_UPPER_BOUND_BYTES === 'number'
          ? maxSize.MAX_FILE_SIZE_UPPER_BOUND_BYTES
          : DEFAULT_MAX_FILE_SIZE_BYTES,
      source: 'gitnexus',
    };
  } catch {
    return null;
  }
}
