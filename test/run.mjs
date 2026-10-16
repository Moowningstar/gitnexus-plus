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

/** Build a repository containing one of each case the engine must distinguish. */
async function buildFixture() {
  const root = path.join(os.tmpdir(), `gitnexus-coverage-fixture-${process.pid}`);
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
  const root = path.join(os.tmpdir(), `gitnexus-legacy-fixture-${process.pid}`);
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

  const dispose = mountCoverageRoute(shimServer, {
    get: async (repoPath) => ({ stub: true, repoPath, totals: { large: 0 } }),
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

  const missing = await hit('/api/gitnexus/coverage');
  check('missing repo param rejected', missing.status === 400 && missing.body?.code === 'missing-repo', 'status=' + missing.status);

  // The bound that replaced registry membership: a directory with no index is not
  // described. This is what keeps the route from being a filesystem probe.
  const sysdir = await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent('C:\\Windows\\System32'));
  check('a directory with no index is refused', sysdir.status === 404 && sysdir.body?.code === 'not-indexed', 'status=' + sysdir.status + ' code=' + sysdir.body?.code);

  const tempDir = path.join(os.tmpdir(), 'gitnexus-noindex-' + process.pid);
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

  const noFts = maintenanceCommands('/x', { platform: 'linux', skipFts: false });
  check('--skip-fts can be turned off', !noFts[0].argv.includes('--skip-fts'), noFts[0].argv);

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
  const root = path.join(os.tmpdir(), `gitnexus-binary-fixture-${process.pid}`);
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
await commandTests();
await formatTests();
await realRepoSmoke();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
