/**
 * The pre-change gate: how much a file reaches, and whether that is worth interrupting for.
 *
 * Two halves are tested separately on purpose. The measurement (`summarizeImpact`) is fed a
 * hand-written report so every number is a literal; the decision (`impactVerdict`) and the
 * sentence (`describeImpact`) are pure functions of those numbers, so the copy that the
 * operator and the model both read cannot drift from what was counted.
 *
 * No git, no index, no helper process: a suite that needs a real analysis to assert
 * "5 callers crosses the threshold" would be testing the analyzer, not this module.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { check, section } from '../harness.mjs';
import {
  DEFAULT_IMPACT_THRESHOLDS,
  describeImpact,
  editedFiles,
  impactVerdict,
  indexPathFor,
  repoForFile,
  scopeLine,
  summarizeImpact,
} from '../../lib/gitnexus/precheck.js';

/** One exposed symbol with `count` callers from the named files. */
function hit(name, count, callers, cross = false) {
  return {
    symbol: { id: `Function:${name}`, kind: 'Function', name, filePath: 'src/a.ts', startLine: 1, community: 'Core' },
    incoming: count,
    callers: callers.map((fromFile) => ({ type: 'CALLS', fromFile, fromName: 'caller' })),
    crossCommunity: cross,
  };
}

function report(exposed, evaluated = true) {
  return {
    evaluated,
    verdict: evaluated ? 'exposed' : 'unknown',
    reason: evaluated ? null : '评估超时',
    at: '2026-10-31T00:00:00.000Z',
    counts: {
      broken: 0,
      exposed: exposed.length,
      blind: 0,
      crossCommunity: exposed.filter((entry) => entry.crossCommunity).length,
    },
    broken: [],
    exposed,
    blind: [],
    truncated: false,
    filesTruncated: false,
    deltaKey: 'key',
    notes: [],
  };
}

