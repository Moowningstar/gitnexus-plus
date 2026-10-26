/**
 * Language classification for a file path, reusing GitNexus's own detector.
 *
 * `gitnexus-shared` is not published separately, but `analyze` bundles it into
 * `gitnexus/dist/_shared/`. Importing that copy is deliberate: the detector that
 * classified the files *in an existing index* is the one that must classify them
 * in the report. Copying the map from source would be wrong — the installed
 * detector tracks the checkout it shipped from, not the one this plugin was written
 * against: `.ipynb` resolves to `null` on 1.6.12 and to `python` on 1.6.13, so the
 * same file lands in a different row depending on which GitNexus built the index.
 * Such gaps are invisible until a percentage looks odd.
 *
 * Three classes, because "is this file in the graph as code?" has three answers:
 *
 *   parsed     — GitNexus has a LanguageProvider; symbols inside become graph nodes.
 *   recognized — known format, no parser; the file exists as a `File` node only.
 *   other      — not recognised at all.
 *
 * This is the distinction GitHub's language bar cannot express, and it is what
 * makes the widget answer "how much of my repository does GitNexus actually
 * understand?" rather than merely "what is this repo written in?".
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findGitnexusRoot } from './root.js';
import type { ScannedFile } from './scan.js';

/** Which of the three classes a path falls into. */
export type LanguageClass = 'parsed' | 'recognized' | 'other';

/**
 * Display names and stable colours. Colours follow GitHub linguist's palette for
 * the languages it defines, so the bar reads the same as a repository page; the
 * remainder are assigned from a fixed table rather than a hash so a colour never
 * moves between renders.
 */
const DISPLAY: Readonly<Record<string, readonly [label: string, color: string]>> = Object.freeze({
  javascript: ['JavaScript', '#f1e05a'],
  typescript: ['TypeScript', '#3178c6'],
  python: ['Python', '#3572A5'],
  java: ['Java', '#b07219'],
  c: ['C', '#555555'],
  cpp: ['C++', '#f34b7d'],
  'objective-c': ['Objective-C', '#438eff'],
  csharp: ['C#', '#178600'],
  go: ['Go', '#00ADD8'],
  ruby: ['Ruby', '#701516'],
  rust: ['Rust', '#dea584'],
  php: ['PHP', '#4F5D95'],
  kotlin: ['Kotlin', '#A97BFF'],
  swift: ['Swift', '#F05138'],
  dart: ['Dart', '#00B4AB'],
  vue: ['Vue', '#41b883'],
  cobol: ['COBOL', '#6b6b6b'],
  zig: ['Zig', '#ec915c'],
  // Recognised formats: neutral colours, intentionally outside the code palette.
  markdown: ['Markdown', '#8b949e'],
  json: ['JSON', '#a8a8a8'],
  yaml: ['YAML', '#7d9199'],
  markup: ['HTML', '#e34c26'],
  css: ['CSS', '#563d7c'],
  bash: ['Shell', '#89e051'],
  sql: ['SQL', '#9c9c9c'],
  toml: ['TOML', '#9c4221'],
  ini: ['INI', '#8a8a8a'],
  docker: ['Dockerfile', '#384d54'],
  makefile: ['Makefile', '#427819'],
  // GitNexus's detector does not know these. They are added here so the bar reads
  // like a repository page instead of dumping them into "other" — measured on the
  // GitNexus repository itself, where 6 `.jinja` and 3 `.ps1` files were the only
  // thing separating this breakdown from GitHub's.
  jinja: ['Jinja', '#a52a22'],
  powershell: ['PowerShell', '#012456'],
  batch: ['Batchfile', '#C1F12E'],
  diff: ['Diff', '#8b949e'],
  plaintext: ['Text', '#6e7681'],
  xml: ['XML', '#0060ac'],
  text: ['其他', '#484f58'],
});

/**
 * Extensions GitNexus's detector has no entry for, mapped to the display keys
 * above. Consulted only after that detector has declined the file, so it can
 * never override a language GitNexus genuinely parses.
 */
