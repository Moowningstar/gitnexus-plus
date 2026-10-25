/**
 * The three graph tools and their renderers.
 *
 * Two halves, tested separately on purpose:
 *
 * - `renderTool` is pure and gets the exhaustive cases — every truncation boundary and
 *   every qualifier that must survive it. These run everywhere, including a host that
 *   cannot spawn anything.
 * - `runGraphTool` is tested for its *refusals* and its plumbing against a stub shell.
 *   Spawning a real GitNexus helper needs a native store and a real index; the smoke
 *   suite covers that on a machine where it exists. What must be proven here is that a
 *   missing index, a missing shell and a helper that says "no" all come back as
 *   sentences instead of exceptions — because those are the cases a session hits.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { check, fixturePath, section } from '../harness.mjs';
import { renderTool } from '../../lib/gitnexus/graph-query-render.js';
import { runGraphTool, resolveToolHome } from '../../lib/gitnexus/graph-query.js';

/** A shell stub that answers one canned helper payload and records the command. */
function stubShell(payload) {
  const calls = [];
  return {
    calls,
    resolve(request) {
      calls.push(request);
      return request;
    },
    async execute() {
      return {
        async result() {
          return {
            stdout: { text: typeof payload === 'string' ? payload : JSON.stringify(payload) },
            stderr: { text: '' },
            exitCode: 0,
            timedOut: false,
          };
        },
      };
    },
  };
}

/** A shell stub that refuses to start anything, like a confined host. */
function brokenShell(message) {
  return {
    calls: [],
    resolve() {
      throw new Error(message);
    },
    async execute() {
      throw new Error('unreachable');
    },
  };
}

/** An indexed-looking fixture: a manifest and a graph store, nothing else. */
async function indexedFixture(name) {
  const root = fixturePath(name);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, '.gitnexus', 'lbug'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.gitnexus', 'gitnexus.json'),
    JSON.stringify({ repoPath: root, lastCommit: '', branch: 'main', stats: {}, capabilities: {} }, null, 2),
    'utf8',
  );
  return root;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function impactPayload(overrides = {}) {
  const byDepth = {};
  // Shape matches the real payload: one key per depth, each holding that depth's
  // entries. Depth 1 holds 13 callers, so the 12-item budget cuts exactly one.
  for (const [depth, count] of [[1, 13], [2, 10], [3, 1]]) {
    byDepth[String(depth)] = Array.from({ length: count }, (_, i) => ({
      depth,
      id: `Function:src/d${depth}f${i}.ts:caller${depth}_${i}`,
      name: `caller${depth}_${i}`,
      filePath: `src/d${depth}f${i}.ts`,
      relationType: 'CALLS',
      confidence: 0.85,
      processes: [],
    }));
  }
  return {
    target: { id: 'Function:src/guard.ts:sendJson', name: 'sendJson', type: 'Function', filePath: 'src/guard.ts' },
    direction: 'upstream',
    impactedCount: 24,
    risk: 'CRITICAL',
    riskSharedAxes: 'MEDIUM',
    riskScale: { comparableAcrossKinds: true, unusedAxes: [] },
    epistemic: 'exact',
    summary: { direct: 13, processes_affected: 17, modules_affected: 2 },
    byDepthCounts: { 1: 13, 2: 10, 3: 1 },
    affected_processes: Array.from({ length: 9 }, (_, i) => ({
      name: `proc${i}`,
      type: 'cross_community',
      filePath: `src/routes/r${i}.ts`,
      affected_process_count: 3,
      total_hits: 4,
      earliest_broken_step: 2,
    })),
    affected_modules: [
      { name: 'Routes', hits: 23, impact: 'direct' },
      { name: 'Gitnexus', hits: 1, impact: 'indirect' },
    ],
    byDepth,
    ...overrides,
  };
}