export async function precheckTests() {
  section('precheck: which calls mean "a file is about to change"');

  check(
    'only the edit tools are recognised, and only by file_path',
    editedFiles('edit', { file_path: 'src/a.ts' }).length === 1 &&
      editedFiles('write', { file_path: 'src/b.ts' })[0] === 'src/b.ts' &&
      editedFiles('read', { file_path: 'src/a.ts' }).length === 0 &&
      editedFiles('bash', { command: 'rm src/a.ts' }).length === 0,
    'a gate that guessed at a shell command would warn about the wrong file',
  );
  check(
    'a tool call without a usable path contributes nothing',
    editedFiles('edit', {}).length === 0 &&
      editedFiles('edit', null).length === 0 &&
      editedFiles('edit', { file_path: '   ' }).length === 0,
    'blank is not a path',
  );
  check(
    'the repository-relative path is forward-slashed',
    indexPathFor(path.resolve('/repo'), path.resolve('/repo/src/deep/a.ts')) === 'src/deep/a.ts',
    indexPathFor(path.resolve('/repo'), path.resolve('/repo/src/deep/a.ts')),
  );

  section('precheck: finding the indexed repository above a file');

  const root = await mkdtemp(path.join(os.tmpdir(), 'gnp-precheck-'));
  try {
    const plain = path.join(root, 'plain');
    await mkdir(plain, { recursive: true });
    check('a directory with no .gitnexus has no repo', repoForFile(path.join(plain, 'a.ts')) === null);

    const indexed = path.join(root, 'indexed');
    await mkdir(path.join(indexed, '.gitnexus'), { recursive: true });
    await writeFile(path.join(indexed, '.gitnexus', 'gitnexus.json'), JSON.stringify({ repoPath: indexed }));
    await mkdir(path.join(indexed, 'src', 'deep'), { recursive: true });
    await writeFile(path.join(indexed, 'src', 'deep', 'a.ts'), 'export const a = 1;\n');
    const found = repoForFile(path.join(indexed, 'src', 'deep', 'a.ts'));
    check(
      'a file under an owned store resolves to that repository',
      found !== null && path.resolve(found) === path.resolve(indexed),
      String(found),
    );
    check(
      'a file that does not exist yet still resolves — the edit is about to create it',
      repoForFile(path.join(indexed, 'src', 'deep', 'new.ts')) !== null,
    );

    const unowned = path.join(root, 'unowned');
    await mkdir(path.join(unowned, '.gitnexus'), { recursive: true });
    await writeFile(path.join(unowned, '.gitnexus', 'lbug'), '');
    check(
      'a store with data but no manifest is not a repository this gate may speak about',
      repoForFile(path.join(unowned, 'a.ts')) === null,
      'warned from an unowned store would be a guess',
    );

    section('precheck: what the numbers mean');

    const none = summarizeImpact(indexed, path.join(indexed, 'src', 'deep', 'a.ts'), null);
    check(
      'no report means no claim',
      none.symbols === 0 && none.incoming === 0 && none.callers === 0 && none.top.length === 0,
      JSON.stringify(none),
    );
    const failed = summarizeImpact(indexed, path.join(indexed, 'src', 'deep', 'a.ts'), report([hit('x', 9, ['src/b.ts'])], false));
    check('an unevaluated report is not a zero-risk reading', failed.incoming === 0 && failed.symbols === 0);

    const measured = summarizeImpact(
      indexed,
      path.join(indexed, 'src', 'deep', 'a.ts'),
      report([hit('alpha', 12, ['src/b.ts', 'src/c.ts'], true), hit('beta', 4, ['src/b.ts'])]),
    );
    check(
      'the summary sums references but counts caller files once',
      measured.symbols === 2 && measured.incoming === 16 && measured.callers === 2 && measured.crossCommunity === 1,
      JSON.stringify(measured),
    );
    check(
      'the heaviest symbol is named first',
      measured.top[0]?.name === 'alpha' && measured.top[0]?.incoming === 12,
      JSON.stringify(measured.top),
    );
    check('the summary names the file it is about', measured.path === 'src/deep/a.ts', measured.path);

    section('precheck: when a file is worth interrupting for');

    const small = summarizeImpact(indexed, path.join(indexed, 'src', 'deep', 'a.ts'), report([hit('alpha', 3, ['src/b.ts'])]));
    check('a narrow file is not worth a confirmation', impactVerdict(small).large === false);
    const wide = summarizeImpact(
      indexed,
      path.join(indexed, 'src', 'deep', 'a.ts'),
      report([hit('alpha', 6, ['a1.ts', 'a2.ts', 'a3.ts', 'a4.ts', 'a5.ts'])]),
    );
    const wideVerdict = impactVerdict(wide);
    check(
      'many caller files qualify, and the reason says so',
      wideVerdict.large && wideVerdict.reason.includes(`${DEFAULT_IMPACT_THRESHOLDS.files} 个文件`),
      wideVerdict.reason,
    );
    const crossing = summarizeImpact(
      indexed,
      path.join(indexed, 'src', 'deep', 'a.ts'),
      report([hit('alpha', 5, ['src/b.ts'], true), hit('beta', 5, ['src/c.ts'], true)]),
    );
    check(
      'references from other communities qualify on their own',
      impactVerdict(crossing).large && impactVerdict(crossing).reason.includes('社区'),
      impactVerdict(crossing).reason,
    );
    const hot = summarizeImpact(
      indexed,
      path.join(indexed, 'src', 'deep', 'a.ts'),
      report([hit('hot', 41, ['src/b.ts'])]),
    );
    check('one hot symbol qualifies without many files', impactVerdict(hot).large, impactVerdict(hot).reason);

    section('precheck: what the developer reads');

    const text = describeImpact(wide, wideVerdict.reason);
    check(
      'the sentence names the path, the counts and the heaviest symbol',
      text.includes('src/deep/a.ts') && text.includes('5 个文件引用') && text.includes('共 6 处') && text.includes('alpha'),
      text,
    );
    check(
      'the sentence refuses to be a compile verdict',
      text.includes('不是编译结论') && !/编译失败|构建破坏|测试会挂/.test(text),
      text,
    );
    check(
      'an empty summary says nothing at all',
      scopeLine(null) === '' && scopeLine(none) === '',
      scopeLine(none),
    );
    check(
      'a measured summary becomes one prompt line',
      scopeLine(measured).includes('src/deep/a.ts') && scopeLine(measured).split('\n').length === 1,
      scopeLine(measured),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