const SUPPLEMENTARY_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  '.jinja': 'jinja',
  '.jinja2': 'jinja',
  '.j2': 'jinja',
  '.njk': 'jinja',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.psd1': 'powershell',
  '.ps1xml': 'powershell',
  '.bat': 'batch',
  '.cmd': 'batch',
  '.patch': 'diff',
  '.diff': 'diff',
  '.txt': 'plaintext',
  '.log': 'plaintext',
});

/**
 * Built-in extension map used only when GitNexus's detector is unavailable.
 *
 * This is the fallback that was missing: with no GitNexus package, `detector` is
 * `null` and every ordinary source file used to fall through to `text`, so a
 * TypeScript repository reported a one-row "其他" breakdown — indistinguishable
 * from "this repository has no code". The map covers the languages this plugin
 * already knows how to display; it is not a reimplementation of GitNexus's parser
 * table, and it never claims a file is parsed. Every hit is classed `recognized`
 * because, without GitNexus, no parser support can be verified.
 *
 * Deliberately absent: extensions where the format is genuinely ambiguous
 * (`.h` is C here, matching GitHub linguist's default) or where upstream makes a
 * decision this plugin should not second-guess (`.ipynb`).
 */
const FALLBACK_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyw': 'python',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.m': 'objective-c',
  '.mm': 'objective-c',
  '.cs': 'csharp',
  '.go': 'go',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.rs': 'rust',
  '.php': 'php',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.dart': 'dart',
  '.vue': 'vue',
  '.cob': 'cobol',
  '.cbl': 'cobol',
  '.zig': 'zig',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.json': 'json',
  '.jsonc': 'json',
  '.json5': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.html': 'markup',
  '.htm': 'markup',
  '.xhtml': 'markup',
  '.css': 'css',
  '.scss': 'css',
  '.sass': 'css',
  '.less': 'css',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.fish': 'bash',
  '.sql': 'sql',
  '.toml': 'toml',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.xml': 'xml',
  '.xsd': 'xml',
  '.svg': 'xml',
});

/**
 * Cases no extension map can decide, resolved by filename.
 * Kept explicit so an unlisted name falls to `other` rather than a guess.
 */
const BASENAME_LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
  dockerfile: 'docker',
  makefile: 'makefile',
  'cmakelists.txt': 'text',
  '.gitignore': 'text',
  '.gitattributes': 'text',
  '.editorconfig': 'text',
  '.npmrc': 'text',
  '.nvmrc': 'text',
});

/**
 * The two members of GitNexus's bundled `dist/_shared/language-detection.js` this
 * plugin consumes. Everything else in that module is ignored.
 */
interface DetectorModule {
  getLanguageFromFilename?: (filePath: string) => string | null;
  getSyntaxLanguageFromFilename?: (filePath: string) => string;
}

/**
 * GitNexus's language detector, as this plugin uses it: the handle passed around
 * by {@link classifyFile} and {@link aggregateLanguages}.
 */
export interface LanguageDetector {
  getLanguageFromFilename: (filePath: string) => string | null;
  getSyntaxLanguageFromFilename: (filePath: string) => string;
}

/** What {@link classifyFile} decides about one path. */
export interface ClassifiedLanguage {
  key: string;
  label: string;
  color: string;
  klass: LanguageClass;
}

/** One row of the language breakdown: a {@link ClassifiedLanguage} with totals. */
export interface LanguageRow extends ClassifiedLanguage {
  bytes: number;
  files: number;
}

/** The language breakdown itself, as returned by {@link aggregateLanguages}. */
export interface LanguageAggregate {
  rows: LanguageRow[];
  totalFiles: number;
  totalBytes: number;
  /**
   * Which classifier produced the rows. `builtin` means GitNexus was unavailable
   * and {@link FALLBACK_EXTENSIONS} filled in; the rows are still useful, but no
   * row may be presented as "GitNexus parses this".
   */
  detector: 'gitnexus' | 'builtin';
}

let detector: LanguageDetector | null = null;

/**
 * Load GitNexus's bundled detector once per process.
 * Returns `null` when the bundled copy is unavailable, in which case every file
 * is classified `other` — a degraded but honest answer, never a fabricated one.
 */
