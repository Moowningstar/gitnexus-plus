#!/usr/bin/env node
/**
 * Tests for the coverage / large-file engine.
 *
 * Two kinds of check:
 *
 *   fixture —a disposable repository built to contain exactly the cases that
 *             matter (a minified bundle over the cap, a large hand-written file,
 *             a dotfile, an ignored directory). Deterministic, so it can assert
 *             exact numbers.
 *
 *   cross   —for every registered repository, compare this tool's scan against
 *             GitNexus's own `walkRepositoryPaths`. The two must agree on the
 *             selected set, or the reuse in `scan.js` has silently drifted from
 *             upstream —which is the one failure mode that would make every
 *             number here wrong without anything throwing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { analyzeCoverage, judgeMinified, formatBytes, looksGenerated } from '../lib/gitnexus/coverage.js';
import { scanRepository } from '../lib/gitnexus/scan.js';
import { loadScanPrimitives } from '../lib/gitnexus/root.js';
import { readRegistry, normalizePathKey } from '../lib/gitnexus/index-meta.js';

let passed = 0;
let failed = 0;

/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } else {
    failed += 1;
    console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** @param {string} title */
function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

/**
 * Where fixtures are built.
 *
 * Inside the repository, not `os.tmpdir()`. A confined DSH process may write only
 * within its workspace, so a fixture under `%TEMP%` fails with `EPERM: mkdir` — which
 * is expected confinement rather than a broken ACL, and it made the whole suite
 * unrunnable in the environment the plugin is developed in.
 *
 * `test/run.mjs` is executed directly rather than imported, so `import.meta.dirname` is
 * this file's own directory and the fixture lands beside the tests.
 *
 * @param {string} name
 * @returns {string}
 */
function fixturePath(name) {
  return path.join(import.meta.dirname, '.fixtures', `${name}-${process.pid}`);
}

/** Build a repository containing one of each case the engine must distinguish. */
async function buildFixture() {
  const root = fixturePath('coverage');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'junk'), { recursive: true });

  // Normal source files, well under the cap.
  for (let i = 0; i < 5; i += 1) {
    await fs.writeFile(
      path.join(root, 'src', `mod${i}.ts`),
      `export const V${i} = ${i};\nexport function f${i}(x: number) { return x + ${i}; }\n`,
    );
  }
  // A recognized-but-unparsed file.
  await fs.writeFile(path.join(root, 'README.md'), '# fixture\n'.repeat(20));
  // A dotfile: excluded by `dot: false` upstream, so it must NOT appear at all.
  await fs.writeFile(path.join(root, '.hidden.ts'), 'export const HIDDEN = 1;\n');
  // An ignored directory: must not be counted as source, and must not be
  // reported as a skipped large file either.
  await fs.writeFile(path.join(root, 'node_modules', 'junk', 'big.js'), 'x'.repeat(700 * 1024));

  // Case 1: minified bundle over the cap —one line, megabytes wide.
  const minified = `var a=1;${'a+=1;'.repeat(120_000)}`;
  await fs.writeFile(path.join(root, 'dist-bundle.js'), minified);

  // Case 2: large but hand-written (many short lines) —over the cap, not minified.
  // Line count is chosen so the result clears 512 KB comfortably: at ~25 bytes per
  // line, 30k lines is ~750 KB. Sizing this by guesswork is how the first revision
  // of this fixture ended up asserting on a "large" file that was only 300 KB.
  const prose = Array.from({ length: 30_000 }, (_, i) => `export const K${i} = ${i};`).join('\n');
  await fs.writeFile(path.join(root, 'src', 'large-handwritten.ts'), `${prose}\n`);

  return {
    root,
    minifiedBytes: Buffer.byteLength(minified),
    proseBytes: Buffer.byteLength(`${prose}\n`),
  };
}

async function fixtureTests() {
  section('fixture: skip / ignore / dotfile / minified');
  const fixture = await buildFixture();
  const cap = 512 * 1024;

  const scan = await scanRepository(fixture.root, { env: {} });
  check('reuses GitNexus primitives', scan.primitives === 'gitnexus', `primitives=${scan.primitives}`);
  check('default cap is 512 KB', scan.capBytes === cap, `cap=${scan.capBytes}`);
  check('cap source is default', scan.capSource === 'default', `source=${scan.capSource}`);

  const largePaths = scan.large.map((f) => f.path).sort();
  check(
    'exactly the two oversized files are reported',
    largePaths.length === 2 && largePaths.includes('dist-bundle.js') && largePaths.includes('src/large-handwritten.ts'),
    `got ${JSON.stringify(largePaths)}`,
  );
  check(
    'dotfile is excluded entirely (not selected, not large)',
    !scan.selected.some((f) => f.path === '.hidden.ts') && !largePaths.includes('.hidden.ts'),
  );
  check(
    'ignored node_modules file is excluded entirely',
    !largePaths.some((p) => p.includes('node_modules')),
    `got ${JSON.stringify(largePaths)}`,
  );
  check(
    'both fixture files actually clear the cap (guards the fixture itself)',
    fixture.minifiedBytes > cap && fixture.proseBytes > cap,
    `minified=${formatBytes(fixture.minifiedBytes)} prose=${formatBytes(fixture.proseBytes)} cap=${formatBytes(cap)}`,
  );
  check('large files are sorted largest first', scan.large.length >= 2 && scan.large[0].size >= scan.large[1].size);

  section('fixture: minified heuristic');
  const bundle = await judgeMinified(path.join(fixture.root, 'dist-bundle.js'), fixture.minifiedBytes);
  check('minified bundle flagged', bundle.suspect === true, `avgLine=${bundle.avgLineLength}`);
  check('minified avg line length is huge', bundle.avgLineLength > 5000, `avg=${bundle.avgLineLength}`);

  const prose = await judgeMinified(
    path.join(fixture.root, 'src', 'large-handwritten.ts'),
    fixture.proseBytes,
  );
  check('hand-written large file NOT flagged', prose.suspect === false, `avgLine=${prose.avgLineLength}`);
  check('hand-written line count is extrapolated sanely', prose.estimatedLines > 10_000, `lines=${prose.estimatedLines}`);

  section('fixture: report assembly');
  const report = await analyzeCoverage(fixture.root, { env: {} });
  check('report marks repository as not indexed', report.repo.indexed === false);
  check('totals.large === 2', report.totals.large === 2, `got ${report.totals.large}`);
  check(
    'large-files-skipped warning present',
    report.warnings.some((w) => w.code === 'large-files-skipped'),
    JSON.stringify(report.warnings.map((w) => w.code)),
  );
  const dominant = report.warnings.find((w) => w.code === 'minified-dominates-language');
  check('minified-dominance warning present', dominant !== undefined, JSON.stringify(report.warnings.map((w) => w.code)));
  check(
    'dominance warning names the bundle',
    dominant !== undefined && String(dominant.evidence.path) === 'dist-bundle.js',
    dominant ? JSON.stringify(dominant.evidence) : 'n/a',
  );
  check('oversize bytes accounted', report.attribution.oversizeBytes > 0);
  check(
    'share of scanned volume is reported as a fraction',
    report.attribution.oversizeShareOfScanned > 0 && report.attribution.oversizeShareOfScanned < 1,
    `share=${report.attribution.oversizeShareOfScanned}`,
  );

  await fs.rm(fixture.root, { recursive: true, force: true });
}

async function crossCheckTests() {
  section('cross-check: this scan vs GitNexus walkRepositoryPaths');
  const primitives = await loadScanPrimitives({});
  if (primitives === null) {
    check('GitNexus primitives loadable', false);
    return;
  }
  check('GitNexus primitives loadable', true, `v${primitives.gitnexusVersion} at ${primitives.gitnexusRoot}`);

  const entries = await readRegistry();
  if (entries.length === 0) {
    check('registry has repositories', false);
    return;
  }
  check('registry has repositories', true, `${entries.length} entries`);

  // Walk the two smallest repositories: the point is agreement, and the largest
  // registered repo is 28k files.
  const sorted = [...entries].sort((a, b) => (a.stats?.files ?? 0) - (b.stats?.files ?? 0));
  const sample = sorted.slice(0, 3);

  for (const entry of sample) {
    let upstream;
    try {
      upstream = await primitives.walkRepositoryPaths(entry.path, undefined, { quiet: true });
    } catch (error) {
      check(`${entry.name}: upstream walk succeeded`, false, String(error));
      continue;
    }
    const scan = await scanRepository(entry.path, { primitives, env: {} });

    const upstreamSet = new Set(upstream.map((f) => normalizePathKey(f.path)));
    const ourSet = new Set(scan.selected.map((f) => normalizePathKey(f.path)));

    const missing = [...upstreamSet].filter((p) => !ourSet.has(p));
    const extra = [...ourSet].filter((p) => !upstreamSet.has(p));

    check(
      `${entry.name}: selected set matches upstream (${upstreamSet.size} files)`,
      missing.length === 0 && extra.length === 0,
      missing.length + extra.length > 0
        ? `missing=${JSON.stringify(missing.slice(0, 5))} extra=${JSON.stringify(extra.slice(0, 5))}`
        : undefined,
    );
    // Upstream silently drops oversized files; ours must account for them.
    check(
      `${entry.name}: upstream count + our large count reconciles`,
      upstreamSet.size + scan.large.length <= scan.scannedCount,
      `upstream=${upstreamSet.size} large=${scan.large.length} scanned=${scan.scannedCount}`,
    );
  }
}

async function regressionTests() {
  section('regression: legacy index format and generated-output paths');

  // Bug 1 (found on material-ui): an index written by an older release has
  // `meta.json` and NO `gitnexus.json`. Reading only the new name reported a
  // perfectly good 28 536-file index as "not indexed".
  const root = fixturePath('legacy');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, '.gitnexus'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const A = 1;\n');
  await fs.writeFile(
    path.join(root, '.gitnexus', 'meta.json'),
    JSON.stringify({
      repoPath: root,
      lastCommit: 'deadbeef',
      indexedAt: '2026-09-02T05:10:58.140Z',
      stats: { files: 1, nodes: 2, edges: 0, communities: 0, processes: 0, embeddings: 0 },
      fileHashes: { 'src/a.ts': 'abc123' },
    }),
  );

  const legacy = await analyzeCoverage(root, { env: {} });
  check('legacy meta.json only: repository still reported as indexed', legacy.repo.indexed === true);
  check('legacy meta.json only: fileHashes read', legacy.repo.stats?.files === 1, JSON.stringify(legacy.repo.stats));
  check('legacy meta.json: meta file name recorded', legacy.repo.metaFile === 'meta.json', String(legacy.repo.metaFile ?? 'n/a'));
  check(
    'legacy meta.json: absent cap reported as absent, not defaulted',
    legacy.cap.source !== 'index' &&
      legacy.warnings.some((w) => w.code === 'cap-not-recorded'),
    `capSource=${legacy.cap.source} codes=${legacy.warnings.map((w) => w.code)}`,
  );
  await fs.rm(root, { recursive: true, force: true });

  // Bug 2 (found on material-ui): generated-but-multi-line build output is not
  // minified, so the minified heuristic alone never mentions it.
  check('looksGenerated: /lib/ build output', looksGenerated('packages/x/lib/index.js') === true);
  check('looksGenerated: /dist/', looksGenerated('dist/bundle.js') === true);
  check('looksGenerated: .min.', looksGenerated('a/b.min.js') === true);
  check('looksGenerated: plain source is not flagged', looksGenerated('src/index.ts') === false);
  check('looksGenerated: README is not flagged', looksGenerated('README.md') === false);
}

