/**
 * Publish hygiene: the files that decide what a catalog sees, and where a dependency
 * comes from.
 *
 * `0.1.7` was published from a lockfile whose every `resolved` pointed at a China mirror.
 * Fixing that once is not a fix — the next `npm install` on a machine with a mirror
 * configured writes the mirror back, and nothing fails. The same is true of `LICENSE`:
 * an appended notice turns the detected licence into "Other" and nothing in the build
 * notices. These checks are the only thing that would, so they are deliberately dull:
 * read a file, assert the shape.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { check, section } from '../harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PUBLIC = 'registry.npmjs.org';

export async function hygieneTests() {
  section('publish hygiene');

  let npmrc = '';
  try {
    npmrc = readFileSync(path.join(ROOT, '.npmrc'), 'utf8');
  } catch {
    npmrc = '';
  }
  const registryLine = /^\s*registry\s*=\s*(\S+)\s*$/m.exec(npmrc);
  check(
    '.npmrc pins the public registry',
    registryLine !== null && registryLine[1] === `https://${PUBLIC}/`,
    registryLine === null ? '(no registry line)' : registryLine[1],
  );

  // Every `resolved` is an exact tarball URL, so this also catches a split lockfile where
  // one dependency was re-fetched through a different registry than the rest.
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const entries = Object.entries(lock.packages ?? {});
  const hosts = new Set();
  const offenders = [];
  for (const [name, entry] of entries) {
    const resolved = entry?.resolved;
    if (typeof resolved !== 'string' || resolved === '') continue;
    try {
      hosts.add(new URL(resolved).host);
    } catch {
      offenders.push(`${name}: ${resolved}`);
      continue;
    }
    if (!resolved.startsWith(`https://${PUBLIC}/`)) offenders.push(`${name}: ${resolved}`);
  }
  check(
    'every dependency in the lockfile resolves from the public registry',
    offenders.length === 0,
    offenders.slice(0, 3).join(' | ') || `${entries.length} packages, 0 offenders`,
  );
  check(
    'the lockfile carries exactly one registry host',
    hosts.size === 1 && hosts.has(PUBLIC),
    [...hosts].join(',') || '(no resolved URLs)',
  );
  check(
    '.npmrc and the lockfile agree',
    registryLine !== null && hosts.size === 1 && hosts.has(PUBLIC),
    `npmrc=${registryLine?.[1] ?? '(none)'} lock=${[...hosts].join(',')}`,
  );

  // Same shape of trap, one file over: a licence file with an appendix is not the MIT
  // template any more. GitHub then reports `NOASSERTION`, npm says "Other", and every
  // catalog that copies them (dsh.so, dshget) shows "Other" next to a MIT package. The
  // appendix lives in NOTICE.md; if it ever gets pasted back, this line says so.
  const licence = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  const paragraphs = licence.split(/\n\s*\n/).map(part => part.trim()).filter(part => part !== '');
  const last = paragraphs.at(-1) ?? '';
  check(
    'LICENSE holds the MIT text and nothing appended to it',
    licence.includes('MIT License') &&
      licence.includes('WITHOUT WARRANTY OF ANY KIND') &&
      last.endsWith('SOFTWARE.') &&
      !licence.includes('NOTICE.md'),
    `${paragraphs.length} paragraph(s), ends with "${last.slice(-24)}"`,
  );
  check(
    'NOTICE.md is what carries the scope note',
    readFileSync(path.join(ROOT, 'NOTICE.md'), 'utf8').includes('PolyForm-Noncommercial-1.0.0'),
    'NOTICE.md names the upstream licence',
  );
}
