/**
 * Build a copy of the GitNexus web UI that seeds the SPA's AI settings before it starts.
 *
 * WHY A COPY OF THE DIST DIRECTORY
 * --------------------------------
 * The SPA keeps its provider settings in `sessionStorage`, and the panel shows it in an
 * iframe on another origin (`http://127.0.0.1:<port>` vs the DSH web origin). A parent
 * frame cannot write a child frame's `sessionStorage`, even for loopback, so the only
 * place to inject is the SPA's own page — before its module script runs.
 *
 * The server honors `GITNEXUS_WEB_DIST` (`resolveWebDistDir` in `dist/server/api.js`
 * prefers it over the packaged `web/` directory and serves it with the same SPA
 * fallback), so the plugin points the server at a directory it owns:
 *
 *   <out>/index.html   the packaged index.html, with its module script deferred behind
 *                      a small inline script that writes `gitnexus-llm-settings`
 *   <out>/assets       a link to the packaged `assets/` — the SPA's URLs are absolute
 *                      (`/assets/index-*.js`), so the link is what keeps them working
 *
 * Only `index.html` is rewritten. Everything else is served straight out of the package,
 * which keeps this correct across GitNexus upgrades: the asset names change with the
 * bundle hash, and a link follows them.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The stored key the SPA reads on load (`core/llm/settings-service.ts`). */
export const LLM_SETTINGS_KEY = 'gitnexus-llm-settings';

/** Marker attribute, so the injected page can be recognised in a test or a devtools dump. */
export const SEED_SCRIPT_ATTRIBUTE = 'data-gitnexus-plus-ai';

