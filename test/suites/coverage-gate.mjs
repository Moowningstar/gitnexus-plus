/**
 * The coverage gate: when a report should fail a build.
 *
 * No git, no index, no process: `coverageGateVerdict` takes the same report objects the
 * CLI prints and returns a boolean plus the reasons, so every branch is a function of a
 * literal. The reason wordings are the part a failed CI job shows a human, which makes
 * them contract, not decoration.
 */

import { check, section } from '../harness.mjs';

/** A report with the fields the gate reads; everything else is left off on purpose. */
function report(patch) {
  return {
    repo: { name: 'demo', path: '/repo/demo', indexed: true },
    index: {
      uncoveredCount: 0,
      uncoveredSample: [],
      staleCount: 0,
      staleSample: [],
    },
    ...patch,
  };
}

export async function coverageGateTests() {
  section('coverage gate: a report becomes a build result');
  const { coverageGateVerdict, isCoverageFailure } = await import('../../lib/gitnexus/coverage-gate.js');

  const both = { uncovered: true, missing: true };
  const off = { uncovered: false, missing: false };

  check(
    'a clean report passes with both gates armed',
    coverageGateVerdict([report({})], both).failed === false,
  );
  check('and gives no reasons to print', coverageGateVerdict([report({})], both).reasons.length === 0);
  check(
    'gaps do not fail the build while every gate is off',
    coverageGateVerdict(
      [
        report({
          index: {
            uncoveredCount: 3,
            uncoveredSample: [{ path: 'a.ts', size: 10 }],
            staleCount: 2,
            staleSample: ['gone.ts'],
          },
        }),
      ],
      off,
    ).failed === false,
  );

  const uncovered = report({
    index: {
      uncoveredCount: 3,
      uncoveredSample: [{ path: 'vendor/big.ts', size: 10 }, { path: 'bundle.min.js', size: 20 }],
      staleCount: 0,
      staleSample: [],
    },
  });
  const uncoveredVerdict = coverageGateVerdict([uncovered], both);
  check('files the index never saw trip the uncovered gate', uncoveredVerdict.failed === true);
  check(
    'the reason carries the count and the examples',
    uncoveredVerdict.reasons[0] === '未入索引：demo 有 3 个扫描选中的文件不在索引里（例如 vendor/big.ts、bundle.min.js）',
  );
  check(
    'the unmatched half does not fire the missing gate too',
    uncoveredVerdict.reasons.length === 1,
  );

  const many = coverageGateVerdict(
    [
      report({
        index: {
          uncoveredCount: 9,
          uncoveredSample: [
            { path: 'a.ts', size: 1 },
            { path: 'b.ts', size: 1 },
            { path: 'c.ts', size: 1 },
          ],
          staleCount: 0,
          staleSample: [],
        },
      }),
    ],
    both,
  );
  check(
    'more than two samples collapse into "等"',
    many.reasons[0].endsWith('（例如 a.ts、b.ts 等）'),
  );

  const stale = report({
    index: { uncoveredCount: 0, uncoveredSample: [], staleCount: 2, staleSample: ['old.ts', 'older.ts'] },
  });
  check('an index describing deleted files trips the missing gate', coverageGateVerdict([stale], both).failed === true);
  check(
    'but only when the missing gate is armed, not the uncovered one',
    coverageGateVerdict([stale], { uncovered: true, missing: false }).failed === false,
  );

  const unindexed = report({ repo: { name: 'demo', path: '/repo/demo', indexed: false } });
  check(
    'a repository with no index at all trips the missing gate',
    coverageGateVerdict([unindexed], both).reasons[0] === '索引缺失：demo 尚未建立索引（没有 .gitnexus/gitnexus.json）',
  );
  check(
    'and stays quiet when the gate is off',
    coverageGateVerdict([unindexed], { uncovered: true, missing: false }).failed === false,
  );

  const broken = { repo: { path: '/repo/broken' }, error: 'index unreadable' };
  check('an unreadable target counts as missing, with its own reason', (() => {
    const verdict = coverageGateVerdict([broken], both);
    return verdict.failed === true && verdict.reasons[0] === '无法分析 /repo/broken：index unreadable';
  })());
  check(
    'an unreadable target is not a report, so `isCoverageFailure` tells them apart',
    isCoverageFailure(broken) === true && isCoverageFailure(unindexed) === false,
  );

  const mixed = coverageGateVerdict([uncovered, stale, unindexed], both);
  check('one reason per tripped condition, per target', mixed.reasons.length === 3);
  check(
    'a batch with a single clean target still passes',
    coverageGateVerdict([report({}), report({})], both).failed === false,
  );
}