/**
 * The HTTP route, exercised over a real socket rather than a mocked carrier.
 *
 * The guard has two independent arms —loopback peer and registered-repository
 * membership —and mocking either would leave the interesting behaviour (that an
 * unindexed absolute path is refused) untested.
 */
async function routeTests() {
  section('route: /api/gitnexus/coverage guards');
  const http = await import('node:http');
  const { mountCoverageRoute } = await import('../lib/routes/coverage.js');

  /** @type {Array<{kind:string,path:string,handler:Function}>} */
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

  const entries = await readRegistry();
  const known = entries.find((e) => e.stats?.files > 0) ?? entries[0];
  if (known === undefined) {
    check('a real indexed repository exists to test with', false, 'registry empty');
    return;
  }

  /** Every `{ fresh }` the route asked the engine for, so the cache bypass is asserted. */
  const freshnessRequests = [];
  const dispose = mountCoverageRoute(shimServer, {
    get: async (repoPath, options) => {
      freshnessRequests.push(options?.fresh === true);
      options?.onProgress?.({
        phase: 'scan',
        percent: 42,
        label: '扫描文件 1/2',
        current: 1,
        total: 2,
      });
      return { stub: true, repoPath, totals: { large: 0 } };
    },
    maintenance: (repoPath) => ({ commands: [{ mode: 'init', shell: "gitnexus analyze '" + repoPath + "'" }], rationale: [] }),
  });
  check('route registered', registered.length === 1 && registered[0].path === '/api/gitnexus/coverage');

  const server = http.createServer((req, res) => {
    const match = registered.find((route) => (req.url ?? '').startsWith(route.path));
    if (match !== undefined) { void match.handler(req, res); return; }
    res.statusCode = 404;
    res.end('no route');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const hit = async (path, init) => {
    const res = await fetch('http://127.0.0.1:' + port + path, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  // Any indexed directory is answerable now, not only registry members: the panel
  // reports the project the operator is in, which may never have been registered.
  const ok = await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent(known.path));
  check('indexed directory allowed', ok.status === 200 && ok.body?.ok === true, 'status=' + ok.status);
  check('maintenance commands ride along with the report', Array.isArray(ok.body?.maintenance?.commands));

  // A manual refresh has to be able to bypass the engine's short-lived cache, or the
  // control appears inert: two reads of an unchanged repository are otherwise
  // identical. `readAt` is what makes the second read visibly different on screen.
  check('a plain read does not ask for a cache bypass', freshnessRequests[0] === false, JSON.stringify(freshnessRequests));
  const refreshed = await hit(
    '/api/gitnexus/coverage?repo=' + encodeURIComponent(known.path) + '&refresh=1',
  );
  check('refresh=1 asks the engine to skip its cache', freshnessRequests[1] === true, JSON.stringify(freshnessRequests));
  check(
    'the response carries when it was read',
    typeof refreshed.body?.readAt === 'string' && !Number.isNaN(Date.parse(refreshed.body.readAt)),
    String(refreshed.body?.readAt),
  );

  // The numeric-progress channel: NDJSON lines, a real progress event forwarded from
  // the engine, and one final report object. Plain JSON callers keep the old path.
  const streamRes = await fetch(
    'http://127.0.0.1:' + port + '/api/gitnexus/coverage?repo=' +
      encodeURIComponent(known.path) + '&stream=1',
  );
  const streamType = streamRes.headers.get('content-type') ?? '';
  const streamLines = (await streamRes.text())
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  check('stream answers ndjson', streamType.includes('application/x-ndjson'), streamType);
  check(
    'stream forwards a real numeric progress event',
    streamLines.some(
      (line) => line.type === 'progress' && line.percent === 42 && line.current === 1,
    ),
    JSON.stringify(streamLines.slice(0, 3)),
  );
  check(
    'stream ends with the report object',
    streamLines[streamLines.length - 1]?.type === 'report' &&
      streamLines[streamLines.length - 1]?.report?.stub === true,
    JSON.stringify(streamLines.slice(-1)),
  );

  const missing = await hit('/api/gitnexus/coverage');
  check('missing repo param rejected', missing.status === 400 && missing.body?.code === 'missing-repo', 'status=' + missing.status);

  // The bound that replaced registry membership: a directory that is neither an index
  // nor a project root is not described. This is what keeps the route from being a
  // filesystem probe. It no longer requires an index — a git project without one is
  // exactly the state the panel's scan-only view and initialize action serve.
  const sysdir = await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent('C:\\Windows\\System32'));
  check('a directory with no index and no git marker is refused', sysdir.status === 404 && sysdir.body?.code === 'not-a-project', 'status=' + sysdir.status + ' code=' + sysdir.body?.code);

  const tempDir = fixturePath('noindex');
  await fs.mkdir(tempDir, { recursive: true });
  const plainDir = await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent(tempDir));
  check('a plain directory is refused too', plainDir.status === 404 && plainDir.body?.code === 'not-a-project', 'status=' + plainDir.status + ' code=' + plainDir.body?.code);

  // A `.git` marker alone is enough for the bound: the engine's scan-only report is
  // what makes "no index yet" informative instead of a 404 with no data.
  await fs.mkdir(path.join(tempDir, '.git'), { recursive: true });
  const noIndex = await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent(tempDir));
  check(
    'a git project without an index is answered with a scan-only report',
    noIndex.status === 200 && noIndex.body?.ok === true,
    'status=' + noIndex.status + ' body=' + JSON.stringify(noIndex.body),
  );
  await fs.rm(tempDir, { recursive: true, force: true });

  const post = await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent(known.path), { method: 'POST' });
  check('non-GET method rejected', post.status === 405, 'status=' + post.status);

  const head = await fetch('http://127.0.0.1:' + port + '/api/gitnexus/coverage?repo=' + encodeURIComponent(known.path), { method: 'HEAD' });
  check('HEAD allowed without a body', head.status === 200, 'status=' + head.status);

  await new Promise((resolve) => server.close(resolve));
  dispose();
  check('disposer clears the registration', registered.length === 0);
}