export async function loadLanguageDetector(
  options: { env?: NodeJS.ProcessEnv; managedPrefix?: string } = {},
): Promise<LanguageDetector | null> {
  if (detector !== null) return detector;
  const root = findGitnexusRoot(options);
  if (root === null) return null;
  try {
    const mod = (await import(
      pathToFileURL(path.join(root, 'dist', '_shared', 'language-detection.js')).href
    )) as DetectorModule;
    if (typeof mod.getLanguageFromFilename === 'function') {
      detector = {
        getLanguageFromFilename: mod.getLanguageFromFilename,
        getSyntaxLanguageFromFilename:
          typeof mod.getSyntaxLanguageFromFilename === 'function'
            ? mod.getSyntaxLanguageFromFilename
            : () => 'text',
      };
    }
  } catch {
    /* fall through to the degraded path */
  }
  return detector;
}

/**
 * Classify one repo-relative path.
 *
 * @param filePath repo-relative, forward slashes
 */
export function classifyFile(filePath: string, det: LanguageDetector | null): ClassifiedLanguage {
  let key: string | null = null;
  let klass: LanguageClass = 'other';

  if (det !== null) {
    const parsed = det.getLanguageFromFilename(filePath);
    if (parsed) {
      key = parsed;
      klass = 'parsed';
    } else {
      const syntax = det.getSyntaxLanguageFromFilename(filePath);
      if (syntax && syntax !== 'text') {
        key = syntax;
        klass = 'recognized';
      }
    }
  }

  if (key === null) {
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot >= 0) {
      const ext = filePath.slice(lastDot).toLowerCase();
      const supplement = SUPPLEMENTARY_EXTENSIONS[ext] ?? FALLBACK_EXTENSIONS[ext];
      if (supplement !== undefined) key = supplement;
    }
  }

  if (key === null) {
    const base = filePath.split('/').pop()?.toLowerCase() ?? '';
    const byName = BASENAME_LANGUAGES[base];
    if (byName !== undefined) {
      key = byName;
      klass = byName === 'text' ? 'other' : 'recognized';
    }
  }

  const entry = key !== null ? DISPLAY[key] : undefined;
  // `key === null` already implies `entry === undefined`; stating both is what lets
  // the checker narrow `key` to a string for the return below.
  if (entry === undefined || key === null) {
    return { key: 'text', label: '其他', color: DISPLAY.text[1], klass: 'other' };
  }
  // A supplementary hit is a known format GitNexus cannot parse — never `parsed`.
  if (klass === 'other' && key !== 'text') klass = 'recognized';
  return { key, label: entry[0], color: entry[1], klass };
}

/**
 * Aggregate files into a language breakdown.
 *
 * `klass` rank decides ordering ties so the three visual bands stay contiguous
 * and the bar does not interleave "understood" and "not understood" segments.
 *
 * @param include extra filter, e.g. "is indexed"
 */
export function aggregateLanguages(
  files: ScannedFile[],
  det: LanguageDetector | null,
  include?: (filePath: string) => boolean,
): LanguageAggregate {
  const map = new Map<string, LanguageRow>();
  let totalFiles = 0;
  let totalBytes = 0;

  for (const file of files) {
    if (include && !include(file.path)) continue;
    const { key, label, color, klass } = classifyFile(file.path, det);
    let row = map.get(key);
    if (row === undefined) {
      row = { key, label, color, klass, files: 0, bytes: 0 };
      map.set(key, row);
    }
    row.files += 1;
    row.bytes += file.size;
    totalFiles += 1;
    totalBytes += file.size;
  }

  const klassRank = { parsed: 0, recognized: 1, other: 2 };
  const rows = [...map.values()].sort(
    (a, b) =>
      klassRank[a.klass] - klassRank[b.klass] ||
      b.bytes - a.bytes ||
      (a.key < b.key ? -1 : 1),
  );

  return { rows, totalFiles, totalBytes, detector: det === null ? 'builtin' : 'gitnexus' };
}
