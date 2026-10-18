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

  const missing = await hit('/api/gitnexus/coverage');
  check('missing repo param rejected', missing.status === 400 && missing.body?.code === 'missing-repo', 'status=' + missing.status);

  // The bound that replaced registry membership: a directory with no index is not
  // described. This is what keeps the route from being a filesystem probe.
  const sysdir = await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent('C:\\Windows\\System32'));
  check('a directory with no index is refused', sysdir.status === 404 && sysdir.body?.code === 'not-indexed', 'status=' + sysdir.status + ' code=' + sysdir.body?.code);

  const tempDir = fixturePath('noindex');
  await fs.mkdir(tempDir, { recursive: true });
  const plainDir = await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent(tempDir));
  check('an existing but unindexed directory is refused too', plainDir.status === 404 && plainDir.body?.code === 'not-indexed', 'status=' + plainDir.status);
  await fs.rm(tempDir, { recursive: true, force: true });

  const post = await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent(known.path), { method: 'POST' });
  check('non-GET method rejected', post.status === 405, 'status=' + post.status);

  const head = await fetch('http://127.0.0.1:' + port + '/api/gitnexus/coverage?repo=' + encodeURIComponent(known.path), { method: 'HEAD' });
  check('HEAD allowed without a body', head.status === 200, 'status=' + head.status);

  await new Promise((resolve) => server.close(resolve));
  dispose();
  check('disposer clears the registration', registered.length === 0);
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
  const { maintenanceCommands, commandRationale } = await import('../lib/gitnexus/commands.js');

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

  const rationale = commandRationale({ skipFts: true, memoryOff: true, gitnexusHome: null });
  check('the rationale explains why the env prefix exists', rationale.length >= 3, JSON.stringify(rationale));
  check('the rationale mentions the AGENTS.md guarantee', rationale.some((n) => n.includes('AGENTS.md')), JSON.stringify(rationale));
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
await stalenessTests();
await capabilityTests();
await analyzeTests();
await installTests();
await commandTests();
await formatTests();
await realRepoSmoke();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