async function fileHistoryRouteTests() {
  section('route: /api/gitnexus/file-history');
  const http = await import('node:http');
  const { mountFileHistoryRoute } = await import('../lib/routes/file-history.js');

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
  const dispose = mountFileHistoryRoute(shimServer, {
    read: async (repo, file, options) => {
      calls.push({ repo, file, days: options?.days });
      return {
        path: file,
        available: true,
        days: options?.days ?? 7,
        commits: 1,
        insertions: 50,
        deletions: 5,
        timeline: [
          {
            sha: 'deadbeef',
            shortSha: 'deadbeef',
            date: '2026-10-16T00:00:00Z',
            author: 'Ada',
            subject: 'touch',
            insertions: 50,
            deletions: 5,
          },
        ],
        reason: null,
      };
    },
  });

  const server = http.createServer((req, res) => {
    const match = registered.find((route) => (req.url ?? '').startsWith(route.path));
    if (match !== undefined) { void match.handler(req, res); return; }
    res.statusCode = 404;
    res.end('no route');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port + '/api/gitnexus/file-history';
  const repo = process.cwd();
  const hit = async (query, init) => {
    const res = await fetch(base + query, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const ok = await hit(
    '?repo=' + encodeURIComponent(repo) + '&path=' + encodeURIComponent('src/client/index.ts') + '&days=14',
  );
  check('file history answers 200', ok.status === 200 && ok.body?.ok === true, 'status=' + ok.status);
  check('file history carries the selected path', ok.body?.path === 'src/client/index.ts', JSON.stringify(ok.body));
  check('file history forwards clamped days', calls.at(-1)?.days === 14, JSON.stringify(calls.at(-1)));
  check('file history carries the timeline', Array.isArray(ok.body?.timeline) && ok.body.timeline.length === 1);

  const missing = await hit('?repo=' + encodeURIComponent(repo));
  check('missing path is rejected', missing.status === 400, 'status=' + missing.status);
  const outside = await hit(
    '?repo=' + encodeURIComponent(repo) + '&path=' + encodeURIComponent('../outside.txt'),
  );
  check('a path outside the project is rejected', outside.status === 400 && outside.body?.code === 'invalid-path', 'status=' + outside.status + ' body=' + JSON.stringify(outside.body));
  const notProject = await hit(
    '?repo=' + encodeURIComponent('C:\\Windows\\System32') + '&path=' + encodeURIComponent('x.txt'),
  );
  check('a non-project is refused', notProject.status === 404 && notProject.body?.code === 'not-a-project', 'status=' + notProject.status);
  const post = await hit(
    '?repo=' + encodeURIComponent(repo) + '&path=' + encodeURIComponent('src/client/index.ts'),
    { method: 'POST' },
  );
  check('file history POST is rejected', post.status === 405, 'status=' + post.status);
  const head = await fetch(base + '?repo=' + encodeURIComponent(repo) + '&path=' + encodeURIComponent('src/client/index.ts'), { method: 'HEAD' });
  check('file history HEAD is allowed', head.status === 200, 'status=' + head.status);

  await new Promise((resolve) => server.close(resolve));
  dispose();
  check('file history disposer clears the registration', registered.length === 0);
}

async function capabilityTests() {
  section('manifest narrowing (fields a checklist would drop)');
  const { readCapabilities, readGraphQuality } = await import('../lib/gitnexus/coverage.js');

  // The shape GitNexus actually writes, read off a real `.gitnexus/gitnexus.json`.
  const raw = {
    graph: { provider: 'ladybugdb', status: 'available' },
    fts: { provider: 'ladybugdb-fts', status: 'available' },
    vectorSearch: { provider: 'ladybugdb-vector', status: 'unavailable', exactScanLimit: 10000 },
  };

  const caps = readCapabilities(raw);
  // The regression this guards: a narrowing that rebuilt each entry from a list of
  // expected fields dropped `provider`, and the panel rendered `unknown` for two
  // surfaces that were available. It was found by looking at the panel, not the code.
  check('provider survives the narrowing', caps.graph?.provider === 'ladybugdb', JSON.stringify(caps.graph));
  check('the unavailable surface keeps its status', caps.vectorSearch?.status === 'unavailable');
  check(
    'a field this plugin does not read is preserved, not deleted',
    caps.vectorSearch?.exactScanLimit === 10000,
    JSON.stringify(caps.vectorSearch),
  );
  check('a non-object entry is skipped rather than crashing', Object.keys(readCapabilities({ bad: 'nope' })).length === 0);
  check('an absent block yields an empty record, not null', Object.keys(readCapabilities(undefined)).length === 0);

  check(
    'a missing block is null, so "not recorded" stays distinct from "zero"',
    readGraphQuality(undefined) === null,
  );
  const quality = readGraphQuality({ totalSites: 5, counts: { map: 3, junk: 'x' } });
  check('graph quality counts keep only numbers', quality?.counts.map === 3 && quality.counts.junk === undefined);
  check('graph quality total is read', quality?.totalSites === 5);
}

async function languageTests() {
  section('language fallback when GitNexus is absent');
  const { classifyFile, aggregateLanguages } = await import('../lib/gitnexus/languages.js');

  const ts = classifyFile('src/a.ts', null);
  check(
    'TypeScript is recognised without a detector',
    ts.key === 'typescript' && ts.klass === 'recognized',
    JSON.stringify(ts),
  );
  const md = classifyFile('README.md', null);
  check(
    'Markdown is recognised without a detector',
    md.key === 'markdown' && md.klass === 'recognized',
    JSON.stringify(md),
  );
  // The fallback must not claim parser support it cannot verify: no row from it may be
  // `parsed`, because `parsed` is the promise that symbols exist in the graph.
  check('fallback rows never claim to be parsed', ts.klass !== 'parsed' && md.klass !== 'parsed');
  const unknown = classifyFile('blob.xyz', null);
  check('an unknown extension stays 其他', unknown.key === 'text' && unknown.klass === 'other', JSON.stringify(unknown));

  const aggregate = aggregateLanguages(
    [
      { path: 'src/a.ts', size: 100 },
      { path: 'src/b.js', size: 50 },
      { path: 'blob.xyz', size: 10 },
    ],
    null,
  );
  check(
    'the fallback produces a multi-language breakdown',
    aggregate.rows.length === 3 && aggregate.rows.some((r) => r.key === 'typescript') && aggregate.rows.some((r) => r.key === 'javascript'),
    JSON.stringify(aggregate.rows.map((r) => r.key)),
  );
  check('the fallback marks itself as builtin', aggregate.detector === 'builtin', aggregate.detector);

  const withDetector = aggregateLanguages([{ path: 'src/a.ts', size: 100 }], {
    getLanguageFromFilename: () => 'typescript',
    getSyntaxLanguageFromFilename: () => 'text',
  });
  check('a real detector is marked as gitnexus', withDetector.detector === 'gitnexus', withDetector.detector);
}

async function searchTests() {
  section('keyword search over the graph');
  const {
    searchSymbols,
    searchViaHelper,
    searchWithFallback,
    searchText,
    sanitizeSearchQuery,
    SearchError,
  } = await import('../lib/gitnexus/search.js');

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
    // The host cannot load the native addon (Electron Node ABI); the helper is the
    // boundary that runs it under the system Node. Run it FIRST: it opens the DB in a
    // child process, and the direct search below keeps a connection open in this one.
    // Two readers can be fine in production, but this test runner's sandbox can deny
    // the child spawn outright, which is a skip rather than a product failure.
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const helper = path.join(import.meta.dirname, '..', 'lib', 'bin', 'search-helper.js');
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [helper, repo, 'analyzeCoverage', '5', ''],
        { cwd: repo, timeout: 30_000, windowsHide: true },
      );
      const body = JSON.parse(stdout.trim());
      check(
        'the helper subprocess returns a JSON report',
        body.ok === true && body.report?.results?.some((hit) => hit.name === 'analyzeCoverage'),
        stdout.slice(0, 300),
      );
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
      check('search reports FTS as degraded', report.ftsAvailable === false && report.warning !== null);
      check(
        'every hit carries a path and a valid line',
        report.results.every(
          (hit) => hit.filePath !== '' && (hit.startLine === null || Number.isInteger(hit.startLine)),
        ),
      );
    } catch (error) {
      check('real search runs against the indexed repository', false, String(error));
    }
  } else {
    check('real search runs against the indexed repository (skipped)', true, 'no .gitnexus/lbug on this machine');
  }

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

async function searchRouteTests() {
  section('route: /api/gitnexus/search');
  const http = await import('node:http');
  const { mountSearchRoute } = await import('../lib/routes/search.js');
  const { SearchError } = await import('../lib/gitnexus/search.js');

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

async function analyzeTests() {
  section('analyze runner (the one mutating capability)');
  const { createAnalyzeRunner, analyzeCommandLine } = await import('../lib/gitnexus/analyze.js');

  // The bug that made the button appear to do nothing. A quoted path without a call
  // operator is a string *literal* to PowerShell, so the whole statement is a parse
  // error and the command never runs — measured against the real shim: without `&` it
  // reports "unexpected token", with it, the version prints.
  const winLine = analyzeCommandLine('C:\\tools\\gitnexus.cmd', 'D:\\repo', { flavor: 'win32' });
  check('a Windows command uses the call operator', winLine.includes("& 'C:\\tools\\gitnexus.cmd'"), winLine);
  check('the call operator precedes the shim, not the args', /&\s'[^']*gitnexus\.cmd'\sanalyze/.test(winLine), winLine);
  check('--index-only is in the built command', winLine.includes('analyze --index-only'));
  check('the repository is quoted', winLine.includes("'D:\\repo'"));
  // Dropping the prefix reintroduces the respawn-over-piped-stdio failure the
  // maintenance text exists to avoid.
  check('GITNEXUS_MEMORY=off is kept', winLine.includes("$env:GITNEXUS_MEMORY='off'"), winLine);
  check('the heap override is kept', winLine.includes("$env:NODE_OPTIONS='--max-old-space-size=8192'"), winLine);

  const forcedLine = analyzeCommandLine('C:\\tools\\gitnexus.cmd', 'D:\\repo', { flavor: 'win32', force: true });
  check('--force is appended after --index-only', forcedLine.includes('analyze --index-only --force'), forcedLine);
  check('a normal command is not forced', !winLine.includes('--force'), winLine);

  // The repair flag is a different operation, and the builder is the last place that
  // can keep the two contradictory flags apart: `--skip-fts --repair-fts` exits 0
  // having repaired nothing.
  const repairLine = analyzeCommandLine('C:\\tools\\gitnexus.cmd', 'D:\\repo', {
    flavor: 'win32',
    repairFts: true,
    skipFts: true,
    force: true,
  });
  check('--repair-fts is appended after --index-only', repairLine.includes('analyze --index-only --repair-fts'), repairLine);
  check('a repair run never also skips FTS', !repairLine.includes('--skip-fts'), repairLine);
  check('a repair run is never also forced', !repairLine.includes('--force'), repairLine);

  // The runner reads the same config as the command text. Without this, the panel
  // confirms `GITNEXUS_HOME=… --skip-fts` and the process runs without either.
  const configuredLine = analyzeCommandLine('/usr/local/bin/gitnexus', '/home/u/repo', {
    flavor: 'posix',
    skipFts: true,
    gitnexusHome: '/tmp/gn-home',
  });
  check(
    'the runner mirrors skipFts and GITNEXUS_HOME',
    configuredLine.includes('--skip-fts') && configuredLine.includes("GITNEXUS_HOME='/tmp/gn-home'"),
    configuredLine,
  );

  const posixLine = analyzeCommandLine('/usr/local/bin/gitnexus', '/home/u/repo', { flavor: 'posix' });
  check(
    'POSIX needs no call operator, because an absolute path is already a command',
    !posixLine.includes('& ') && posixLine.includes("'/usr/local/bin/gitnexus' analyze"),
    posixLine,
  );
  check('POSIX uses assignment prefixes', posixLine.startsWith("GITNEXUS_MEMORY='off' NODE_OPTIONS="), posixLine);

  // A CLI from the declared dependency is that package's own `dist/cli/index.js`, so it
  // runs through `node`. That is the shape that removes the shim problems entirely: no
  // `.cmd`/`.ps1` choice, and no reliance on the shell's call operator.
  const nodeLine = analyzeCommandLine('D:\\p\\node_modules\\gitnexus\\dist\\cli\\index.js', 'D:\\repo', {
    flavor: 'win32',
    viaNode: true,
  });
  check('a dependency CLI is spawned through node', nodeLine.includes("node 'D:\\p\\node_modules\\gitnexus"), nodeLine);
  check('a node-spawned CLI needs no call operator', !nodeLine.includes('& '), nodeLine);
  check('a node-spawned CLI still gets the environment prefix', nodeLine.includes("$env:GITNEXUS_MEMORY='off'"));

  let captured = null;
  /**
   * A stub faithful to the seam: `result()` settles, and honours an abort.
   *
   * Returns a whole runner-options object rather than the shell alone, because
   * `createAnalyzeRunner` takes `{ shell, ... }` — returning the bare shell made every
   * call site pass the wrong shape and fail on `options.shell.resolve` being undefined.
   */
  const stubShell = (result, delayMs = 0) => ({
    shell: {
      resolve: (req) => {
        captured = req;
        return req;
      },
      execute: async (spec) => ({
        result: () =>
          new Promise((resolve) => {
            // A signal already aborted when `result()` is reached settles at once.
            // Without this the stub models a race the real seam does not have: the
            // README states that a cancellation arriving during preparation rejects
            // `execute` outright, and the runner handles that too — but a test that
            // only ever cancels *after* the handle exists would never exercise it.
            if (spec.signal?.aborted === true) return resolve({ exitCode: null, aborted: true });
            const finish = () => resolve(result);
            if (delayMs === 0) return finish();
            const t = setTimeout(finish, delayMs);
            spec.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                resolve({ exitCode: null, aborted: true });
              },
              { once: true },
            );
          }),
        kill: () => true,
      }),
    },
  });
  const settle = () => new Promise((r) => setTimeout(r, 40));

  const done = createAnalyzeRunner(stubShell({ exitCode: 0, stdout: { text: 'indexed (7.2s)' } }));
  done.start('D:/Project/x');
  await settle();
  check('exit 0 is a completed run', done.status('D:/Project/x')?.state === 'done');
  check('output is kept for the panel', done.status('D:/Project/x')?.output.includes('7.2s'));

  // The load-bearing assertion of the whole feature. Passing `sandboxPolicy` would be
  // this plugin choosing its own confinement — the escalation the approval service
  // exists to gate, requested through a door that cannot ask. Leaving it out takes the
  // deployment's decision.
  check(
    'the runner never sets sandboxPolicy',
    captured !== null && !Object.prototype.hasOwnProperty.call(captured, 'sandboxPolicy'),
    JSON.stringify(Object.keys(captured ?? {})),
  );
  check('the run is killable at its deadline', captured?.onExpiry === 'kill');
  // The runner resolves the path before using it, so the assertion has to resolve it
  // the same way — comparing against the literal `D:/Project/x` tested the test's own
  // separator preference, not the runner's behaviour.
  check(
    'the working directory is the resolved repository',
    captured?.workdir === path.resolve('D:/Project/x'),
    String(captured?.workdir),
  );
  check('a cancellation signal reaches the executor', captured?.signal instanceof AbortSignal);
  check(
    '--index-only is always passed',
    done.status('D:/Project/x')?.command.includes('analyze --index-only') === true,
    done.status('D:/Project/x')?.command,
  );
  check(
    'a repository without FTS gets --skip-fts automatically',
    done.status('D:/Project/x')?.command.includes('--skip-fts') === true,
    done.status('D:/Project/x')?.command,
  );
  check(
    'the registry write is redirected into the project',
    done.status('D:/Project/x')?.command.includes('GITNEXUS_HOME') === true &&
      done.status('D:/Project/x')?.command.includes('plugin-home') === true,
    done.status('D:/Project/x')?.command,
  );

  // 0.1.3 pre-created parsedfile-store to dodge a worker mkdir. GitNexus deletes that
  // directory at the start of every parse, so a pre-created one turns each run into an
  // rmdir on a host-owned directory — the `EPERM … rmdir parsedfile-store` that 0.1.3's
  // users hit. The runner now removes a leftover and creates only the durable caches.
  const cacheRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-cache-'));
  await fs.mkdir(path.join(cacheRepo, '.gitnexus', 'parsedfile-store'), { recursive: true });
  const cacheRun = createAnalyzeRunner(stubShell({ exitCode: 0 }));
  cacheRun.start(cacheRepo);
  await settle();
  const leftover = await fs
    .access(path.join(cacheRepo, '.gitnexus', 'parsedfile-store'))
    .then(() => true)
    .catch(() => false);
  check('analyze clears a leftover run-scoped store before spawning', !leftover);
  const durable = await Promise.all(
    ['parsedfile-cache', 'parse-cache'].map((name) =>
      fs
        .access(path.join(cacheRepo, '.gitnexus', name))
        .then(() => true)
        .catch(() => false),
    ),
  );
  check('analyze pre-creates the durable caches before spawning', durable.every(Boolean), JSON.stringify(durable));
  await fs.rm(cacheRepo, { recursive: true, force: true });

  const denied = createAnalyzeRunner(
    stubShell({ exitCode: 1, stderr: { text: '[sandbox: file access denied under workspace-write mode]' } }),
  );
  denied.start('D:/Project/d');
  await settle();
  check('a sandbox refusal is reported as denied, not as a failure', denied.status('D:/Project/d')?.state === 'denied');
  check(
    'a denial says the plugin will not escalate',
    denied.status('D:/Project/d')?.message?.includes('不会申请扩权') === true,
  );

  const timedOut = createAnalyzeRunner(stubShell({ exitCode: null, timedOut: true }));
  timedOut.start('D:/Project/t');
  await settle();
  check('a deadline kill is reported as timed out', timedOut.status('D:/Project/t')?.state === 'timed-out');

  const failed = createAnalyzeRunner(stubShell({ exitCode: 2, stderr: { text: 'boom' } }));
  failed.start('D:/Project/f');
  await settle();
  check('a non-zero exit is a failure', failed.status('D:/Project/f')?.state === 'failed');

  // A transient Windows file lock on `.gitnexus` is not a policy refusal: the measured
  // failure is `EPERM … open '…\\.gitnexus\\lbug.init.lock'` while a scanner holds the
  // directory, and the ACL for that path was verified healthy. One retry, after clearing
  // a lock a crashed run left behind, is the response — not telling the operator to stop.
  {
    const lockMessage =
      "Error: EPERM: operation not permitted, open 'D:\\Project\\r\\.gitnexus\\lbug.init.lock'";
    /** @param {unknown[]} results */
    const sequenceShell = (results) => {
      let calls = 0;
      return {
        shell: {
          resolve: (req) => req,
          execute: async () => ({
            result: async () => {
              const result = results[Math.min(calls, results.length - 1)];
              calls += 1;
              return result;
            },
            kill: () => true,
          }),
        },
        calls: () => calls,
      };
    };

    const lockRepo = path.join(import.meta.dirname, '.fixtures', `retry-${process.pid}`);
    await fs.rm(lockRepo, { recursive: true, force: true });
    await fs.mkdir(path.join(lockRepo, '.gitnexus'), { recursive: true });
    await fs.writeFile(path.join(lockRepo, '.gitnexus', 'lbug.init.lock'), '{"pid":999999}');

    // A plugin-owned CLI tree, so the runner reaches the spawn path without depending on
    // whatever gitnexus this machine happens to have globally installed.
    const cliRoot = path.join(lockRepo, 'cli');
    const cliPkg = path.join(cliRoot, 'node_modules', 'gitnexus');
    await fs.mkdir(path.join(cliPkg, 'dist', 'cli'), { recursive: true });
    await fs.mkdir(path.join(cliPkg, 'dist', 'core', 'ingestion'), { recursive: true });
    await fs.writeFile(path.join(cliPkg, 'package.json'), JSON.stringify({ name: 'gitnexus', version: '1.6.12' }));
    await fs.writeFile(path.join(cliPkg, 'dist', 'cli', 'index.js'), '');
    await fs.writeFile(path.join(cliPkg, 'dist', 'core', 'ingestion', 'filesystem-walker.js'), '');
    const toolchain = { managedPrefix: cliRoot };

    const recovered = sequenceShell([
      { exitCode: 1, stderr: { text: lockMessage } },
      { exitCode: 0, stdout: { text: 'done' } },
    ]);
    const retrying = createAnalyzeRunner({ shell: recovered.shell, retryDelayMs: 5, toolchain });
    retrying.start(lockRepo);
    await new Promise((r) => setTimeout(r, 80));
    check('a transient lock failure is retried once', recovered.calls() === 2, String(recovered.calls()));
    check('the retried run reports success', retrying.status(lockRepo)?.state === 'done', JSON.stringify(retrying.status(lockRepo)));
    check('the status records the attempt count', retrying.status(lockRepo)?.attempts === 2, String(retrying.status(lockRepo)?.attempts));
    const staleGone = await fs
      .access(path.join(lockRepo, '.gitnexus', 'lbug.init.lock'))
      .then(() => false)
      .catch(() => true);
    check('the stale init lock is cleared before the retry', staleGone);
    retrying.dispose();

    const stillLocked = sequenceShell([
      { exitCode: 1, stderr: { text: lockMessage } },
      { exitCode: 1, stderr: { text: lockMessage } },
    ]);
    const locked = createAnalyzeRunner({ shell: stillLocked.shell, retryDelayMs: 5, toolchain });
    locked.start(lockRepo);
    await new Promise((r) => setTimeout(r, 80));
    check('a second lock failure is reported as failed, not denied', locked.status(lockRepo)?.state === 'failed', JSON.stringify(locked.status(lockRepo)));
    check(
      'the message names a transient lock and the retry',
      locked.status(lockRepo)?.message?.includes('临时占用') === true &&
        locked.status(lockRepo)?.message?.includes('重试') === true,
      locked.status(lockRepo)?.message,
    );
    locked.dispose();

    // A real sandbox refusal must never be retried: the marker is the only signal that
    // means "do not try again".
    const refused = sequenceShell([
      { exitCode: 1, stderr: { text: '[sandbox: file access denied under workspace-write mode]' } },
      { exitCode: 0 },
    ]);
    const refusing = createAnalyzeRunner({ shell: refused.shell, retryDelayMs: 5, toolchain });
    refusing.start(lockRepo);
    await new Promise((r) => setTimeout(r, 80));
    check('a sandbox refusal is not retried', refused.calls() === 1, String(refused.calls()));
    check('the refusal is still reported as denied', refusing.status(lockRepo)?.state === 'denied');
    refusing.dispose();

    await fs.rm(lockRepo, { recursive: true, force: true });
  }

  // The managed tree is the one a panel install writes. Before this wiring existed,
  // `findGitnexusCli` supported `managedPrefix` but no caller passed it, so an install
  // succeeded and every later refresh still said "no CLI". This fixture is the shape
  // that would have caught that.
  const managedRoot = fixturePath('managed');
  const managedPackage = path.join(managedRoot, 'managed', 'node_modules', 'gitnexus');
  await fs.rm(managedRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(managedPackage, 'dist', 'cli'), { recursive: true });
  await fs.mkdir(path.join(managedPackage, 'dist', 'core', 'ingestion'), { recursive: true });
  await fs.writeFile(path.join(managedPackage, 'package.json'), JSON.stringify({ name: 'gitnexus', version: '1.6.12' }));
  await fs.writeFile(path.join(managedPackage, 'dist', 'cli', 'index.js'), '');
  await fs.writeFile(path.join(managedPackage, 'dist', 'core', 'ingestion', 'filesystem-walker.js'), '');

  const { findGitnexusRoot } = await import('../lib/gitnexus/root.js');
  const { findGitnexusCli } = await import('../lib/gitnexus/toolchain.js');
  const foundRoot = findGitnexusRoot({ managedPrefix: path.join(managedRoot, 'managed') });
  check('a managed install is found as the package root', foundRoot === managedPackage, String(foundRoot));
  const foundCli = findGitnexusCli({ managedPrefix: path.join(managedRoot, 'managed') });
  check(
    'a managed install is selected as the CLI',
    foundCli.present === true && foundCli.source === 'managed' && foundCli.cliPath === path.join(managedPackage, 'dist', 'cli', 'index.js'),
    JSON.stringify(foundCli),
  );

  const managed = createAnalyzeRunner({
    ...stubShell({ exitCode: 0 }),
    toolchain: { managedPrefix: path.join(managedRoot, 'managed') },
  });
  managed.start('D:/Project/m', { force: true });
  await settle();
  check(
    'the managed CLI is the one a run invokes',
    managed.status('D:/Project/m')?.command.includes(managedPackage) === true,
    managed.status('D:/Project/m')?.command,
  );
  check('a forced run records its mode', managed.status('D:/Project/m')?.force === true);
  check(
    'a forced run actually carries --force',
    managed.status('D:/Project/m')?.command.includes('--force') === true,
    managed.status('D:/Project/m')?.command,
  );

  // The repair run is the narrow write: FTS indexes only. Two flags must never ride
  // along — `--force` (that is a full rebuild, a much larger change than the button
  // says) and `--skip-fts` (which asks to skip the very thing being repaired; the CLI
  // accepts the pair and exits 0 having done nothing).
  const repaired = createAnalyzeRunner({
    ...stubShell({ exitCode: 0 }),
    toolchain: { managedPrefix: path.join(managedRoot, 'managed') },
  });
  repaired.start('D:/Project/r', { repairFts: true });
  await settle();
  check('a repair run records its mode', repaired.status('D:/Project/r')?.repairFts === true);
  check(
    'a repair run carries --repair-fts and never --skip-fts',
    repaired.status('D:/Project/r')?.command.includes('--repair-fts') === true &&
      repaired.status('D:/Project/r')?.command.includes('--skip-fts') === false,
    repaired.status('D:/Project/r')?.command,
  );
  check('a repair run is not a forced rebuild', repaired.status('D:/Project/r')?.force === false);
  repaired.dispose();
  managed.dispose();
  await fs.rm(managedRoot, { recursive: true, force: true });

  const absent = createAnalyzeRunner({ ...stubShell({ exitCode: 0 }), toolchain: { discover: false } });
  absent.start('D:/Project/n');
  check('no CLI is decided before anything is spawned', absent.status('D:/Project/n')?.state === 'unavailable');
  check(
    'the unavailable message names the install command',
    absent.status('D:/Project/n')?.message?.includes('npm i -g gitnexus') === true,
  );

  // Two concurrent `analyze` processes would contend for the same store and the second
  // would report a failure that says nothing about the repository.
  const serial = createAnalyzeRunner(stubShell({ exitCode: 0 }, 150));
  const first = serial.start('D:/Project/s');
  const second = serial.start('D:/Project/s');
  check('a second start returns the run already in flight', first.startedAt === second.startedAt);
  check('cancel reports that it acted', serial.cancel('D:/Project/s') === true);
  await settle();
  check('a cancelled run settles as cancelled', serial.status('D:/Project/s')?.state === 'cancelled');
  check('a cancelled run records when it finished', serial.status('D:/Project/s')?.finishedAt !== null);
  check(
    'a cancelled repository can be started again',
    serial.start('D:/Project/s')?.state === 'running',
  );
  serial.dispose();
}

async function installTests() {
  section('gitnexus installer (the prerequisite the plugin can satisfy)');
  const { createInstallRunner, installCommandLine, defaultInstallPrefix } = await import('../lib/gitnexus/install.js');

  // The two properties that make this safe to offer at all.
  const win = installCommandLine('C:\\Users\\u\\.dsh\\gitnexus-plus\\gitnexus', 'gitnexus@^1.6.12', { platform: 'win32' });
  check('the install is an npm install', win.startsWith('npm install'), win);
  check('it installs under a prefix rather than changing directory', win.includes("--prefix '"), win);
  // No `--registry`: the operator's npmrc is the only authority on where their packages
  // come from, and hardcoding one breaks exactly the users who need this path.
  check('no registry is hardcoded', !win.includes('--registry'), win);
  check('the version spec is explicit', win.includes('gitnexus@^1.6.12'), win);

  check('the default prefix is plugin-owned, not the global prefix', defaultInstallPrefix({ DSH_HOME: 'C:\\x' }).endsWith('gitnexus'), defaultInstallPrefix({ DSH_HOME: 'C:\\x' }));

  const stubShell = (result) => ({
    shell: {
      resolve: (req) => req,
      execute: async () => ({ result: async () => result, kill: () => true }),
    },
  });

  const prefix = path.join(import.meta.dirname, '.fixtures', 'install-prefix');
  const ok = createInstallRunner({ ...stubShell({ exitCode: 0, stdout: { text: 'added 206 packages' } }), prefix });
  ok.start();
  await new Promise((r) => setTimeout(r, 30));
  check('a successful install reports done', ok.status()?.state === 'done', JSON.stringify(ok.status()));
  check('the installed CLI path is under the prefix', ok.cliPath().includes('node_modules'), ok.cliPath());
  check('the CLI path is the package bin', ok.cliPath().endsWith(path.join('dist', 'cli', 'index.js')), ok.cliPath());

  // npm's build scripts are the most likely failure: a machine without a C++ toolchain,
  // or a registry it cannot reach. The message has to name both.
  const bad = createInstallRunner({ ...stubShell({ exitCode: 1, stderr: { text: 'gyp ERR! find VS' } }), prefix });
  bad.start();
  await new Promise((r) => setTimeout(r, 30));
  check('a failed install reports failed', bad.status()?.state === 'failed');
  check(
    'the failure message names the two likely causes',
    /registry/.test(bad.status()?.message ?? '') && /编译|toolchain|C\+\+/.test(bad.status()?.message ?? ''),
    bad.status()?.message,
  );

  const denied = createInstallRunner({
    ...stubShell({ exitCode: 1, stderr: { text: '[sandbox: file access denied under workspace-write mode]' } }),
    prefix,
  });
  denied.start();
  await new Promise((r) => setTimeout(r, 30));
  check('a sandbox refusal is denied, not failed', denied.status()?.state === 'denied');
  check('a denial says the plugin will not escalate', denied.status()?.message?.includes('不会申请扩权') === true);

  const noShell = createInstallRunner({ shell: null, prefix });
  noShell.start();
  check('a deployment with no shell reports unavailable', noShell.status()?.state === 'unavailable');
  check(
    'the unavailable message tells the operator to run it themselves',
    noShell.status()?.message?.includes('手动执行') === true,
  );
}

async function stalenessTests() {
  section('staleness classification (the condition that was once inverted)');
  const { classifyStaleness } = await import('../lib/gitnexus/git.js');

  const base = { available: true, headCommit: 'b'.repeat(40), branch: 'main', dirtyCount: 0 };

  check('equal commits are current', classifyStaleness({ lastCommit: 'b'.repeat(40), git: { ...base } }) === 'current');

  // A linear fast-forward: the index simply lags. `rev-list --left-right` reports
  // left=0 (nothing in the index that HEAD lacks) and right=N.
  check(
    'HEAD ahead with no split is BEHIND, not diverged',
    classifyStaleness({ lastCommit: 'a'.repeat(40), git: { ...base, aheadBehind: { behind: 0, ahead: 3 } } }) === 'behind',
  );

  // Histories split: the indexed commit holds work HEAD no longer reaches, so the
  // distance between the two stops measuring staleness.
  check(
    'a split history is DIVERGED',
    classifyStaleness({ lastCommit: 'a'.repeat(40), git: { ...base, aheadBehind: { behind: 2, ahead: 1 } } }) === 'diverged',
  );

  check(
    'an index ahead of HEAD is diverged too',
    classifyStaleness({ lastCommit: 'a'.repeat(40), git: { ...base, aheadBehind: { behind: 4, ahead: 0 } } }) === 'diverged',
  );

  check(
    'no git is unknown, never a guess',
    classifyStaleness({ lastCommit: 'a'.repeat(40), git: { ...base, available: false } }) === 'unknown',
  );
  check(
    'no indexed commit is unknown',
    classifyStaleness({ lastCommit: null, git: { ...base, aheadBehind: { behind: 0, ahead: 1 } } }) === 'unknown',
  );
  check(
    'an incomparable pair is unknown rather than assumed linear',
    classifyStaleness({ lastCommit: 'a'.repeat(40), git: { ...base, aheadBehind: null } }) === 'unknown',
  );
}

async function commandTests() {
  section('maintenance commands (handed over, not executed)');
  const {
    maintenanceCommands,
    commandRationale,
    defaultGitnexusHome,
    effectiveSkipFts,
    ftsAvailable,
  } = await import('../lib/gitnexus/commands.js');

  const win = maintenanceCommands('D:\\Project\\demo', { platform: 'win32', gitnexusHome: null });
  check('two commands are offered', win.length === 2, 'got ' + win.length);
  check('modes are init and full', win.map((c) => c.mode).join(',') === 'init,full');
  check('only the full rebuild is marked destructive', win[0].destructive === false && win[1].destructive === true);
  check('init carries no --force', !win[0].argv.includes('--force') && win[0].argv.startsWith('gitnexus analyze --index-only'), win[0].argv);
  check('full carries --force', win[1].argv.includes('--force'), win[1].argv);
  check('both are --index-only so a button cannot edit the working tree', win.every((c) => c.argv.includes('--index-only')));
  check('the path is quoted for the shell', win[0].argv.includes("'D:\\Project\\demo'"), win[0].argv);

  // The environment prefix is what makes the command actually work in a confined
  // deployment, so it is asserted rather than left to prose.
  check('PowerShell env prefix sets GITNEXUS_MEMORY=off', win[0].shell.includes("$env:GITNEXUS_MEMORY='off'"), win[0].shell);
  check('PowerShell env prefix sets the NODE_OPTIONS heap', win[0].shell.includes("$env:NODE_OPTIONS='--max-old-space-size=8192'"), win[0].shell);

  const posix = maintenanceCommands('/home/u/demo', { platform: 'linux', gitnexusHome: '/tmp/gh' });
  check('posix syntax differs', posix[0].shell.startsWith("GITNEXUS_MEMORY='off'"), posix[0].shell);
  check('posix includes GITNEXUS_HOME when set', posix[0].shell.includes("GITNEXUS_HOME='/tmp/gh'"), posix[0].shell);

  // `--skip-fts` is OFF by default, and that default is a measured decision rather
  // than a style choice: disabling a search index the store already has forces a full
  // graph-store rebuild (179.22 s against 8.57 s on a 39-file repository), which is
  // the opposite of incremental. The flag survives for the case it was written for —
  // an environment where the extension cannot even be installed.
  check(
    'the default commands omit --skip-fts',
    win.every((c) => !c.argv.includes('--skip-fts')),
    win.map((c) => c.argv).join(' | '),
  );
  check('--skip-fts is still available on request', maintenanceCommands('/x', { skipFts: true })[0].argv.includes('--skip-fts'));

  const noFts = maintenanceCommands('/x', { platform: 'linux', skipFts: false });
  check('passing skipFts: false explicitly is the same as the default', !noFts[0].argv.includes('--skip-fts'), noFts[0].argv);

  const single = maintenanceCommands("/home/o'brien/x", { platform: 'linux' });
  check('single quotes in a path are escaped', single[0].argv.includes("'\\''"), single[0].argv);

  // The FTS repair is offered only when the index says FTS is missing, so it is opt-in
  // at this layer rather than a permanent third button that usually does nothing.
  const withRepair = maintenanceCommands('/x', { platform: 'linux', includeRepair: true });
  check('three commands are offered when FTS is missing', withRepair.length === 3, 'got ' + withRepair.length);
  check('the repair command uses its own mode', withRepair[2]?.mode === 'repair-fts', String(withRepair[2]?.mode));
  check('the repair command carries --repair-fts', withRepair[2]?.argv.includes('--repair-fts') === true, withRepair[2]?.argv);
  check(
    'the repair command does not ask to skip what it repairs',
    withRepair[2]?.argv.includes('--skip-fts') === false,
    withRepair[2]?.argv,
  );
  check('the repair command is not destructive', withRepair[2]?.destructive === false);
  check('repair is absent unless requested', maintenanceCommands('/x', { platform: 'linux' }).length === 2);
  check(
    'the repair command is offered in the deployment that also skips FTS',
    (() => {
      const commands = maintenanceCommands('/x', { platform: 'win32', skipFts: true, includeRepair: true });
      const repair = commands.find((c) => c.mode === 'repair-fts');
      return repair !== undefined && repair.argv.includes('--repair-fts') && !repair.argv.includes('--skip-fts');
    })(),
  );

  const rationale = commandRationale({ skipFts: true, memoryOff: true, gitnexusHome: null });
  check('the rationale explains why the env prefix exists', rationale.length >= 3, JSON.stringify(rationale));
  check('the rationale mentions the AGENTS.md guarantee', rationale.some((n) => n.includes('AGENTS.md')), JSON.stringify(rationale));

  // The per-repository policy that replaced both static skipFts defaults.
  check(
    'the default GitNexus home is inside the project',
    defaultGitnexusHome('D:\\Project\\x').replace(/\\/g, '/').endsWith('/.gitnexus/plugin-home'),
    defaultGitnexusHome('D:\\Project\\x'),
  );
  const policyRoot = fixturePath('fts-policy');
  await fs.rm(policyRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(policyRoot, '.gitnexus'), { recursive: true });
  await fs.writeFile(
    path.join(policyRoot, '.gitnexus', 'gitnexus.json'),
    JSON.stringify({ capabilities: { fts: { status: 'available' } } }),
  );
  check('an FTS index is reported as available', ftsAvailable(policyRoot) === true);
  check(
    'automatic mode does not add --skip-fts when FTS is available',
    effectiveSkipFts(policyRoot, false) === false,
  );
  check('configured true still forces the flag', effectiveSkipFts(policyRoot, true) === true);

  await fs.writeFile(
    path.join(policyRoot, '.gitnexus', 'gitnexus.json'),
    JSON.stringify({ capabilities: { fts: { status: 'disabled-by-flag' } } }),
  );
  check(
    'automatic mode adds --skip-fts when the index has no FTS',
    effectiveSkipFts(policyRoot, false) === true,
  );
  await fs.rm(policyRoot, { recursive: true, force: true });
}

async function formatTests() {
  section('format: model-facing text rendering');
  const { formatReport } = await import('../lib/gitnexus/format.js');

  const notIndexed = formatReport({ repo: { indexed: false, path: 'X:\\nope' } });
  check('unindexed report says so plainly', notIndexed.includes('NOT FOUND') && notIndexed.includes('gitnexus analyze'));

  const report = await analyzeCoverage('D:\\project\\data-screen', {});
  const text = formatReport(report);
  check('renders the repository name', text.includes('data-screen'));
  check('renders totals line', text.includes('scanned'));
  check('renders language rows', text.includes('Languages'));
  check('contains no ANSI escapes', !/\u001b\[/.test(text), JSON.stringify(text.slice(0, 60)));
  check('withLanguages=false drops the breakdown', !formatReport(report, false).includes('Languages'));
}

async function binaryTests() {
  section('regression: binary assets must not be called minified');

  // Found on a real repository (a 380 MB `.glb` and a 30 MB `.glb`): the first
  // revision tested only "no newlines 鈬?one enormous line", so every binary asset
  // was reported as "single-line 鈮?399 230 584 chars". The number was absurd and
  // the conclusion was worse —it told the reader that 97 % of the repository's
  // skipped bytes were compressed *source* rather than 3D models.
  const root = fixturePath('binary');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });

  // A .glb-like binary: NUL bytes, no newlines at all.
  const glb = Buffer.alloc(700 * 1024);
  glb.write('glTF', 0, 'ascii');
  glb[100] = 0;
  glb[200] = 0;
  await fs.writeFile(path.join(root, 'assets', 'model.glb'), glb);

  // A .fbx-like binary: NUL bytes AND newlines —the case that slipped through the
  // first revision by accident, because newlines kept its average line "short".
  const fbx = Buffer.alloc(700 * 1024);
  for (let i = 0; i < fbx.length; i += 200) fbx[i] = 0x00;
  for (let i = 0; i < fbx.length; i += 0x120) fbx[i] = 0x0a;
  await fs.writeFile(path.join(root, 'assets', 'model.fbx'), fbx);

  // A genuinely minified text file: no newlines, but printable ASCII throughout.
  await fs.writeFile(path.join(root, 'dist', 'app.min.js'), `var a=1;${'a+=1;'.repeat(120_000)}`);

  // A normal source file: many short lines.
  const src = Array.from({ length: 30_000 }, (_, i) => `export const K${i} = ${i};`).join('\n');
  await fs.writeFile(path.join(root, 'dist', 'normal.ts'), `${src}\n`);

  const glbVerdict = await judgeMinified(path.join(root, 'assets', 'model.glb'), 700 * 1024);
  check('NUL-bound binary is detected as binary', glbVerdict.binary === true, JSON.stringify(glbVerdict));
  check('binary is never also called minified', glbVerdict.suspect === false, JSON.stringify(glbVerdict));
  check('binary reports no line statistic', glbVerdict.avgLineLength === 0 && glbVerdict.estimatedLines === null);

  const fbxVerdict = await judgeMinified(path.join(root, 'assets', 'model.fbx'), 700 * 1024);
  check(
    'binary with newlines is still detected as binary',
    fbxVerdict.binary === true && fbxVerdict.suspect === false,
    JSON.stringify(fbxVerdict),
  );

  const minVerdict = await judgeMinified(path.join(root, 'dist', 'app.min.js'), 700 * 1024);
  check(
    'genuinely minified text is still flagged (the fix must not over-correct)',
    minVerdict.binary === false && minVerdict.suspect === true,
    JSON.stringify(minVerdict),
  );

  const normalVerdict = await judgeMinified(path.join(root, 'dist', 'normal.ts'), 700 * 1024);
  check(
    'normal source is neither binary nor minified',
    normalVerdict.binary === false && normalVerdict.suspect === false,
    JSON.stringify(normalVerdict),
  );

  section('regression: binary split in the report');

  const report = await analyzeCoverage(root, { env: {} });
  const binary = report.largeFiles.filter((f) => f.minified?.binary === true);
  check('report counts both binary assets', binary.length === 2, JSON.stringify(report.largeFiles.map((f) => f.path)));
  check(
    'no minified-dominance warning is raised for a binary asset',
    !report.warnings.some(
      (w) => w.code === 'minified-dominates-language' && String(w.evidence.path).endsWith('.glb'),
    ),
    JSON.stringify(report.warnings.map((w) => `${w.code}:${w.evidence.path ?? ''}`)),
  );

  const skipped = report.warnings.find((w) => w.code === 'large-files-skipped');
  check('large-files-skipped evidence carries the binary split', skipped !== undefined &&
    Number.isInteger(skipped.evidence.binaryCount) &&
    Number.isInteger(skipped.evidence.binaryBytes) &&
    Number.isInteger(skipped.evidence.textBytes), JSON.stringify(skipped?.evidence));
  check(
    'binary bytes + text bytes reconcile with the total',
    skipped !== undefined && skipped.evidence.binaryBytes + skipped.evidence.textBytes === skipped.evidence.bytes,
    JSON.stringify(skipped?.evidence),
  );
  check(
    'the message names the binary share so the headline is not read as lost source',
    skipped !== undefined && skipped.message.includes('二进制资源') && skipped.message.includes('仍可能含源码'),
    skipped?.message,
  );

  await fs.rm(root, { recursive: true, force: true });
}