export async function graphQueryRenderTests() {
  section('graph tool renderers');

  const impact = renderTool('impact', impactPayload()).text;
  check('impact names the symbol, direction and risk', impact.includes('sendJson') && impact.includes('upstream') && impact.includes('CRITICAL'));
  check('impact keeps the counts even though the list is cut', impact.includes('受影响 24') && impact.includes('直接 13'));
  check('impact prints the depth distribution', impact.includes('深度分布：1→13，2→10，3→1'));
  // The first depth holds 13 entries and the budget is 12: one is named as missing,
  // never silently dropped.
  check('impact bounds the caller list and says so', impact.includes('…还有 1 条未列出'));
  check(
    'impact bounds the process list',
    (impact.match(/^- proc\d/gm) ?? []).length === 6 && impact.includes('…还有 3 条未列出'),
    impact.split('\n').filter((line) => line.startsWith('- proc')).join('|'),
  );
  check('impact lists the modules', impact.includes('Routes 23（direct）'));

  const unknown = renderTool('impact', impactPayload({ risk: 'UNKNOWN', impactedCount: 0, byDepthCounts: {}, summary: { direct: 0 } })).text;
  check(
    'UNKNOWN is explained instead of being read as safe',
    unknown.includes('risk 为 UNKNOWN') && unknown.includes('不等于安全'),
    unknown,
  );

  // Upstream explains why a walk came up short. Our paraphrase is not a substitute: a
  // reader deciding whether to trust an empty answer needs the walk's own reason.
  const noted = renderTool(
    'impact',
    impactPayload({
      risk: 'UNKNOWN',
      impactedCount: 0,
      byDepthCounts: {},
      summary: { direct: 0 },
      riskNote: '上游遍历解析到 0 个调用者：目标可能是入口点，或调用点全部无法解析。',
    }),
  ).text;
  check(
    'the upstream riskNote is printed verbatim',
    noted.includes('上游说明：') && noted.includes('目标可能是入口点'),
    noted.split('\n').filter((line) => line.startsWith('上游说明')).join('|'),
  );

  // A payload we cannot interpret must still show the bytes: guessing a field name is
  // worse than saying "this is what arrived".
  const unparsable = renderTool('impact', ['not', 'an', 'object']).text;
  check(
    'an uninterpretable payload comes with its own bytes',
    unparsable.includes('无法解读') && unparsable.includes('not') && unparsable.length < 600,
    unparsable,
  );

  // Upstream's `error` is the difference between "the index does not have this symbol"
  // and "the index was asked and nobody calls it". Same risk/greyscale, opposite advice —
  // a symbol added after the last refresh lands here on the first question asked about it.
  const notFound = renderTool('impact', {
    error: "Target 'entrySpans' not found",
    target: { name: 'entrySpans' },
    direction: 'upstream',
    impactedCount: null,
    risk: 'UNKNOWN',
  }).text;
  check(
    'upstream error is printed instead of being swallowed',
    notFound.includes("上游返回错误：Target 'entrySpans' not found"),
    notFound,
  );
  check(
    'not-found is explained as a stale index, not as an unexplained UNKNOWN',
    notFound.includes('先刷新索引') && !notFound.includes('动态派发'),
    notFound,
  );
  check(
    'a payload with nothing to say leaves no blank lines',
    !notFound.includes('\n\n\n') && !notFound.endsWith('\n'),
    JSON.stringify(notFound),
  );

  const lower = renderTool(
    'impact',
    impactPayload({ epistemic: 'lower-bound', boundaries: ['2 处调用点的接收者类型无法解析'], causes: { receiverTyping: 2, dispatchBoundary: 0 } }),
  ).text;
  check('lower-bound is stated in words', lower.includes('lower-bound') && lower.includes('下界'));
  check('boundaries are printed', lower.includes('2 处调用点的接收者类型无法解析'));
  check('only non-zero causes are printed', lower.includes('receiverTyping=2') && !lower.includes('dispatchBoundary'));
  // The envelope must come before the lists so a reader that stops early still sees it.
  check('the envelope precedes the lists', lower.indexOf('可信度') < lower.indexOf('受影响'));

  const context = renderTool('context', {
    status: 'found',
    symbol: { uid: 'Function:src/routes/guard.ts:sendJson', name: 'sendJson', kind: 'Function', filePath: 'src/routes/guard.ts', startLine: 44, endLine: 53 },
    epistemic: 'exact',
    incoming: { calls: [{ uid: 'a', name: 'handler', filePath: 'src/routes/a.ts' }, { uid: 'b', name: 'passGuard', filePath: 'src/routes/guard.ts' }] },
    outgoing: {},
    processes: [{ id: 'p1', name: 'Handler → SendJson', step_index: 3, step_count: 3 }],
  }).text;
  check('context prints the definition and span', context.includes('sendJson') && context.includes('src/routes/guard.ts:44-53'));
  check('context counts both sides', context.includes('上游 2 · 下游 0'));
  check('context lists callers under their relation', context.includes('调用者（calls，2）') && context.includes('- src/routes/a.ts · handler'));
  check('context names the process step', context.includes('Handler → SendJson · 第 3/3 步'));

  const missing = renderTool('context', { status: 'not-found', epistemic: 'exact' }).text;
  check('a missing symbol is reported, not rendered as empty', missing.includes('not-found'), missing);

  // The bare error envelope carries no `status`, so it used to slip past the
  // `status !== 'found'` test and render as "found, with zero callers".
  const bare = renderTool('context', { error: "Symbol 'Function:src/nope.ts:nope' not found" }).text;
  check('an error envelope with no status is a failure, not a find', (
    bare.includes('未找到') && bare.includes("Function:src/nope.ts:nope") && !bare.includes('上游 0')
  ), bare);
  check('the failure explains that the index is the place to look', bare.includes('先刷新索引'), bare);

  const hollow = renderTool('context', { status: 'found', incoming: {}, outgoing: {} }).text;
  check('no symbol and no edges says the answer is empty', (
    hollow.includes('名字可能不对') && !hollow.includes('上游 0 · 下游 0')
  ), hollow);

  const query = renderTool(
    'query',
    {
      processes: [{ id: 'p', summary: 'ProjectGraph → HasIndex', priority: 0.1, symbol_count: 2, process_type: 'cross_community', step_count: 3 }],
      process_symbols: [{ id: 's', name: 'hasIndex', filePath: 'src/index-meta.ts', startLine: 117, endLine: 128, module: 'Routes', process_id: 'p', step_index: 3 }],
      definitions: Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, name: `verdict${i}`, filePath: `src/v${i}.ts`, startLine: i + 1, endLine: i + 2 })),
    },
    'how the delta verdict is computed',
  ).text;
  check('query echoes the question', query.includes('how the delta verdict is computed'));
  check('query summarises the three buckets', query.includes('1 个流程 · 1 个流程内符号 · 20 个定义'));
  check('query bounds the definitions', (query.match(/^- verdict\d/gm) ?? []).length === 12 && query.includes('…还有 8 条未列出'));
  check('query names the process type', query.includes('cross_community'));
  // `gitnexus_context` advertises `uid` and points at `definitions[].id`; the canonical
  // payload never reaches the transcript, so the id has to be printed here or the
  // parameter is unusable.
  check('query prints the definition id the context tool asks for', query.includes('· uid d0'), query.slice(0, 400));
  check('a truncated definition list truncates its ids too', !query.includes('· uid d19'));

  const empty = renderTool('query', { processes: [], process_symbols: [], definitions: [] }, 'nothing').text;
  check('an empty query suggests the next step', empty.includes('没有匹配到'), empty);
}