const SCRIPT_TAG = /<script\b([^>]*)>\s*<\/script>/gi;
const TYPE_MODULE = /\btype\s*=\s*("|')module\1/i;
const SRC_ATTRIBUTE = /\bsrc\s*=\s*("|')([^"']+)\1/i;

/**
 * JSON that is safe inside a `<script>` element.
 *
 * `JSON.stringify` alone is not: a `</script>` in any string value would end the element
 * early, and U+2028/U+2029 are line terminators to older parsers. Both are escaped as
 * unicode escapes, which are equivalent inside a JS string literal.
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The inline script: seed the settings, then load the app with its original URL. */
function seedScript(moduleSrc: string, seed: Record<string, unknown>): string {
  const payload = scriptSafeJson(seed);
  const src = scriptSafeJson(moduleSrc);
  return [
    `<script ${SEED_SCRIPT_ATTRIBUTE}>`,
    '/* Injected by gitnexus-plus: pre-fill the AI settings, then start the SPA. */',
    '(function () {',
    '  try {',
    `    sessionStorage.setItem(${scriptSafeJson(LLM_SETTINGS_KEY)}, JSON.stringify(${payload}));`,
    '  } catch (error) {',
    '    /* private mode or a full quota: the SPA will ask for the key itself */',
    '  }',
    '  var script = document.createElement("script");',
    '  script.type = "module";',
    '  script.crossOrigin = "";',
    `  script.src = ${src};`,
    '  document.head.appendChild(script);',
    '})();',
    '</script>',
  ].join('\n');
}

/**
 * Rewrite the packaged `index.html` so the seed lands before the app boots.
 *
 * Returns null when the page does not look like the SPA (no module script) — in that case
 * the caller leaves the dist alone rather than serving a page that never loads the app.
 */
export function rewriteIndexHtml(html: string, seed: Record<string, unknown> | null): string | null {
  if (seed === null) return null;
  let moduleSrc: string | null = null;
  const stripped = html.replace(SCRIPT_TAG, (tag: string, attributes: string) => {
    if (moduleSrc !== null) return tag;
    if (!TYPE_MODULE.test(attributes) || !/\bsrc\s*=/i.test(attributes)) return tag;
    const src = SRC_ATTRIBUTE.exec(attributes);
    if (src === null) return tag;
    moduleSrc = src[2];
    // Dropped here and re-created by the seed script, after `sessionStorage` is written.
    return '';
  });
  if (moduleSrc === null) return null;

  const injected = seedScript(moduleSrc, seed);
  if (/<\/head>/i.test(stripped)) return stripped.replace(/<\/head>/i, `${injected}\n  </head>`);
  if (/<body\b/i.test(stripped)) return stripped.replace(/<body\b/i, `${injected}\n  <body`);
  return `${injected}\n${stripped}`;
}

export interface WebDistSourceInput {
  /** The CLI this plugin resolved, as found by `findGitnexusCli`. */
  cliPath: string;
  /** The package root, when the resolver knew it (managed/dependency installs). */
  packageRoot?: string | null;
  platform?: NodeJS.Platform;
}

/**
 * Find the packaged `web/` directory that belongs to the CLI the runner will execute.
 *
 * It has to be the *same* package: a stray 1.6.6 install elsewhere on this machine serves
 * an SPA whose bundle does not match the index the CLI reads, and pointing it at another
 * package's assets would produce exactly one broken script request. Three shapes occur:
 * a known package root, a `dist/cli/index.js` path, and an npm shim that only mentions
 * the real script inside its own text.
 */
export async function locateWebDist(input: WebDistSourceInput): Promise<string | null> {
  const candidates: string[] = [];
  if (typeof input.packageRoot === 'string' && input.packageRoot !== '') {
    candidates.push(path.join(input.packageRoot, 'web'));
  }

  const cliPath = input.cliPath;
  if (cliPath.endsWith('.js')) {
    // `<root>/dist/cli/index.js` → walk up looking for the package root.
    let dir = path.dirname(cliPath);
    for (let depth = 0; depth < 8; depth += 1) {
      candidates.push(path.join(dir, 'web'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } else {
    // npm shims (`gitnexus.cmd`, `gitnexus.ps1`, a POSIX link) name the real script
    // relative to their own directory; no PATH knowledge needed.
    const shimDir = path.dirname(cliPath);
    candidates.push(path.join(shimDir, 'node_modules', 'gitnexus', 'web'));
    try {
      const text = await fs.readFile(cliPath, { encoding: 'utf8' });
      const match = /node_modules[\\/]gitnexus[\\/]/i.exec(text.slice(0, 64 * 1024));
      if (match !== null) candidates.push(path.join(shimDir, 'node_modules', 'gitnexus', 'web'));
    } catch {
      /* unreadable shim: the sibling guess above is all we have */
    }
  }

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export interface PrepareWebDistInput {
  /** Packaged `web/` directory (`locateWebDist`). */
  sourceDir: string;
  /** Directory this module owns and may replace. */
  outDir: string;
  seed: Record<string, unknown>;
  platform?: NodeJS.Platform;
}

export interface PreparedWebDist {
  dir: string;
  /** `link` when the assets directory could be linked, `copied` when it had to be duplicated. */
  assets: 'link' | 'copied';
}

/**
 * Write the seeded copy.
 *
 * Returns null when the source does not look like the SPA, so the caller can fall back to
 * the packaged dist instead of serving a blank page.
 */
export async function prepareWebDist(input: PrepareWebDistInput): Promise<PreparedWebDist | null> {
  const platform = input.platform ?? process.platform;
  const sourceIndex = path.join(input.sourceDir, 'index.html');
  let html: string;
  try {
    html = await fs.readFile(sourceIndex, { encoding: 'utf8' });
  } catch {
    return null;
  }
  const rewritten = rewriteIndexHtml(html, input.seed);
  if (rewritten === null) return null;

  await fs.mkdir(input.outDir, { recursive: true });
  await fs.writeFile(path.join(input.outDir, 'index.html'), rewritten, { encoding: 'utf8' });

  const sourceAssets = path.join(input.sourceDir, 'assets');
  const targetAssets = path.join(input.outDir, 'assets');
  const assets = (await linkAssets(sourceAssets, targetAssets, platform)) ? 'link' : 'copied';
  return { dir: input.outDir, assets };
}

/** Link (or copy) `assets`, replacing a link left by a previous GitNexus version. */
async function linkAssets(source: string, target: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const existing = await fs.readlink(target).catch(() => null);
    if (existing !== null) {
      if (path.resolve(existing) === path.resolve(source)) return true;
      await fs.rm(target, { recursive: true, force: true });
    } else if (existsSync(target)) {
      // A real directory from an earlier copy: usable, but not a link.
      return false;
    }
  } catch {
    /* nothing there yet */
  }
  try {
    await fs.symlink(source, target, platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    // Symlinks need a privilege on Windows that an unelevated process may lack. A copy
    // is ~110 files and 4 MB, which is acceptable for a fallback.
    try {
      await fs.cp(source, target, { recursive: true });
      return false;
    } catch {
      return false;
    }
  }
}

/** Delete a generated copy. Best-effort: it lives under the plugin's own directory. */
export async function removeWebDist(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* an in-use file on Windows: the next start overwrites what it can */
  }
}

/**
 * Where generated copies live: `$DSH_HOME/gitnexus-plus/webview`.
 *
 * Under `DSH_HOME` rather than inside the packaged plugin, for the same reason the managed
 * GitNexus install is: a profile installs the plugin by reference (`link:`), so its own
 * directory may be read-only or shared between profiles.
 */
export function defaultWebDistRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'gitnexus-plus', 'webview');
}

