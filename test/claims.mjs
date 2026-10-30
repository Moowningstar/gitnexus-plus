/**
 * The READMEs advertise how many checks `npm test` runs, and nothing used to read that
 * sentence back. It drifted: 0.1.10 shipped announcing 1254 checks while the suites
 * already ran 1258, and 0.1.11 moved the engine count by another 33. The number is
 * small, but it is the first thing a reader compares against CI, and it was wrong in the
 * direction that makes the suite look thinner than it is.
 *
 * This module turns the sentence into an assertion. Each runner checks its own number
 * after its last suite and counts that check too, so the advertised total always
 * includes the guard itself. Both READMEs are read and must describe the same run —
 * one language drifting away from the other is the failure mode no reviewer notices.
 *
 * The engine suite is allowed exactly one discrepancy: three of its checks only run
 * when the local index records a commit, and both READMEs already say so ("a checkout
 * without one reports …"). Anything else must match precisely, which is why the guard
 * fails rather than warns.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Engine checks that need an index recording a commit; a bare checkout reports fewer. */
export const CONDITIONAL_ENGINE_CHECKS = 3;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** English sentence: "at 0.1.11 that is 1302 checks (890 engine, 82 plugin, 330 client" */
const EN = /at (\d+\.\d+\.\d+) that is (\d+) checks? \((\d+) engine, (\d+) plugin, (\d+) client/;
/** Chinese sentence: "0.1.11 时共 1302 项（引擎 890、插件 82、客户端 330；…报 1299）" */
const CN = /(\d+\.\d+\.\d+) 时共 (\d+) 项（引擎 (\d+)、插件 (\d+)、\s*客户端 (\d+)/;

const FILES = [
  { file: 'README.md', pattern: EN },
  { file: 'README-CN.md', pattern: CN },
];

/**
 * Read one README's advertised counts.
 *
 * Line breaks inside the sentence are why the text is flattened first: the English
 * version wraps after "1254" and the Chinese one wraps inside the parenthesis, and a
 * pattern anchored on a single line would silently stop matching after an edit.
 *
 * @param {{file: string, pattern: RegExp}} spec
 * @returns {{file: string, version: string, total: number, engine: number, plugin: number, client: number} | {file: string, error: string}}
 */
function readOne(spec, root) {
  let text;
  try {
    text = readFileSync(path.join(root, spec.file), 'utf8');
  } catch (error) {
    return { file: spec.file, error: `could not read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const flat = text.replace(/\s+/g, ' ');
  const match = spec.pattern.exec(flat);
  if (match === null) {
    return {
      file: spec.file,
      error: 'no advertised check count found (the sentence was reworded or moved)',
    };
  }
  const [, version, total, engine, plugin, client] = match;
  return { file: spec.file, version: version, total: Number(total), engine: Number(engine), plugin: Number(plugin), client: Number(client) };
}

/** @param {string} [root] */
export function readAdvertisedCounts(root = ROOT) {
  return FILES.map((spec) => readOne(spec, root));
}

const triple = (entry) => `${entry.total} (${entry.engine}/${entry.plugin}/${entry.client})`;

/**
 * Check one runner's count against both READMEs.
 *
 * @param {{suite: 'engine'|'plugin'|'client', counted: number, root?: string}} options
 *   `counted` must include the check this result is fed into.
 * @returns {{ok: boolean, detail: string}}
 */
export function checkAdvertisedCount({ suite, counted, root = ROOT }) {
  const entries = readAdvertisedCounts(root);
  const problems = [];
  for (const entry of entries) {
    if ('error' in entry) problems.push(`${entry.file}: ${entry.error}`);
  }
  const [en, cn] = entries;
  if (!('error' in en) && !('error' in cn)) {
    if (triple(en) !== triple(cn)) {
      problems.push(`${en.file} advertises ${triple(en)} but ${cn.file} advertises ${triple(cn)}`);
    }
    if (en.total !== en.engine + en.plugin + en.client) {
      problems.push(`${en.file}: ${en.total} is not ${en.engine}+${en.plugin}+${en.client}`);
    }
    const advertised = en[suite];
    // A checkout whose index records no commit legitimately runs three fewer engine
    // checks, so for that suite the advertised number may be exactly three higher.
    const allowedWithoutCommit = counted + (suite === 'engine' ? CONDITIONAL_ENGINE_CHECKS : 0);
    if (advertised !== counted && advertised !== allowedWithoutCommit) {
      problems.push(
        `${suite}: the READMEs advertise ${advertised}, this run counted ${counted}` +
          (suite === 'engine' ? ` (or ${allowedWithoutCommit} without a recorded commit)` : ''),
      );
    }
  }
  const summary = entries
    .map((entry) => ('error' in entry ? `${entry.file}: ${entry.error}` : `${entry.file}: ${triple(entry)}`))
    .join('; ');
  if (problems.length > 0) return { ok: false, detail: `${problems.join('; ')} — ${summary}` };
  return { ok: true, detail: '' };
}