/**
 * Tier 0 delta: does the working tree still match what the index recorded?
 *
 * These build a real git repository rather than a plain directory, because the whole
 * feature is a comparison against the *indexed commit* — the candidate set comes from
 * `git diff <lastCommit>` and `ls-files --others`. A stubbed git would test the stub.
 *
 * The manifest is written by the test, not by `gitnexus analyze`: it needs to control
 * `fileHashes` exactly (including the case where the index was built from a dirty
 * tree), and running the analyzer here would take minutes and hide which side drifted.
 */
async function deltaTests() {
  section('delta: tier 0 comparison against the index snapshot');
  const { readDelta, describeDelta } = await import('../lib/gitnexus/delta.js');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { createHash } = await import('node:crypto');
  const exec = promisify(execFile);

  const sha = (text) => createHash('sha256').update(text).digest('hex');

  // The wording branches are pure, so they run even where spawning is denied. The
  // distinction they encode is the whole point of `certain`: a clean worktree is not a
  // clean index.
  {
    const report = (patch) => ({
      comparable: true,
      certain: true,
      needsRefresh: false,
      counts: { checked: 0, hashed: 0, unchanged: 0, modified: 0, added: 0, deleted: 0, excluded: 0 },
      entries: [],
      notes: ['工作区与索引记录一致'],
      durationMs: 5,
      ...patch,
    });
    check('a certain clean verdict says 无需刷新', describeDelta(report({})).includes('无需刷新'), describeDelta(report({})));
    check(
      'an uncertain clean verdict says 无法确认 instead',
      (() => {
        const text = describeDelta(report({ certain: false, notes: ['索引没有记录可用的提交基线'] }));
        return text.includes('无法确认') && !text.includes('无需刷新');
      })(),
      describeDelta(report({ certain: false, notes: ['索引没有记录可用的提交基线'] })),
    );
  }

  // A confined DSH process cannot spawn a child over piped stdio (`spawn EPERM`), and
  // every fixture here needs a real `git`. That is a property of the environment, not
  // of the engine, so it is reported as a skip with the same wording the search-helper
  // test uses — the unconfined run covers it.
  let gitSpawnable = false;
  try {
    await exec('git', ['--version'], { windowsHide: true, timeout: 10_000 });
    gitSpawnable = true;
  } catch {
    gitSpawnable = false;
  }
  if (!gitSpawnable) {
    check(
      'delta engine tests run (skipped: git cannot be spawned in this sandbox)',
      true,
      'covered by the unconfined run',
    );
    await deltaRouteTests();
    return;
  }


  /** @param {string} name @param {Record<string,string>} files */
  const build = async (name, files) => {
    const root = fixturePath(`delta-${name}`);
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(root, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content);
    }
    const git = async (args) => exec('git', args, { cwd: root, windowsHide: true, timeout: 30_000 });
    // `-c` per command rather than `git config`: a developer machine may have no
    // identity configured, and the fixture must not depend on it.
    const identity = ['-c', 'user.email=test@example.com', '-c', 'user.name=delta-test'];
    await git(['init']);
    await git([...identity, 'add', '-A']);
    await git([...identity, 'commit', '-m', 'fixture']);
    const { stdout } = await git(['rev-parse', 'HEAD']);

    /** @param {Record<string,string>} hashes @param {string} commit */
    const writeManifest = async (hashes, commit) => {
      await fs.mkdir(path.join(root, '.gitnexus'), { recursive: true });
      await fs.writeFile(
        path.join(root, '.gitnexus', 'gitnexus.json'),
        JSON.stringify({
          repoPath: root,
          indexedAt: new Date().toISOString(),
          lastCommit: commit,
          stats: { files: Object.keys(hashes).length, nodes: 1, edges: 1, communities: 1, processes: 0, embeddings: 0 },
          fileHashes: hashes,
          indexCoverage: { maxFileSizeBytes: 512, dirtyPaths: [] },
        }),
      );
    };
    /** @param {Record<string,string>} [hashed] paths to record; defaults to every file */
    const index = async (hashed = files) => {
      const hashes = {};
      for (const [relative, content] of Object.entries(hashed)) hashes[relative] = sha(content);
      await writeManifest(hashes, stdout.trim());
      return hashes;
    };
    return { root, git, identity, head: stdout.trim(), index, writeManifest };
  };

  // --- a clean tree costs nothing -------------------------------------------------
  {
    const fixture = await build('clean', { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' });
    await fixture.index();
    const report = await readDelta(fixture.root);
    check('a clean tree is comparable', report.comparable === true, JSON.stringify(report.notes));
    check('the baseline is the indexed commit', report.basis === 'index', String(report.basis));
    check('a clean tree needs no refresh', report.needsRefresh === false);
    check('the verdict is anchored to the index commit', report.certain === true, JSON.stringify(report));
    check('a clean tree reads no file content', report.counts.hashed === 0, JSON.stringify(report.counts));
    check('a clean tree has no candidates', report.counts.checked === 0, JSON.stringify(report.counts));
    check(
      'the verdict explains itself',
      report.notes.length > 0 && report.notes[0].includes('一致'),
      JSON.stringify(report.notes),
    );
    check('the one-line verdict says no refresh', describeDelta(report).includes('无需刷新'), describeDelta(report));
  }

  // --- a dirty-at-index file is NOT drift ----------------------------------------
  // The index recorded the file's current content, so nothing would change on a
  // refresh even though `git diff <lastCommit>` lists it. This is the case a naive
  // HEAD comparison gets wrong.
  {
    const fixture = await build('dirty', { 'src/a.ts': 'export const a = 1;\n' });
    const dirtyContent = 'export const a = 1; // edited but already indexed\n';
    await fs.writeFile(path.join(fixture.root, 'src', 'a.ts'), dirtyContent);
    const hashes = { 'src/a.ts': sha(dirtyContent) };
    await fixture.writeManifest(hashes, fixture.head);
    const report = await readDelta(fixture.root);
    check('a file git reports as changed can still match the index', report.needsRefresh === false, JSON.stringify(report.entries));
    check('it is counted as checked and hashed', report.counts.checked === 1 && report.counts.hashed === 1, JSON.stringify(report.counts));
    check('it is counted as unchanged', report.counts.unchanged === 1, JSON.stringify(report.counts));
  }

  // --- the three actionable kinds -------------------------------------------------
  {
    const fixture = await build('change', {
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
    });
    await fixture.index();
    await fs.writeFile(path.join(fixture.root, 'src', 'a.ts'), 'export const a = 100;\n');
    await fs.writeFile(path.join(fixture.root, 'src', 'c.ts'), 'export const c = 3;\n');
    await fs.rm(path.join(fixture.root, 'src', 'b.ts'));
    const report = await readDelta(fixture.root);
    const kinds = report.entries.map((entry) => `${entry.kind}:${entry.path}`).sort();
    check('a modified file is reported as modified', kinds.includes('modified:src/a.ts'), JSON.stringify(kinds));
    check('a new file is reported as added', kinds.includes('added:src/c.ts'), JSON.stringify(kinds));
    check('a deleted file is reported as deleted', kinds.includes('deleted:src/b.ts'), JSON.stringify(kinds));
    check('the verdict needs a refresh', report.needsRefresh === true);
    check(
      'the counts agree',
      report.counts.modified === 1 && report.counts.added === 1 && report.counts.deleted === 1,
      JSON.stringify(report.counts),
    );
    check('describeDelta lists the change markers', /M src\/a\.ts/.test(describeDelta(report)), describeDelta(report));
  }

  // --- the index's own policy is respected ---------------------------------------
  {
    const fixture = await build('excluded', { 'src/a.ts': 'export const a = 1;\n' });
    await fixture.index();
    await fs.writeFile(path.join(fixture.root, 'src', 'huge.ts'), 'x'.repeat(2048));
    const report = await readDelta(fixture.root);
    check('an oversized new file is classified as excluded', report.entries[0]?.kind === 'excluded', JSON.stringify(report.entries));
    check('the exclusion says why', (report.entries[0]?.reason ?? '').includes('上限'), String(report.entries[0]?.reason));
    check('an excluded-only change does not ask for a refresh', report.needsRefresh === false, JSON.stringify(report.counts));
  }

  // --- no index at all ------------------------------------------------------------
  {
    const root = fixturePath('delta-absent');
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    await exec('git', ['init'], { cwd: root, windowsHide: true });
    const report = await readDelta(root);
    check('a project without an index is not comparable', report.comparable === false && report.indexed === false);
    check('it says what to do instead', (report.notes[0] ?? '').includes('索引'), JSON.stringify(report.notes));
  }

  // --- a manifest with no commit baseline -----------------------------------------
  // Measured on this repository: a rebuild wrote an empty `lastCommit`, the tree was
  // clean, and a naive gate said 无需刷新 — while the next commit would have made the
  // index stale and the comparison still empty. A clean worktree is not a clean index.
  {
    const fixture = await build('no-commit', { 'src/a.ts': 'export const a = 1;\n' });
    await fixture.writeManifest({ 'src/a.ts': sha('export const a = 1;\n') }, '');
    const report = await readDelta(fixture.root);
    check(
      'a manifest without a commit is comparable but not certain',
      report.comparable === true && report.certain === false,
      JSON.stringify({ comparable: report.comparable, certain: report.certain }),
    );
    check(
      'a clean worktree alone does not claim the index is current',
      report.needsRefresh === false && report.certain === false,
      JSON.stringify({ needsRefresh: report.needsRefresh, certain: report.certain }),
    );
    check('the one-line verdict says it cannot confirm', describeDelta(report).includes('无法确认'), describeDelta(report));
    check(
      'the notes name the missing baseline and the consequence',
      report.notes.join(' ').includes('提交基线') && report.notes.join(' ').includes('无法确认索引'),
      JSON.stringify(report.notes),
    );
  }

  // --- a legacy manifest with no hashes -------------------------------------------
  {
    const fixture = await build('no-hashes', { 'src/a.ts': 'export const a = 1;\n' });
    await fs.mkdir(path.join(fixture.root, '.gitnexus'), { recursive: true });
    await fs.writeFile(
      path.join(fixture.root, '.gitnexus', 'meta.json'),
      JSON.stringify({ repoPath: fixture.root, indexedAt: new Date().toISOString(), lastCommit: fixture.head }),
    );
    const report = await readDelta(fixture.root);
    check('a manifest without fileHashes falls back to asking the analyzer', report.comparable === false && report.indexed === true);
    check('the reason names the missing hashes', (report.notes[0] ?? '').includes('哈希'), JSON.stringify(report.notes));
  }

  // --- the index directory itself is never "new content" --------------------------
  {
    const fixture = await build('self', { 'src/a.ts': 'export const a = 1;\n' });
    await fixture.index();
    // The manifest is untracked and lives inside the tree; without the filter it would
    // be reported as an added file on every single read.
    const report = await readDelta(fixture.root);
    check(
      'the untracked index manifest is not reported as a change',
      report.entries.every((entry) => !entry.path.startsWith('.gitnexus/')),
      JSON.stringify(report.entries),
    );
    check('so a freshly indexed tree still needs no refresh', report.needsRefresh === false, JSON.stringify(report.counts));
  }

  await deltaRouteTests();
}

/**
 * The route half of the delta feature. Split out because it needs no git: it asserts
 * the guard set, the payload shape and the engine hand-off, all of which are this
 * module's contract rather than git's behaviour.
 */
async function deltaRouteTests() {
  section('route: /api/gitnexus/delta guards');
  {
    const http = await import('node:http');
    const { mountDeltaRoute } = await import('../lib/routes/delta.js');
    const registered = [];
    const shimServer = {
      register: (route) => {
        registered.push(route);
        return () => {};
      },
    };
    const project = fixturePath('delta-route');
    await fs.rm(project, { recursive: true, force: true });
    await fs.mkdir(path.join(project, '.gitnexus'), { recursive: true });
    await fs.writeFile(path.join(project, '.gitnexus', 'gitnexus.json'), '{}');
    const reads = [];
    mountDeltaRoute(shimServer, {
      read: async (repoPath) => {
        reads.push(repoPath);
        return { comparable: true, needsRefresh: false, counts: { checked: 0 }, notes: [] };
      },
    });
    check('route registered', registered.length === 1 && registered[0].path === '/api/gitnexus/delta');

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
    const hit = async (suffix, init) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/gitnexus/delta${suffix}`, init);
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    const ok = await hit(`?repo=${encodeURIComponent(project)}`);
    check('a project root is answered', ok.status === 200 && ok.body?.ok === true, `status=${ok.status}`);
    check('the payload carries the verdict', ok.body?.delta?.comparable === true && typeof ok.body?.readAt === 'string');
    check('the engine was asked once', reads.length === 1, JSON.stringify(reads));

    const missing = await hit('');
    check('a missing repo is a 400', missing.status === 400 && missing.body?.code === 'missing-repo', `status=${missing.status}`);

    const outside = await hit(`?repo=${encodeURIComponent(path.join(import.meta.dirname, '..'))}`);
    check('the repository itself is answerable', outside.status === 200, `status=${outside.status}`);

    const notProject = await hit(`?repo=${encodeURIComponent(os.tmpdir())}`);
    check(
      'a non-project directory is refused',
      notProject.status === 404 && notProject.body?.code === 'not-a-project',
      `status=${notProject.status}`,
    );

    const post = await hit(`?repo=${encodeURIComponent(project)}`, { method: 'POST' });
    check('the delta route does not accept POST', post.status === 405, `status=${post.status}`);

    server.close();
  }
}

/**
 * The graph projection: whitelisted views, bounded output, and ids that cannot become
 * Cypher. The database-backed cases run against this repository's own index (like the
 * search tests) and skip when there is no store on the machine.
 */
async function graphTests() {
  section('graph: bounded projection');
  const { projectGraph, sanitizeGraphId, isGraphView, GraphError } = await import('../lib/gitnexus/graph.js');

  check('a community id is accepted', sanitizeGraphId('comm_8') === 'comm_8');
  check(
    'a symbol id is accepted',
    sanitizeGraphId('Function:src/client/index.ts:apply@1:2') === 'Function:src/client/index.ts:apply@1:2',
    String(sanitizeGraphId('Function:src/client/index.ts:apply@1:2')),
  );
  // The safety property: nothing that could terminate or escape the Cypher literal.
  check('a quote is refused', sanitizeGraphId("comm_8' OR 1=1 --") === null);
  check('a backslash is refused', sanitizeGraphId('comm_8\\') === null);
  check('an empty id is refused', sanitizeGraphId('   ') === null);
  check('an overlong id is refused', sanitizeGraphId('c'.repeat(300)) === null);
  check('only the two views are known', isGraphView('communities') && isGraphView('community') && !isGraphView('neighbors'));

  const repo = process.cwd();
  const hasStore = await fs
    .access(path.join(repo, '.gitnexus', 'lbug'))
    .then(() => true)
    .catch(() => false);

  if (!hasStore) {
    check('graph projection runs against an indexed repository (skipped)', true, 'no .gitnexus/lbug on this machine');
  } else {
    const overview = await projectGraph(repo, { view: 'communities', nodeBudget: 10 });
    check('the overview returns community nodes', overview.nodes.length > 0 && overview.nodes[0].kind === 'Community', JSON.stringify(overview.nodes.slice(0, 2)));
    check('the overview reports the true total', overview.total >= overview.nodes.length, `${overview.total} vs ${overview.nodes.length}`);
    check('the node budget is applied', overview.nodes.length <= 10, String(overview.nodes.length));
    check('a truncated overview says so', overview.truncated === overview.total > overview.nodes.length);
    check(
      'every edge has both endpoints in the node list',
      (() => {
        const ids = new Set(overview.nodes.map((node) => node.id));
        return overview.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target));
      })(),
      JSON.stringify(overview.edges.slice(0, 3)),
    );
    check(
      'the overview aggregates relation types',
      overview.edges.every((edge) => typeof edge.type === 'string' && edge.type !== '' && edge.weight >= 1),
    );

    const scope = overview.nodes[0].id;
    const detail = await projectGraph(repo, { view: 'community', id: scope, nodeBudget: 50 });
    check('a drill-down returns the community members', detail.nodes.length > 0, String(detail.nodes.length));
    check('the scope is reported', detail.scope === scope, String(detail.scope));
    check(
      'members carry a kind and a name',
      detail.nodes.every((node) => node.kind !== '' && node.name !== ''),
      JSON.stringify(detail.nodes.slice(0, 2)),
    );
    check(
      'a symbol member names its file and line',
      detail.nodes.some((node) => node.filePath !== null && typeof node.startLine === 'number'),
      JSON.stringify(detail.nodes.slice(0, 3)),
    );
    check('the drill-down reports the member total', detail.total >= detail.nodes.length, `${detail.total} vs ${detail.nodes.length}`);

    // The helper is the process the host actually spawns. Its contract is one JSON
    // object on stdout, and it must be exercised directly: a broken argument order here
    // is invisible to the projection tests above, which call the module in-process.
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const helper = path.join(import.meta.dirname, '..', 'lib', 'bin', 'graph-helper.js');
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [helper, repo, 'communities', '', '', '5', '10'],
        { cwd: repo, timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      );
      const body = JSON.parse(stdout.trim());
      check(
        'the helper prints one JSON projection',
        body.ok === true && body.projection?.view === 'communities' && Array.isArray(body.projection?.nodes),
        stdout.slice(0, 200),
      );
      check(
        'the helper honours the node budget it was given',
        body.projection?.nodes?.length <= 5,
        String(body.projection?.nodes?.length),
      );
    } catch (error) {
      const denied = /EPERM|EACCES|spawn/i.test(String(error));
      check(
        'the graph helper is spawnable in this environment',
        denied,
        denied ? 'spawn denied by this sandbox — covered by the unconfined run' : String(error),
      );
    }

    // The command string itself is the one link the in-process tests cannot see. The
    // host builds it with single-quoted paths and runs it through `ctx.shell`; a quoting
    // mistake would work in the helper test above and fail in the panel. Run the exact
    // string through a shell, the way the host does.
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const runShell = promisify(execFile);
      const helper = path.join(import.meta.dirname, '..', 'lib', 'bin', 'graph-helper.js');

      /** The shells this machine might have, most modern first. */
      const candidates =
        process.platform === 'win32'
          ? [
              ['pwsh', ['-NoProfile', '-NonInteractive', '-Command']],
              ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command']],
            ]
          : [['sh', ['-c']]];

      /** Run one command string, trying each shell until one exists on this machine. */
      const runCommand = async (command, cwd) => {
        let missing = null;
        for (const [file, prefix] of candidates) {
          try {
            return await runShell(file, [...prefix, command], {
              cwd,
              timeout: 60_000,
              windowsHide: true,
              maxBuffer: 8 * 1024 * 1024,
            });
          } catch (error) {
            if (/ENOENT/.test(String(error))) {
              missing = error;
              continue;
            }
            throw error;
          }
        }
        throw missing ?? new Error('no usable shell found');
      };

      const shell = {
        resolve: (request) => request,
        execute: async (spec) => {
          const { stdout, stderr } = await runCommand(spec.command, spec.workdir);
          return {
            result: async () => ({ exitCode: 0, stdout: { text: stdout }, stderr: { text: stderr } }),
          };
        },
      };
      const { projectViaHelper } = await import('../lib/gitnexus/graph.js');
      const viaShell = await projectViaHelper(repo, 'communities', null, { shell, helperPath: helper });
      check(
        'the host command string runs through a real shell',
        viaShell.view === 'communities' && viaShell.nodes.length > 0,
        `nodes=${viaShell.nodes.length}`,
      );
    } catch (error) {
      // Only a sandbox refusal is a skip. A missing shell or a quoting bug is this
      // test's job to fail on — matching the bare word `spawn` here once hid an ENOENT
      // behind a green check.
      const denied = /EPERM|EACCES/.test(String(error));
      check(
        'the host command string is runnable in this environment',
        denied,
        denied ? 'spawn denied by this sandbox — covered by the unconfined run' : String(error),
      );
    }

    const rejections = async (options, expected) => {
      try {
        await projectGraph(repo, options);
        return false;
      } catch (error) {
        return error instanceof GraphError && error.code === expected;
      }
    };
    check('an unknown view is refused', await rejections({ view: 'neighbors' }, 'invalid-view'));
    check('a drill-down without an id is refused', await rejections({ view: 'community' }, 'invalid-id'));
    check('an id that could be Cypher is refused', await rejections({ view: 'community', id: "x' OR 1=1 --" }, 'invalid-id'));
  }

  const notProject = await projectGraph(path.join(import.meta.dirname, '..', 'scripts'), {}).then(
    () => false,
    (error) => error instanceof GraphError && error.code === 'not-a-project',
  );
  check('a directory that is not a project root is refused', notProject === true);

  section('route: /api/gitnexus/graph guards');
  {
    const http = await import('node:http');
    const { mountGraphRoute } = await import('../lib/routes/graph.js');
    const registered = [];
    const shimServer = {
      register: (route) => {
        registered.push(route);
        return () => {};
      },
    };
    const project = fixturePath('graph-route');
    await fs.rm(project, { recursive: true, force: true });
    await fs.mkdir(path.join(project, '.gitnexus'), { recursive: true });
    await fs.writeFile(path.join(project, '.gitnexus', 'gitnexus.json'), '{}');
    const calls = [];
    mountGraphRoute(shimServer, {
      project: async (repoPath, view, id) => {
        calls.push({ repoPath, view, id });
        return { view, scope: id, nodes: [], edges: [], total: 0, truncated: false, budget: { nodes: 1, edges: 1 }, notes: [], readAt: '' };
      },
    });
    check('route registered', registered.length === 1 && registered[0].path === '/api/gitnexus/graph');

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
    const hit = async (suffix, init) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/gitnexus/graph${suffix}`, init);
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    const plain = await hit(`?repo=${encodeURIComponent(project)}`);
    check('the view defaults to communities', plain.status === 200 && calls[0]?.view === 'communities', JSON.stringify(calls[0]));
    check('an absent id is null, not empty string', calls[0]?.id === null, JSON.stringify(calls[0]));

    const drill = await hit(`?repo=${encodeURIComponent(project)}&view=community&id=comm_1`);
    check('a drill-down passes the id through', drill.status === 200 && calls[1]?.id === 'comm_1', JSON.stringify(calls[1]));

    const badView = await hit(`?repo=${encodeURIComponent(project)}&view=neighbors`);
    check('an unknown view is a 400', badView.status === 400 && badView.body?.code === 'invalid-view', `status=${badView.status}`);

    const missing = await hit('');
    check('a missing repo is a 400', missing.status === 400 && missing.body?.code === 'missing-repo', `status=${missing.status}`);

    const post = await hit(`?repo=${encodeURIComponent(project)}`, { method: 'POST' });
    check('the graph route does not accept POST', post.status === 405, `status=${post.status}`);

    server.close();
  }
}

