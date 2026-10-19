/**
 * Reproduce GitNexus's scan decision and expose what it discards.
 *
 * `walkRepositoryPaths` (gitnexus/dist/core/ingestion/filesystem-walker.js)
 * makes three cuts and only returns the survivors:
 *
 *   1. `glob(recursive, { nodir: true, dot: false, ignore: createIgnoreFilter(repo) })`
 *      — drops dotfiles (`dot: false`) and anything the ignore rules match.
 *   2. `stat.size > maxFileSizeBytes` — the large-file cut. **Counted and logged
 *      but never returned**, so an external tool cannot see it.
 *   3. `.d.ts` / `.d.mts` / `.d.cts` whose same-stem implementation was also
 *      scanned — suppressed as redundant.
 *
 * This module applies cuts 1 and 3 exactly as upstream does (reusing upstream's
 * own `createIgnoreFilter` and glob), and turns cut 2 — the one that is invisible
 * from outside — into data.
 *
 * Deliberate duplication: the single `glob(...)` call below mirrors
 * `filesystem-walker.js:62-67`. It is four lines and must stay in lockstep with
 * upstream. If it ever drifts, `test/run.mjs` catches it by cross-checking the
 * reported large-file count against what `analyze` itself prints.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { loadScanPrimitives, type ScanPrimitives } from './root.js';

/** Mirrors DECLARATION_COMPANION_SUFFIXES in filesystem-walker.js. */
const DECLARATION_COMPANION_SUFFIXES: readonly DeclarationCompanion[] = Object.freeze([
  { declaration: '.d.ts', implementations: ['.ts', '.tsx'] },
  { declaration: '.d.mts', implementations: ['.mts'] },
  { declaration: '.d.cts', implementations: ['.cts'] },
]);

/** One entry of `DECLARATION_COMPANION_SUFFIXES`. */
interface DeclarationCompanion {
  declaration: string;
  implementations: string[];
}

/** Bounded concurrency for `fs.stat`, matching GitNexus's READ_CONCURRENCY. */
const STAT_CONCURRENCY = 32;

/** One file the scan walked. */
export interface ScannedFile {
  /** repo-relative, forward slashes */
  path: string;
  /** bytes */
  size: number;
}

/** Where the effective size cap came from. */
export type CapSource = 'env' | 'default' | 'index';

/** What {@link scanRepository} reports: the survivors plus all three cuts as data. */
export interface ScanReport {
  /** files GitNexus would hand to the pipeline */
  selected: ScannedFile[];
  /** files dropped by the size cap, largest first */
  large: ScannedFile[];
  /** `.d.ts` dropped as redundant */
  suppressedDeclarations: ScannedFile[];
  /** files that survived the ignore/dotfile cut */
  scannedCount: number;
  /** the effective size cap */
  capBytes: number;
  /** the shipped default */
  defaultCapBytes: number;
  /** where the effective cap came from */
  capSource: CapSource;
  /** hard tree-sitter ceiling */
  maxCapBytes: number;
  gitnexusVersion: string;
  /** reused upstream primitives or a local glob */
  primitives: 'gitnexus' | 'fallback';
}

/**
 * @returns entries minus redundant declaration files
 */
function dropRedundantDeclarations(entries: ScannedFile[]): ScannedFile[] {
  const scannedPaths = new Set(entries.map((e) => e.path));
  return entries.filter((entry) => {
    const companion = DECLARATION_COMPANION_SUFFIXES.find(({ declaration }) =>
      entry.path.endsWith(declaration),
    );
    if (!companion) return true;
    const stem = entry.path.slice(0, -companion.declaration.length);
    const redundant = companion.implementations.some((suffix) => scannedPaths.has(`${stem}${suffix}`));
    return !redundant;
  });
}

function redundantDeclarations(entries: ScannedFile[], selectedPaths: string[]): ScannedFile[] {
  const kept = new Set(selectedPaths);
  return entries.filter((e) => !kept.has(e.path));
}

/**
 * Run a batched `fs.stat` over repo-relative paths.
 * Unreadable files are skipped rather than failing the scan: a file that
 * disappears mid-scan is normal, not an error.
 */
async function statAll(
  repoPath: string,
  relativePaths: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  for (let i = 0; i < relativePaths.length; i += STAT_CONCURRENCY) {
    const batch = relativePaths.slice(i, i + STAT_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (relativePath) => {
        const stat = await fs.stat(path.join(repoPath, relativePath));
        return { path: relativePath.replace(/\\/g, '/'), size: stat.size };
      }),
    );
    for (const result of settled) {
      if (result.status === 'fulfilled') out.push(result.value);
    }
    onProgress?.(Math.min(i + batch.length, relativePaths.length), relativePaths.length);
  }
  return out;
}

/**
 * Scan a repository the way GitNexus does, and report the size cut as data.
 *
 * @param repoPath absolute path to the repository root
 * @param options `capBytes` overrides the cap (used when the index records its own coverage
 *   policy); otherwise `GITNEXUS_MAX_FILE_SIZE` decides, as it does for `analyze`.
 */
