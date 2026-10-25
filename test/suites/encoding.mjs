/**
 * Encoding guard: shipped text must not be double-decoded.
 *
 * The failure this guards against is not exotic. A UTF-8 string gets decoded once as GBK
 * (a PowerShell round-trip, a repair script that writes its own search pattern back) and
 * the result is still valid UTF-8, so nothing complains — it just renders as unrelated
 * CJK. The panel's "missing components" line shipped that way in 0.1.7.
 *
 * A character blocklist cannot catch this: the first scan here missed that exact string
 * because the list was written by looking at damage already known. So detection is
 * inverted. Every character that GBK can encode is mapped back to its two bytes; a run
 * of such characters is suspicious when its bytes decode as valid UTF-8 into text that
 * looks like what the author meant — which is precisely what a single wrong decode
 * produces, and what ordinary Chinese text does not.
 *
 * One deliberate exception: the middle dot (U+00B7) is C2 B7, and on its own that *is* a
 * valid UTF-8 sequence, so a single character that decodes to one inside ASCII text is
 * reported. Longer runs of real Chinese fail to decode and are left alone.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { check, section } from '../harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Directories that ship text we own. `lib` is generated, `.docs` is gitignored notes. */
const SCAN_DIRS = ['src', 'test', 'types', 'scripts'];
const SCAN_FILES = ['README.md', 'README-CN.md', 'package.json', 'cordis.patch.yml'];
const SKIP_DIRS = new Set(['node_modules', 'lib', '.git', '.gitnexus', '.docs', '.logs', '.fixtures', 'vendor']);

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const MIDDLE_DOT = '\u00b7';

let encoded = null;

/** character -> its two GBK bytes, built once by walking the encoding backwards. */
function gbkTable() {
  if (encoded !== null) return encoded;
  const table = new Map();
  const decoder = new TextDecoder('gbk');
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      const text = decoder.decode(Uint8Array.from([lead, trail]));
      if (text.length !== 1) continue;
      const code = text.codePointAt(0);
      if (code === undefined || code < 0x80) continue;
      if (!table.has(text)) table.set(text, [lead, trail]);
    }
  }
  encoded = table;
  return table;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Every run of GBK-encodable characters whose bytes are valid UTF-8 again.
 *
 * Returns `{ index, text, decoded }` per run, where `text` is what the file contains and
 * `decoded` is what the author most likely meant.
 */
export function scanText(text) {
  const table = gbkTable();
  const found = [];
  let run = [];
  let start = -1;

  const flush = () => {
    if (run.length === 0) return;
    const bytes = [];
    for (const ch of run) {
      const pair = table.get(ch);
      if (pair === undefined) throw new Error(`no GBK bytes for ${ch}`);
      bytes.push(pair[0], pair[1]);
    }
    const decoded = decodeUtf8(Uint8Array.from(bytes));
    const dot = decoded === MIDDLE_DOT && run.length === 1;
    const cjk = decoded !== null && CJK.test(decoded) && run.length >= 2;
    if (dot || cjk) found.push({ index: start, text: run.join(''), decoded });
    run = [];
    start = -1;
  };

  let offset = 0;
  for (const ch of text) {
    if (table.has(ch)) {
      if (run.length === 0) start = offset;
      run.push(ch);
    } else {
      flush();
    }
    offset += ch.length;
  }
  flush();
  return found;
}

/** The same scan, reported the way a failure should read: label, 1-based line, meaning. */
export function offenders(label, text) {
  return scanText(text).map((hit) => {
    const before = text.slice(0, hit.index);
    const line = before.split('\n').length;
    return { label, line, found: hit.text, expected: hit.decoded };
  });
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (entry.isFile() && /\.(?:ts|mjs|js|json|md|yml)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every file whose text we are willing to ship or to keep honest. */
export function shippedFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir), files);
  for (const name of SCAN_FILES) files.push(path.join(ROOT, name));
  return files.sort();
}

/**
 * What a wrong decode looks like: the UTF-8 bytes of `text`, read back as GBK.
 *
 * Encoding the text to GBK and decoding it the same way would round-trip cleanly, which is
 * why the first version of this control passed nothing.
 */
function damagedSample(text) {
  return new TextDecoder('gbk').decode(new TextEncoder().encode(text));
}

/** The character the middle dot becomes when its UTF-8 bytes are read as GBK. */
function damagedDot() {
  return new TextDecoder('gbk').decode(new TextEncoder().encode(MIDDLE_DOT));
}

export function encodingTests() {
  section('encoding');

  const damaged = damagedSample('缺少组件');
  const hits = scanText(damaged);
  check(
    'a wrong GBK decode is recognised',
    hits.length === 1 && hits[0].decoded === '缺少组件',
    `${JSON.stringify(damaged)} -> ${JSON.stringify(hits[0]?.decoded ?? null)}`,
  );

  check(
    'ordinary Chinese text is left alone',
    scanText('索引 缺少组件 路径 覆盖 组件缺失').length === 0,
    JSON.stringify(scanText('索引 缺少组件 路径 覆盖 组件缺失')),
  );

  const dot = damagedDot();
  const dotted = scanText(`GitNexus coverage ${dot} repo`);
  check(
    'a lone middle dot survives its own encode/decode',
    dot !== MIDDLE_DOT && dotted.length === 1 && dotted[0].decoded === MIDDLE_DOT,
    `${JSON.stringify(dot)} -> ${JSON.stringify(dotted)}`,
  );

  check('plain ASCII has nothing to find', scanText('nothing to see here').length === 0);

  const multi = `first line\nsecond ${damaged} line\nthird line`;
  const reported = offenders('inline.mjs', multi);
  check(
    'a hit names its line and its meaning',
    reported.length === 1 && reported[0].line === 2 && reported[0].expected === '缺少组件',
    JSON.stringify(reported),
  );

  const files = shippedFiles();
  const found = [];
  for (const file of files) found.push(...offenders(path.relative(ROOT, file), readFileSync(file, 'utf8')));
  check(
    'every shipped file decodes as the text it looks like',
    found.length === 0,
    found.map((hit) => `${hit.label}:${hit.line} ${JSON.stringify(hit.found)} -> ${JSON.stringify(hit.expected)}`).join('; '),
  );

  const relatives = files.map((file) => path.relative(ROOT, file).replaceAll(path.sep, '/'));
  const inSource = relatives.filter((file) => file.startsWith('src/')).length;
  const inSuites = relatives.filter((file) => file.startsWith('test/')).length;
  check(
    'the sweep covers the sources, the suites and both READMEs',
    inSource >= 60 &&
      inSuites >= 15 &&
      relatives.includes('src/index.ts') &&
      relatives.includes('src/client/index.ts') &&
      relatives.includes('test/run.mjs') &&
      relatives.includes('test/suites/encoding.mjs') &&
      relatives.includes('README.md') &&
      relatives.includes('README-CN.md'),
    `${relatives.length} files (src ${inSource}, test ${inSuites})`,
  );
}
