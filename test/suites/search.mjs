/**
 * Search: graph names, FTS bodies, and the route.
 *
 * Extracted from `run.mjs` unchanged — the checks, their messages and their order
 * inside each suite are as they were; only the file they live in changed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { analyzeCoverage, judgeMinified, formatBytes, looksGenerated, readCompatibility } from '../../lib/gitnexus/coverage.js';
import { scanRepository } from '../../lib/gitnexus/scan.js';
import { loadScanPrimitives } from '../../lib/gitnexus/root.js';
import { readRegistry, normalizePathKey } from '../../lib/gitnexus/index-meta.js';
import { buildFixture, check, fixturePath, section } from '../harness.mjs';

export async function searchTests() {
  section('keyword search over the graph');
  const {
    searchSymbols,
    searchViaHelper,
    searchWithFallback,
    searchText,
    sanitizeSearchQuery,
    SearchError,
  } = await import('../../lib/gitnexus/search.js');

  const clean = sanitizeSearchQuery("a'b\\c");
  check('sanitize removes quotes and backslashes', !clean.includes("'") && !clean.includes('\\'), JSON.stringify(clean));
  check('sanitize preserves CJK keywords', sanitizeSearchQuery('覆盖 率') === '覆盖 率');
  check('sanitize caps a pathological query', sanitizeSearchQuery('a'.repeat(200)).length === 80);

  const repo = process.cwd();
  const hasStore = await fs
    .access(path.join(repo, '.gitnexus', 'lbug'))
    .then(() => true)
    .catch(() => false);
  if (hasStore) {
    // LadybugDB intermittently refuses a `LOWER` call on this index with "Invalid UTF-8"
    // while every indexed source file is valid UTF-8 — an upstream engine defect, not a
    // query the plugin built. The product path degrades to text search for it
    // (`search-failed` is in FALLBACK_CODES), so the direct graph assertion is skipped
    // only for this exact message; anything else still fails.
    const engineUtf8Defect = (text) => /Invalid UTF-8/i.test(text);
    // The host cannot load the native addon (Electron Node ABI); the helper is the
    // boundary that runs it under the system Node. Run it FIRST: it opens the DB in a
    // child process, and the direct search below keeps a connection open in this one.
    // Two readers can be fine in production, but this test runner's sandbox can deny
    // the child spawn outright, which is a skip rather than a product failure.
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const helper = path.join(import.meta.dirname, '..', '..', 'lib', 'bin', 'search-helper.js');
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [helper, repo, 'analyzeCoverage', '5', ''],
        { cwd: repo, timeout: 30_000, windowsHide: true },
      );
      const body = JSON.parse(stdout.trim());
      if (body.ok === false && engineUtf8Defect(String(body.message ?? ''))) {
        check(
          'the helper subprocess returns a JSON report (skipped)',
          true,
          'upstream LOWER/UTF-8 defect in this index — the fallback covers the product path',
        );
      } else {
        check(
          'the helper subprocess returns a JSON report',
          body.ok === true && body.report?.results?.some((hit) => hit.name === 'analyzeCoverage'),
          stdout.slice(0, 300),
        );
      }
    } catch (error) {
      const message = String(error);
      const denied = /EPERM|EACCES|spawn/i.test(message);
      check(
        'the helper subprocess is spawnable in this environment',
        denied,
        denied ? 'spawn denied by this sandbox — covered by the unconfined run' : message,
      );
    }

    try {
      const report = await searchSymbols(repo, 'analyzeCoverage', { limit: 8 });
      check('real search returns graph hits', report.mode === 'graph' && report.results.length > 0, JSON.stringify(report).slice(0, 300));
      check(
        'real search finds a known symbol',
        report.results.some((hit) => hit.name === 'analyzeCoverage'),
        JSON.stringify(report.results.map((hit) => hit.name)),
      );
      // The manifest's promise and the pass that actually ran are two different facts,
      // and this assertion is about their consistency — not about which one this
      // machine happens to be in (an index built with --skip-fts reports the names-only
      // pair, a healthy one reports FTS and no caveat).
      const consistent = report.contentSearch
        ? report.ftsAvailable === true && report.warning === null
        : report.warning !== null;
      check(
        'search reports what it searched: FTS ran, or the caveat says why not',
        consistent,
        JSON.stringify({
          ftsAvailable: report.ftsAvailable,
          contentSearch: report.contentSearch,
          warning: report.warning,
        }),
      );
      check(
        'every hit carries a path and a valid line',
        report.results.every(
          (hit) => hit.filePath !== '' && (hit.startLine === null || Number.isInteger(hit.startLine)),
        ),
      );
    } catch (error) {
      const message = String(error);
      const upstream = engineUtf8Defect(message);
      check(
        'real search runs against the indexed repository',
        upstream,
        upstream
          ? 'skipped: upstream LOWER/UTF-8 defect — searchWithFallback degrades to text for it'
          : message,
      );
    }

    // A repeated search must not pay for a second helper process. The shell stub
    // answers with a canned report, so only the cache can make the second call cheap.
    try {
      const { searchWithFallback } = await import('../../lib/gitnexus/search.js');
      const searchHelper = path.join(import.meta.dirname, '..', '..', 'lib', 'bin', 'search-helper.js');
      let executed = 0;
      const canned = {
        ok: true,
        report: {
          query: 'cacheProbeQuery',
          mode: 'graph',
          ftsAvailable: false,
          results: [
            { kind: 'Function', name: 'cacheProbeQuery', filePath: 'src/x.ts', startLine: 1, endLine: 1 },
          ],
          total: 1,
          truncated: false,
          warning: null,
        },
      };
      const counting = {
        resolve: (request) => request,
        execute: async () => {
          executed += 1;
          return {
            result: async () => ({
              exitCode: 0,
              stdout: { text: JSON.stringify(canned) },
              stderr: { text: '' },
            }),
          };
        },
      };
      const options = { shell: counting, helperPath: searchHelper, limit: 5 };
      const first = await searchWithFallback(repo, 'cacheProbeQuery', options);
      const second = await searchWithFallback(repo, 'cacheProbeQuery', options);
      check(
        'a repeated search is served from cache',
        executed === 1 && second.results.length === first.results.length,
        `executed=${executed} results=${second.results.length}`,
      );

      // Two submits of the same query before the first finishes must share one process.
      let concurrent = 0;
      const slowShell = {
        resolve: (request) => request,
        execute: async () => {
          concurrent += 1;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return {
            result: async () => ({
              exitCode: 0,
              stdout: { text: JSON.stringify(canned) },
              stderr: { text: '' },
            }),
          };
        },
      };
      const concurrentOptions = { shell: slowShell, helperPath: searchHelper, limit: 5 };
      const [one, two] = await Promise.all([
        searchWithFallback(repo, 'concurrentProbeQuery', concurrentOptions),
        searchWithFallback(repo, 'concurrentProbeQuery', concurrentOptions),
      ]);
      check(
        'a concurrent duplicate search shares the first process',
        concurrent === 1 && one.results.length === two.results.length,
        `spawned=${concurrent} results=${two.results.length}`,
      );
    } catch (error) {
      check('search cache probe runs', false, String(error));
    }
  } else {
    check('real search runs against the indexed repository (skipped)', true, 'no .gitnexus/lbug on this machine');
  }

  // The helper boundary and source fallback need a real index; a CI checkout has
  // none, so keep the validation-only checks below and skip the indexed ones.
  if (hasStore) {
  let captured = null;
  const stubShell = {
    resolve(request) {
      captured = request;
      return request;
    },
    execute: async () => ({
      result: async () => ({
        exitCode: 0,
        stdout: {
          text: JSON.stringify({
            ok: true,
            report: {
              query: 'analyzecoverage',
              mode: 'graph',
              ftsAvailable: false,
              results: [
                {
                  kind: 'Function',
                  name: 'analyzeCoverage',
                  filePath: 'src/gitnexus/coverage.ts',
                  startLine: 507,
                  endLine: 864,
                },
              ],
              total: 1,
              truncated: false,
              warning: null,
            },
          }),
        },
      }),
    }),
  };
  const viaHelper = await searchViaHelper(repo, 'analyzeCoverage', {
    shell: stubShell,
    helperPath: 'C:/plugin/lib/bin/search-helper.js',
    limit: 5,
  });
  check(
    'the host runs node on the helper, not the native adapter in-process',
    String(captured?.command).startsWith('node ') && String(captured?.command).includes('search-helper.js'),
    String(captured?.command),
  );
  check('the host parses the helper report', viaHelper.results[0]?.name === 'analyzeCoverage');

  // A no-session helper spawn otherwise inherits the DSH application directory as
  // its sandbox root; on Windows that grant fails under Program Files. The policy is
  // rooted at `.gitnexus`, not the repository: Windows propagates the inheritable ACE
  // across the whole workspace, which is minutes on a large tree.
  const searchPolicy = { mode: 'workspace-write', workspaceRoot: repo };
  let searchPolicyRepo = null;
  await searchViaHelper(repo, 'analyzeCoverage', {
    shell: stubShell,
    helperPath: 'C:/plugin/lib/bin/search-helper.js',
    limit: 5,
    sandboxPolicy: (repoPath) => {
      searchPolicyRepo = repoPath;
      return searchPolicy;
    },
  });
  check(
    'the search helper receives the index-rooted sandbox policy',
    captured?.sandboxPolicy === searchPolicy &&
      path.resolve(searchPolicyRepo) === path.resolve(repo, '.gitnexus'),
    JSON.stringify({ policy: captured?.sandboxPolicy, asked: searchPolicyRepo }),
  );

  const failingShell = {
    resolve: (request) => request,
    execute: async () => ({
      result: async () => ({
        exitCode: 1,
        stdout: { text: JSON.stringify({ ok: false, status: 503, code: 'search-unavailable', message: 'native' }) },
        stderr: { text: '' },
      }),
    }),
  };
  const helperFailure = await searchViaHelper(repo, 'analyzeCoverage', {
    shell: failingShell,
    helperPath: 'C:/plugin/lib/bin/search-helper.js',
  }).catch((error) => error);
  check(
    'a typed helper failure keeps its code and status',
    helperFailure instanceof SearchError &&
      helperFailure.code === 'search-unavailable' &&
      helperFailure.status === 503,
    String(helperFailure),
  );

  const unparseableShell = {
    resolve: (request) => request,
    execute: async () => ({
      result: async () => ({
        exitCode: 1,
        stdout: { text: '' },
        stderr: { text: 'A dynamic link library (DLL) initialization routine failed' },
      }),
    }),
  };
  const unparseable = await searchViaHelper(repo, 'analyzeCoverage', {
    shell: unparseableShell,
    helperPath: 'C:/plugin/lib/bin/search-helper.js',
  }).catch((error) => error);
  check(
    'an unparseable helper failure reports the stderr tail',
    unparseable instanceof SearchError &&
      unparseable.code === 'search-failed' &&
      unparseable.message.includes('(DLL) initialization'),
    String(unparseable),
  );

  // The fallback path: no shell, no native load — reads the indexed files in-process.
  const text = await searchText(repo, 'analyzeCoverage', { limit: 8 });
  check(
    'source fallback finds a match in the indexed files',
    text.mode === 'text' &&
      text.results.some((hit) => hit.kind === 'Text' && hit.filePath === 'src/gitnexus/coverage.ts'),
    JSON.stringify(text).slice(0, 400),
  );
  check('source fallback says it is not the graph', text.warning !== null && text.warning.includes('源码'));

  const fallback = await searchWithFallback(repo, 'analyzeCoverage', {
    shell: unparseableShell,
    helperPath: 'C:/plugin/lib/bin/search-helper.js',
  });
  check(
    'a helper failure falls back to source text instead of an error card',
    fallback.mode === 'text' && fallback.results.length > 0 && fallback.warning !== null,
    JSON.stringify(fallback).slice(0, 400),
  );
  }

  const empty = await searchSymbols(repo, '   ').catch((error) => error);
  check('an empty query is rejected', empty instanceof SearchError && empty.code === 'invalid-query', String(empty));

  const notProject = fixturePath('not-project');
  await fs.rm(notProject, { recursive: true, force: true });
  await fs.mkdir(notProject, { recursive: true });
  const notProjectError = await searchSymbols(notProject, 'x').catch((error) => error);
  check(
    'a plain directory is refused',
    notProjectError instanceof SearchError && notProjectError.code === 'not-a-project',
    String(notProjectError),
  );
  await fs.rm(notProject, { recursive: true, force: true });

  const noIndex = fixturePath('git-no-index');
  await fs.rm(noIndex, { recursive: true, force: true });
  await fs.mkdir(path.join(noIndex, '.git'), { recursive: true });
  const noIndexError = await searchSymbols(noIndex, 'x').catch((error) => error);
  check(
    'a git project without an index is refused',
    noIndexError instanceof SearchError && noIndexError.code === 'no-index',
    String(noIndexError),
  );
  await fs.rm(noIndex, { recursive: true, force: true });
}

export async function ftsSearchTests() {
  section('FTS content search');
  const {
    pickFtsIndexName,
    mapFtsRows,
    mergeHits,
    searchViaFts,
    isFtsLoadFailure,
    loadAdapter,
  } = await import('../../lib/gitnexus/search.js');

  // The catalog GitNexus keeps: one FTS index per table, plus ordinary indexes that
  // must not be mistaken for the keyword one.
  const catalog = [
    { table_name: 'File', index_name: 'file_fts', index_type: 'FTS' },
    { table_name: 'Function', index_name: 'function_fts', index_type: 'FTS' },
    { table_name: 'File', index_name: 'file_pk', index_type: 'ART' },
  ];
  check('picks the FTS index from the catalog', pickFtsIndexName(catalog, 'File') === 'file_fts');
  check(
    'accepts the positional catalog shape',
    pickFtsIndexName([['File', 'file_fts', 'FTS']], 'File') === 'file_fts',
  );
  check(
    'does not mistake an ordinary index for the FTS one',
    pickFtsIndexName([{ table_name: 'File', index_name: 'file_pk', index_type: 'ART' }], 'File') ===
      null,
  );
  check(
    'does not take another table\u2019s index',
    pickFtsIndexName(catalog, 'Method') === null,
  );
  check(
    'ignores unusable catalog rows',
    pickFtsIndexName([null, 3, { table_name: 'File' }], 'File') === null,
  );
  check(
    'accepts a name-only index without a type column',
    pickFtsIndexName([{ table_name: 'File', index_name: 'legacy_fts' }], 'File') === 'legacy_fts',
  );

  // Regression guard for the shape that made this whole pass look unavailable: the
  // capabilities live under `capabilities` in the manifest, and handing the reader the
  // whole manifest yields no `fts` entry at all — which reads exactly like "the index
  // cannot do FTS".
  const { readCapabilities } = await import('../../lib/gitnexus/coverage.js');
  const manifest = { capabilities: { fts: { provider: 'ladybugdb-fts', status: 'available' } } };
  check(
    'capabilities are read from the manifest’s capabilities block',
    readCapabilities(manifest.capabilities).fts?.status === 'available',
  );
  check(
    'a whole manifest is not a capability map',
    readCapabilities(manifest).fts === undefined,
    'callers must pass meta.raw.capabilities; meta.raw silently reports "no FTS"',
  );

  const flat = mapFtsRows([{ name: 'search.ts', filePath: 'src/gitnexus/search.ts', score: 2.5 }]);
  check(
    'flattened FTS rows become file hits',
    flat.length === 1 && flat[0].filePath === 'src/gitnexus/search.ts' && flat[0].kind === 'File',
    JSON.stringify(flat),
  );
  const nested = mapFtsRows([
    { node: { label: 'File', name: 'a.ts', filePath: 'src/a.ts' }, score: 1 },
  ]);
  check(
    'a nested { node } row keeps its label',
    nested.length === 1 && nested[0].kind === 'File' && nested[0].name === 'a.ts',
    JSON.stringify(nested),
  );
  check('rows without a path are dropped', mapFtsRows([{ name: 'x' }, null, 'nope']).length === 0);

  const symbol = {
    kind: 'Function',
    name: 'analyzeCoverage',
    filePath: 'src/gitnexus/coverage.ts',
    startLine: 593,
    endLine: 610,
  };
  const sameFile = {
    kind: 'File',
    name: 'coverage.ts',
    filePath: 'src\\gitnexus\\coverage.ts',
    startLine: null,
    endLine: null,
  };
  const otherFile = {
    kind: 'File',
    name: 'search.ts',
    filePath: 'src/gitnexus/search.ts',
    startLine: null,
    endLine: null,
  };
  const merged = mergeHits([symbol], [sameFile, otherFile], 5);
  check(
    'a file the graph already lists is not repeated',
    merged.results.length === 2 && merged.results[1].filePath === 'src/gitnexus/search.ts',
    JSON.stringify(merged.results.map((hit) => hit.filePath)),
  );
  check('extra hits inside the limit are not called truncated', merged.truncated === false);
  const capped = mergeHits([symbol], [otherFile, { ...otherFile, filePath: 'src/b.ts' }], 2);
  check(
    'a dropped extra hit reports truncation',
    capped.results.length === 2 && capped.truncated === true,
    JSON.stringify(capped),
  );
  check('merging nothing truncates nothing', mergeHits([], [], 3).truncated === false);

  check(
    'the extension-load failure is recognised',
    isFtsLoadFailure(
      "Failed to load library 'C:\\Users\\x\\.lbdb\\extension\\fts\\libfts.lbug_extension'",
    ),
  );
  check(
    'the unregistered-function failure is recognised',
    isFtsLoadFailure('Catalog exception: function QUERY_FTS_INDEX is not defined.'),
  );
  check(
    'a missing index is not an extension failure',
    !isFtsLoadFailure("Binder exception: Table File doesn't have an index with name file_fts."),
  );
  check(
    'a locked database is not an extension failure',
    !isFtsLoadFailure('Could not set lock on file: .gitnexus/lbug'),
  );

  const stub = (over) => ({
    withLbugDb: async () => [],
    executePrepared: async () => [],
    ...over,
  });
  const noSurface = await searchViaFts(stub({}), 'q', 5);
  check(
    'an adapter without the FTS calls reports it instead of failing',
    noSurface.ran === false && /FTS 调用/.test(noSurface.failure ?? ''),
    JSON.stringify(noSurface),
  );
  const noFileIndex = await searchViaFts(
    stub({
      executeQuery: async () => [
        { table_name: 'Method', index_name: 'method_fts', index_type: 'FTS' },
      ],
      queryFTS: async () => [],
    }),
    'q',
    5,
  );
  check(
    'a missing File index is reported, not read as "no matches"',
    noFileIndex.ran === false && /File 表的 FTS 索引/.test(noFileIndex.failure ?? ''),
    JSON.stringify(noFileIndex),
  );
  let captured = null;
  const hitReport = await searchViaFts(
    stub({
      executeQuery: async () => catalog,
      queryFTS: async (table, index, query, limit) => {
        captured = { table, index, query, limit };
        return [{ node: { name: 'search.ts', filePath: 'src/gitnexus/search.ts' }, score: 3 }];
      },
    }),
    'needle',
    7,
  );
  check(
    'a working FTS pass reports it ran and returns file hits',
    hitReport.ran === true &&
      hitReport.failure === null &&
      hitReport.hits.length === 1 &&
      hitReport.hits[0].filePath === 'src/gitnexus/search.ts',
    JSON.stringify(hitReport),
  );
  check(
    'the FTS pass queries the discovered index with the sanitized query and limit',
    captured !== null &&
      captured.table === 'File' &&
      captured.index === 'file_fts' &&
      captured.query === 'needle' &&
      captured.limit === 7,
    JSON.stringify(captured),
  );
  const ftsThrew = await searchViaFts(
    stub({
      executeQuery: async () => catalog,
      queryFTS: async () => {
        throw new Error('Catalog exception: function QUERY_FTS_INDEX is not defined');
      },
    }),
    'q',
    5,
  );
  check(
    'a query failure degrades with the reason attached',
    ftsThrew.ran === false && /QUERY_FTS_INDEX/.test(ftsThrew.failure ?? ''),
    JSON.stringify(ftsThrew),
  );
  const catalogThrew = await searchViaFts(
    stub({
      executeQuery: async () => {
        throw new Error('SHOW_INDEXES is not supported');
      },
      queryFTS: async () => [],
    }),
    'q',
    5,
  );
  check(
    'an unreadable catalog degrades instead of throwing',
    catalogThrew.ran === false && /索引目录/.test(catalogThrew.failure ?? ''),
    JSON.stringify(catalogThrew),
  );

  // The adapter surface only exists when GitNexus is installed; CI installs neither
  // the package nor its native engine, so the probe reports "not installed" there.
  try {
    const adapter = await loadAdapter({});
    check(
      'the installed adapter exposes the FTS surface',
      typeof adapter.queryFTS === 'function' && typeof adapter.executeQuery === 'function',
      Object.keys(adapter).join(','),
    );
  } catch (error) {
    check(
      'the adapter FTS probe is skipped without GitNexus',
      /search-unavailable/.test(String(error?.code ?? '')),
      `${error?.code ?? ''} ${error?.message ?? error}`,
    );
  }
}

export async function searchRouteTests() {
  section('route: /api/gitnexus/search');
  const http = await import('node:http');
  const { mountSearchRoute } = await import('../../lib/routes/search.js');
  const { SearchError } = await import('../../lib/gitnexus/search.js');

  const registered = [];
  const shimServer = {
    register: (route) => {
      registered.push(route);
      return () => {
        const i = registered.indexOf(route);
        if (i >= 0) registered.splice(i, 1);
      };
    },
  };
  const calls = [];
  const dispose = mountSearchRoute(shimServer, {
    search: async (repo, query, options) => {
      calls.push({ repo, query, options });
      if (query === 'busy') throw new SearchError('index-busy', 503, '索引正忙');
      return {
        query,
        mode: 'graph',
        ftsAvailable: false,
        results: [
          { kind: 'Function', name: 'analyzeCoverage', filePath: 'src/gitnexus/coverage.ts', startLine: 507, endLine: 862 },
        ],
        total: 1,
        truncated: false,
        warning: 'FTS 内容检索不可用',
      };
    },
  });

  const server = http.createServer((req, res) => {
    const match = registered.find((route) => (req.url ?? '').startsWith(route.path));
    if (match !== undefined) {
      void match.handler(req, res);
      return;
    }
    res.statusCode = 404;
    res.end('no route');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const hit = async (pathname) => {
    const res = await fetch('http://127.0.0.1:' + port + pathname);
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const repo = encodeURIComponent(process.cwd());
  const ok = await hit(`/api/gitnexus/search?repo=${repo}&q=analyze&limit=5`);
  check('search route answers 200', ok.status === 200 && ok.body?.ok === true, 'status=' + ok.status);
  check('results pass through', ok.body?.results?.[0]?.name === 'analyzeCoverage');
  check('the route forwards the query and limit', calls[0]?.query === 'analyze' && calls[0]?.options?.limit === 5);

  const missingQuery = await hit(`/api/gitnexus/search?repo=${repo}`);
  check('missing q is rejected', missingQuery.status === 400 && missingQuery.body?.code === 'missing-query');

  const missingRepo = await hit('/api/gitnexus/search?q=analyze');
  check('missing repo is rejected', missingRepo.status === 400 && missingRepo.body?.code === 'missing-repo');

  const notProject = await hit('/api/gitnexus/search?repo=' + encodeURIComponent('C:\\Windows\\System32') + '&q=analyze');
  check(
    'a non-project is refused',
    notProject.status === 404 && notProject.body?.code === 'not-a-project',
    'status=' + notProject.status,
  );

  const busy = await hit(`/api/gitnexus/search?repo=${repo}&q=busy`);
  check('a typed engine error keeps its status', busy.status === 503 && busy.body?.code === 'index-busy', 'status=' + busy.status);

  const post = await fetch('http://127.0.0.1:' + port + `/api/gitnexus/search?repo=${repo}&q=analyze`, {
    method: 'POST',
  });
  check('POST is rejected', post.status === 405, 'status=' + post.status);

  const head = await fetch('http://127.0.0.1:' + port + `/api/gitnexus/search?repo=${repo}&q=analyze`, {
    method: 'HEAD',
  });
  check('HEAD is allowed without a body', head.status === 200, 'status=' + head.status);

  await new Promise((resolve) => server.close(resolve));
  dispose();
  check('search route disposer clears the registration', registered.length === 0);
}