// ---------------------------------------------------------------------------
// Refusals and plumbing
// ---------------------------------------------------------------------------

export async function graphQueryToolTests() {
  section('graph tool refusals');

  const helperPath = path.join(process.cwd(), 'lib', 'bin', 'graph-query-helper.js');

  // A directory that is neither a project root nor indexed.
  const plain = fixturePath('graph-query-plain');
  await fs.rm(plain, { recursive: true, force: true });
  await fs.mkdir(plain, { recursive: true });
  const notProject = await runGraphTool(plain, 'impact', { target: 'x' }, { shell: stubShell({ ok: false }), helperPath });
  check('an unindexed folder is refused as not-a-project', notProject.ok === false && notProject.code === 'not-a-project', JSON.stringify(notProject));

  // Indexed but with no shell: the read-only tools still work, the graph tools say why.
  const indexed = await indexedFixture('graph-query-indexed');
  const noShell = await runGraphTool(indexed, 'impact', { target: 'x' }, { shell: null, helperPath });
  check('a missing shell is its own answer', noShell.ok === false && noShell.code === 'no-shell' && noShell.message.includes('shell'));
  check(
    'the no-shell sentence says why a child process is needed',
    noShell.message.includes('原生模块'),
    noShell.message,
  );

  // A real project directory with a manifest but no graph store.
  const noStore = fixturePath('graph-query-no-store');
  await fs.rm(noStore, { recursive: true, force: true });
  await fs.mkdir(path.join(noStore, '.gitnexus'), { recursive: true });
  await fs.writeFile(
    path.join(noStore, '.gitnexus', 'gitnexus.json'),
    JSON.stringify({ repoPath: noStore, lastCommit: '' }, null, 2),
    'utf8',
  );
  const missingStore = await runGraphTool(noStore, 'impact', { target: 'x' }, { shell: stubShell({ ok: false }), helperPath });
  check(
    'a manifest without a graph store is no-index, with the reason',
    missingStore.ok === false && missingStore.code === 'no-index' && missingStore.message.includes('lbug'),
    JSON.stringify(missingStore),
  );

  section('graph tool plumbing');

  const payload = { ok: true, tool: 'impact', result: impactPayload() };
  const shell = stubShell(payload);
  const ok = await runGraphTool(indexed, 'impact', { target: 'sendJson', direction: 'upstream' }, {
    shell,
    helperPath,
    gitnexusHome: indexed,
    timeoutMs: 5_000,
  });
  check('a helper payload comes back as ok', ok.ok === true && ok.tool === 'impact', JSON.stringify(ok).slice(0, 200));
  check('the payload is passed through unmodified', ok.result !== null && typeof ok.result === 'object' && ok.result.impactedCount === 24);

  const command = shell.calls[0]?.command ?? '';
  check('the helper is invoked with the request file, not the symbol', command.includes('graph-query-helper.js') && command.includes('request.json'), command);
  check('a configured home is passed to the helper', command.includes('GITNEXUS_HOME'), command);
  check('the helper runs with the repository as its working directory', shell.calls[0]?.workdir === indexed, String(shell.calls[0]?.workdir));
  check('the timeout is forwarded to the executor', shell.calls[0]?.timeoutMs === 5_000, String(shell.calls[0]?.timeoutMs));

  const failed = await runGraphTool(indexed, 'context', { name: 'x' }, {
    shell: stubShell({ ok: false, code: 'gitnexus-missing', message: '找不到 gitnexus 包。' }),
    helperPath,
  });
  check('a helper refusal is a sentence, not a throw', failed.ok === false && failed.code === 'gitnexus-missing');
  check('the helper refusal keeps its own wording', failed.message.includes('找不到 gitnexus 包'), failed.message);

  const unparsable = await runGraphTool(indexed, 'query', { search_query: 'x' }, { shell: stubShell('not json at all'), helperPath });
  check('an unparsable payload is bad-output', unparsable.ok === false && unparsable.code === 'bad-output', JSON.stringify(unparsable));

  const refused = await runGraphTool(indexed, 'impact', { target: 'x' }, { shell: brokenShell('spawn EPERM'), helperPath });
  check(
    'a refused spawn says the child could not start',
    refused.ok === false && refused.code === 'tool-failed' && refused.message.includes('spawn EPERM'),
    JSON.stringify(refused),
  );

  section('graph tool home resolution');

  // No registry anywhere near the fixture: the plugin's own project-local home is the
  // only answer, and it must be a concrete path rather than an empty string.
  const fallback = await resolveToolHome(indexed, '');
  check('the plugin default home is used when no registry matches', fallback.endsWith(path.join('.gitnexus', 'plugin-home')), fallback);
}