export async function scanRepository(
  repoPath: string,
  options: {
    capBytes?: number;
    env?: NodeJS.ProcessEnv;
    primitives?: ScanPrimitives | null;
    managedPrefix?: string;
    /** Called after each stat batch with the number of files examined. */
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<ScanReport> {
  const env = options.env ?? process.env;
  const primitives =
    options.primitives === undefined
      ? await loadScanPrimitives({ env, managedPrefix: options.managedPrefix })
      : options.primitives;

  const defaultCapBytes = primitives?.DEFAULT_MAX_FILE_SIZE_BYTES ?? 512 * 1024;
  const maxCapBytes = primitives?.MAX_FILE_SIZE_UPPER_BOUND_BYTES ?? 32 * 1024 * 1024;

  let capBytes: number;
  let capSource: CapSource;

  if (typeof options.capBytes === 'number' && Number.isFinite(options.capBytes) && options.capBytes > 0) {
    capBytes = Math.min(options.capBytes, maxCapBytes);
    capSource = 'index';
  } else if (primitives) {
    capBytes = Math.min(primitives.getMaxFileSizeBytes(), maxCapBytes);
    capSource = env.GITNEXUS_MAX_FILE_SIZE ? 'env' : 'default';
  } else {
    const parsed = Number(env.GITNEXUS_MAX_FILE_SIZE);
    const valid = Number.isInteger(parsed) && parsed > 0;
    capBytes = valid ? Math.min(parsed * 1024, maxCapBytes) : defaultCapBytes;
    capSource = valid ? 'env' : 'default';
  }

  let matched: string[];
  if (primitives) {
    // Upstream's own filter and glob options, verbatim.
    const ignoreFilter = await primitives.createIgnoreFilter(repoPath);
    matched = await primitives.glob('**/*', {
      cwd: repoPath,
      nodir: true,
      dot: false,
      ignore: ignoreFilter,
    });
  } else {
    matched = await fallbackWalk(repoPath);
  }

  const scanned = await statAll(repoPath, matched, options.onProgress);
  scanned.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const large: ScannedFile[] = [];
  const withinCap: ScannedFile[] = [];
  for (const file of scanned) {
    if (file.size > capBytes) large.push(file);
    else withinCap.push(file);
  }

  const selected = dropRedundantDeclarations(withinCap);
  const suppressed = redundantDeclarations(withinCap, selected.map((f) => f.path));
  large.sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1));

  return {
    selected,
    large,
    suppressedDeclarations: suppressed,
    scannedCount: scanned.length,
    capBytes,
    defaultCapBytes,
    capSource,
    maxCapBytes,
    gitnexusVersion: primitives?.gitnexusVersion ?? 'unknown',
    primitives: primitives ? 'gitnexus' : 'fallback',
  };
}

/**
 * Minimal `.gitignore`-style matcher used **only** when GitNexus's ignore service
 * cannot be loaded.
 *
 * This is an approximation and is labelled as one wherever it surfaces
 * (`ScanReport.primitives === 'fallback'`). It deliberately does not implement
 * negation: refusing to un-ignore a file can over-report exclusions, whereas
 * honouring `!` incorrectly would under-report skipped large files — and the
 * second error is the one this tool exists to prevent.
 *
 * @param pattern a gitignore line, already trimmed
 */
function compileIgnorePattern(pattern: string): (segments: string[]) => boolean {
  const cleaned = pattern.replace(/^\//, '').replace(/\/+$/, '');
  const parts = cleaned.split('/').filter((p) => p !== '');
  const toSegmentRegex = (segment: string): RegExp =>
    new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`, 'i');

  return (segments: string[]): boolean => {
    // A pattern with no slash matches a basename at any depth; a pattern with one
    // is anchored to the repository root (gitignore's own rule).
    if (parts.length === 1) {
      const re = toSegmentRegex(parts[0]);
      return segments.some((s) => re.test(s));
    }
    // `**` spans any number of segments; expand it greedily by simple recursion.
    const matchFrom = (pi: number, si: number): boolean => {
      if (pi === parts.length) return true;
      if (si > segments.length) return false;
      if (parts[pi] === '**') {
        for (let skip = si; skip <= segments.length; skip += 1) {
          if (matchFrom(pi + 1, skip)) return true;
        }
        return false;
      }
      if (si === segments.length) return false;
      return toSegmentRegex(parts[pi]).test(segments[si]) && matchFrom(pi + 1, si + 1);
    };
    return parts[0] === '**' ? matchFrom(0, 0) : matchFrom(0, 0);
  };
}

/**
 * Read `.gitignore` and `.gitnexusignore` into predicates, plus the two
 * directories GitNexus always ignores.
 */
async function loadFallbackRules(repoPath: string): Promise<Array<(segments: string[]) => boolean>> {
  const matchers = [compileIgnorePattern('node_modules'), compileIgnorePattern('.git')];
  for (const name of ['.gitignore', '.gitnexusignore']) {
    let text: string;
    try {
      text = await fs.readFile(path.join(repoPath, name), 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
      matchers.push(compileIgnorePattern(line));
    }
  }
  return matchers;
}

/** One directory in the fallback walk's queue. */
interface WalkDir {
  abs: string;
  rel: string[];
}

/**
 * Dependency-free fallback walk, used only when GitNexus's `glob` cannot be
 * resolved. Mirrors two upstream behaviours that are easy to get wrong:
 *
 *   - `dot: false` — a path is excluded when *any* segment begins with `.`,
 *     which is why `.github/workflows/ci.yml` never reaches the pipeline.
 *   - directories matched by the ignore rules prune their whole subtree.
 *
 * @returns repo-relative paths, forward slashes
 */
async function fallbackWalk(repoPath: string): Promise<string[]> {
  const rules = await loadFallbackRules(repoPath);
  const ignored = (segments: string[]): boolean => rules.some((rule) => rule(segments));

  const out: string[] = [];
  const queue: WalkDir[] = [{ abs: repoPath, rel: [] }];

  while (queue.length > 0) {
    const dir = queue.pop() as WalkDir;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // dot: false
      const segments = [...dir.rel, entry.name];
      if (ignored(segments)) continue;
      const abs = path.join(dir.abs, entry.name);
      if (entry.isDirectory()) {
        queue.push({ abs, rel: segments });
      } else if (entry.isFile()) {
        out.push(segments.join('/'));
      }
    }
  }
  return out;
}
