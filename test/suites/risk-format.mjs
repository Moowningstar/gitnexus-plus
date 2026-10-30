/**
 * What the dependency alarm is allowed to say.
 *
 * Two properties are the point of this suite. First, the words: a changed file with callers is
 * "暴露", never "编译失败", and a failed evaluation is "无法评估", never silence — one false
 * alarm and the line stops being read. Second, the request: the change set is ordered and
 * capped before it leaves the host, because `readDelta` can report thousands of paths and the
 * child takes a file.
 */

import { check, section } from '../harness.mjs';

const FORBIDDEN = /编译失败|构建破坏|测试会挂|一定安全|不会出问题/;

function query(patch = {}) {
  return {
    requested: 2,
    matched: 2,
    filesTruncated: false,
    truncated: false,
    symbols: 4,
    edges: 2,
    broken: [],
    exposed: [],
    blind: [],
    counts: { broken: 0, exposed: 0, blind: 0, crossCommunity: 0 },
    notes: [],
    ...patch,
  };
}

function hit(name, patch = {}) {
  return {
    symbol: { id: `id-${name}`, kind: 'Function', name, filePath: 'src/a.ts', startLine: 12, community: 'C1' },
    incoming: 3,
    callers: [{ type: 'CALLS', fromFile: 'src/b.ts', fromName: 'callerB' }],
    crossCommunity: false,
    ...patch,
  };
}

export async function riskFormatTests() {
  section('risk: the request is ordered and capped before it leaves the host');
  const { riskRequestFromPaths, RISK_FILE_CAP } = await import('../../lib/gitnexus/risk-query.js');

  const mixed = riskRequestFromPaths([
    { path: 'src/new.ts', kind: 'added' },
    { path: 'src/gone.ts', kind: 'deleted' },
    { path: 'src/changed.ts', kind: 'modified' },
    { path: 'vendor/big.js', kind: 'excluded' },
  ]);
  check('excluded files are not asked about', mixed.request.files.length === 3);
  check('a deleted file is ordered before a modified one', mixed.request.files[0].path === 'src/gone.ts');
  check('and a modified one before an added one', mixed.request.files[1].path === 'src/changed.ts');
  check('the limit defaults to ten', mixed.request.limit === 10);

  const many = Array.from({ length: RISK_FILE_CAP + 5 }, (_, index) => ({ path: `src/f${index}.ts`, kind: 'modified' }));
  const capped = riskRequestFromPaths(many);
  check('the file cap holds', capped.request.files.length === RISK_FILE_CAP);
  check('and the dropped count is reported', capped.dropped === 5);

  const windows = riskRequestFromPaths([{ path: 'src\\a\\b.ts', kind: 'modified' }]);
  check('windows separators are normalized', windows.request.files[0].path === 'src/a/b.ts');

  section('risk: a report says one of four things');
  const { riskReportFromQuery, unknownRisk, formatRisk, riskLine } = await import('../../lib/gitnexus/risk.js');

  const broken = riskReportFromQuery(query({ broken: [hit('dead')], counts: { broken: 1, exposed: 0, blind: 0, crossCommunity: 0 } }), 'k1');
  check('a broken symbol makes the verdict broken', broken.verdict === 'broken');
  check('the report is marked evaluated', broken.evaluated === true);
  check('and carries the change-set key it answers', broken.deltaKey === 'k1');

  const exposed = riskReportFromQuery(query({ exposed: [hit('live')], counts: { broken: 0, exposed: 1, blind: 0, crossCommunity: 1 } }), 'k2');
  check('only-exposed is its own verdict', exposed.verdict === 'exposed');

  const clear = riskReportFromQuery(query(), 'k3');
  check('nothing found is clear', clear.verdict === 'clear');
  check('and a clear report says nothing to a tool', riskLine(clear) === null);

  const unknown = unknownRisk('依赖查询超时，结论未知。', 'k4');
  check('a failure is unknown, never clear', unknown.verdict === 'unknown' && unknown.evaluated === false);

  section('risk: the text a person reads');
  const brokenText = formatRisk(broken);
  check('a broken report names the bucket', brokenText.includes('确定断裂'));
  check('and explains why a deleted file counts', brokenText.includes('文件已删除'));
  check('a caller is named', brokenText.includes('callerB'));
  check('the line count is honest', brokenText.includes('1 处'));

  const exposedText = formatRisk(exposed);
  check('an exposed report says 暴露', exposedText.includes('暴露'));
  check('and refuses to be a build verdict', exposedText.includes('不是编译结论'));
  check('a cross-community count is shown', exposedText.includes('跨社区'));

  const unknownText = formatRisk(unknown);
  check('an unevaluated report says 无法评估', unknownText.includes('无法评估'));
  check('and says that is not the same as clean', unknownText.includes('不是“没有风险”'));
  check('it names the reason', unknownText.includes('超时'));

  const blindText = formatRisk(
    riskReportFromQuery(query({ blind: [{ path: 'src/gen.ts', kind: 'added', reason: 'no-symbols' }], counts: { broken: 0, exposed: 0, blind: 1, crossCommunity: 0 } }), 'k5'),
  );
  check('a blind spot is listed, not hidden', blindText.includes('盲区') && blindText.includes('src/gen.ts'));

  const truncatedText = formatRisk(riskReportFromQuery(query({ filesTruncated: true }), 'k6'));
  check('a truncated file set says so', truncatedText.includes('不是完整的'));

  const everything = [brokenText, exposedText, unknownText, blindText, truncatedText, riskLine(broken) ?? '', riskLine(exposed) ?? '', riskLine(unknown) ?? ''].join('\n');
  check('no output claims a compile verdict', !FORBIDDEN.test(everything));

  const brokenLine = riskLine(broken) ?? '';
  check('the tool line carries the count', brokenLine.includes('1 处确定断裂'));
  check('the tool line is one line', !brokenLine.includes('\n'));
}
