/**
 * Publish hygiene: the two files that decide *where a dependency comes from*.
 *
 * `0.1.7` was published from a lockfile whose every `resolved` pointed at a China mirror.
 * Fixing that once is not a fix — the next `npm install` on a machine with a mirror
 * configured writes the mirror back, and nothing fails. These checks are the only thing
 * that would notice, so they are deliberately dull: read two files, assert one host.
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
}
