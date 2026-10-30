/**
 * The advertised check count is itself a claim, so it gets its own tests.
 *
 * The guard that runs at the end of each runner only proves the happy path: with the
 * READMEs in sync it passes, and that is indistinguishable from a guard that compares
 * nothing. These checks exercise the two ways it must fail — a count off by one, and a
 * sentence that no longer matches — because a silent guard is worse than no guard.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, section } from '../harness.mjs';
import { checkAdvertisedCount, readAdvertisedCounts } from '../claims.mjs';

const triple = (entry) => `${entry.total} (${entry.engine}/${entry.plugin}/${entry.client})`;

export function claimsTests() {
  section('readme claims: the advertised check count');

  const entries = readAdvertisedCounts();
  const broken = entries.filter((entry) => 'error' in entry);
  check(
    'both READMEs still contain the advertised count',
    broken.length === 0,
    broken.map((entry) => `${entry.file}: ${entry.error}`).join('; '),
  );
  if (broken.length > 0) return;

  const [en, cn] = entries;
  check(
    'the two languages describe the same run',
    triple(en) === triple(cn) && en.total === en.engine + en.plugin + en.client,
    `${triple(en)} vs ${triple(cn)}`,
  );

  // One higher than advertised must be reported as drift. This is the exact failure the
  // guard exists for, so it is asserted rather than trusted.
  const drifted = checkAdvertisedCount({ suite: 'engine', counted: en.engine + 1 });
  check(
    'a count that drifted by one is rejected',
    drifted.ok === false && drifted.detail.includes('engine'),
    drifted.detail,
  );

  // A README whose sentence was reworded must fail loudly. Passing by producing no match
  // is the failure mode that would let the number rot again.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gnp-claims-'));
  try {
    writeFileSync(path.join(dir, 'README.md'), '# no count here\n');
    writeFileSync(path.join(dir, 'README-CN.md'), '# 也没有数字\n');
    const missing = checkAdvertisedCount({ suite: 'engine', counted: 1, root: dir });
    check(
      'a README without the sentence fails instead of passing',
      missing.ok === false && missing.detail.includes('no advertised check count'),
      missing.detail,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