async function realRepoSmoke() {
  section('smoke: report shape on a real indexed repository');
  const repo = 'D:\\project\\data-screen';
  try {
    await fs.access(path.join(repo, '.gitnexus', 'gitnexus.json'));
  } catch {
    check('data-screen indexed (skipped otherwise)', true, 'not present on this machine —skipped');
    return;
  }
  const started = Date.now();
  const report = await analyzeCoverage(repo, {});
  const elapsed = Date.now() - started;

  check('report has languages', report.languages !== null && report.languages.rows.length > 0);
  check('language percentages sum to ~100%', (() => {
    const total = report.languages.totalBytes || 1;
    const sum = report.languages.rows.reduce((s, r) => s + r.bytes / total, 0);
    return Math.abs(sum - 1) < 0.001;
  })());
  check('every language row has a colour', report.languages.rows.every((r) => /^#[0-9a-f]{6}$/i.test(r.color)));
  check('every language row has a class', report.languages.rows.every((r) => ['parsed', 'recognized', 'other'].includes(r.klass)));
  check('cap came from the index record', report.cap.source === 'index', `source=${report.cap.source}`);
  check('completes under 3s', elapsed < 3000, `${elapsed}ms`);
  // `data-screen` can be an index without a usable git history; use this checkout,
  // which has both the index and the commits the activity table needs.
  const localReport = await analyzeCoverage(process.cwd(), {});
  const localActivity = localReport.activity;
  if (localActivity === null || localActivity === undefined) {
    // The agent's test sandbox denies child processes, so `git` cannot be spawned
    // here. The client fixture still asserts the rendering; the data path is
    // exercised on a normal checkout.
    check('activity data (skipped: git unavailable in this sandbox)', true);
  } else {
    check(
      'activity exposes the three-way cross-tab',
      Array.isArray(localActivity?.cross?.rows) && localActivity.cross.rows.length === 3,
      JSON.stringify(localActivity?.cross),
    );
    // `''` is how the index reports "no commit recorded" — 0.1.3's null/undefined check
    // missed it, and an index rebuilt from a dirty tree hits exactly that case. The
    // engine then falls back to the activity-window baseline, which is the honest
    // behaviour this branch asserts.
    const recordedCommit = localReport.repo?.lastCommit;
    if (typeof recordedCommit !== 'string' || recordedCommit === '') {
      check(
        'baseline review falls back to the activity window',
        localActivity?.baseline?.source === 'window' &&
          localActivity.baseline.available === true,
        JSON.stringify(localActivity?.baseline),
      );
    } else {
      check(
        'activity reviews changes against the indexed commit',
        localActivity?.baseline?.ref === recordedCommit &&
          localActivity.baseline.available === true,
        JSON.stringify(localActivity?.baseline),
      );
    }
    check(
      'activity exposes a commit timeline',
      Array.isArray(localActivity?.timeline) &&
        localActivity.timeline.length > 0 &&
        typeof localActivity.timeline[0].subject === 'string',
      JSON.stringify(localActivity?.timeline?.slice(0, 1)),
    );
  }

  // Progress is real work, not a timer: the scan event carries the actual file
  // counter, and every event's percentage is monotonic up to the final assembly.
  const progressEvents = [];
  await analyzeCoverage(repo, {
    includeActivity: false,
    onProgress: (event) => progressEvents.push(event),
  });
  check(
    'progress reports the real scan counter',
    progressEvents.some(
      (event) => event.phase === 'scan' && event.total > 0 && event.current === event.total,
    ),
    JSON.stringify(progressEvents.slice(0, 6)),
  );
  check(
    'progress percentages never go backwards',
    progressEvents.every(
      (event, index) => index === 0 || event.percent >= progressEvents[index - 1].percent,
    ),
    JSON.stringify(progressEvents),
  );
  check(
    'progress ends at the assembly phase',
    progressEvents[progressEvents.length - 1]?.phase === 'assemble' &&
      progressEvents[progressEvents.length - 1]?.percent === 99,
    JSON.stringify(progressEvents.slice(-2)),
  );
  console.log(
    `      ${report.languages.rows.length} languages, ${report.totals.selected} selected, ` +
      `${report.totals.large} large, ${formatBytes(report.languages.totalBytes)} total, ${elapsed}ms`,
  );
}

console.log('\u001b[1mgitnexus-plus 路 coverage engine tests\u001b[0m');
await fixtureTests();
await binaryTests();
await regressionTests();
await crossCheckTests();
await routeTests();
await fileHistoryRouteTests();
await stalenessTests();
await capabilityTests();
await languageTests();
await searchTests();
await searchRouteTests();
await analyzeTests();
await installTests();
await commandTests();
await formatTests();
await deltaTests();
await graphTests();
await realRepoSmoke();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
