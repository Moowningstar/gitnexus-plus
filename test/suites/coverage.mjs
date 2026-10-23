/**
 * Coverage engine: fixtures, discovery, scanning, capabilities, formatting.
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

export async function fixtureTests() {
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
  check('the fixture has no .git and the report says so', report.repo.hasGit === false);
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

  // A folder indexed with `--skip-git`: there is a manifest but no commit baseline.
  // The report has to say that instead of letting the panel promise Git activity or an
  // incremental refresh it cannot have.
  await fs.mkdir(path.join(fixture.root, '.gitnexus'), { recursive: true });
  await fs.writeFile(
    path.join(fixture.root, '.gitnexus', 'gitnexus.json'),
    JSON.stringify({
      storagePath: path.join(fixture.root, '.gitnexus'),
      stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0, embeddings: 0 },
      fileHashes: { 'src/mod0.ts': 'deadbeef' },
    }),
  );
  const noGitIndex = await analyzeCoverage(fixture.root, { env: {} });
  check(
    'an index in a non-git directory is reported as indexed without git',
    noGitIndex.repo.indexed === true && noGitIndex.repo.hasGit === false,
    JSON.stringify(noGitIndex.repo),
  );
  check(
    'the report warns that the index has no commit baseline',
    noGitIndex.warnings.some((w) => w.code === 'no-commit-baseline'),
    JSON.stringify(noGitIndex.warnings.map((w) => w.code)),
  );

  await fs.rm(fixture.root, { recursive: true, force: true });
}

export async function discoveryTests() {
  section('discovery: all GitNexus indexes under a workspace');
  const { findIndexProjects } = await import('../../lib/gitnexus/discover.js');

  const root = fixturePath('discover');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'apps', 'api', '.gitnexus'), { recursive: true });
  await fs.writeFile(path.join(root, 'apps', 'api', '.gitnexus', 'gitnexus.json'), '{}');
  await fs.mkdir(path.join(root, 'apps', 'web', '.gitnexus'), { recursive: true });
  await fs.writeFile(path.join(root, 'apps', 'web', '.gitnexus', 'gitnexus.json'), '{}');
  await fs.writeFile(path.join(root, 'apps', 'web', '.gitnexus', 'lbug'), '');
  await fs.mkdir(path.join(root, 'node_modules', 'pkg', '.gitnexus'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'pkg', '.gitnexus', 'gitnexus.json'), '{}');
  await fs.mkdir(path.join(root, '.hidden', '.gitnexus'), { recursive: true });
  await fs.writeFile(path.join(root, '.hidden', '.gitnexus', 'gitnexus.json'), '{}');
  // A git project without an index is a candidate too, not a reason to keep walking
  // into its source tree.
  await fs.mkdir(path.join(root, 'apps', 'legacy', '.git'), { recursive: true });

  const found = await findIndexProjects(root);
  const web = path.resolve(root, 'apps', 'web');
  const api = path.resolve(root, 'apps', 'api');
  const legacy = path.resolve(root, 'apps', 'legacy');
  check(
    'collects the workspace, indexes and unindexed git projects',
    found.projects.length === 4 &&
      found.projects.some((project) => project.path === web) &&
      found.projects.some((project) => project.path === api) &&
      found.projects.some((project) => project.path === legacy),
    JSON.stringify(found.projects.map((project) => [project.path, project.kind])),
  );
  check(
    'the workspace container is a candidate and comes first',
    found.projects[0]?.path === path.resolve(root) &&
      found.projects[0]?.kind === 'workspace' &&
      found.projects[0]?.direction === 'self',
    JSON.stringify(found.projects[0]),
  );
  check(
    'ranks the complete index above the incomplete one, indexes above git',
    found.projects[1]?.path === web &&
      found.projects[1]?.complete === true &&
      found.projects[2]?.path === api &&
      found.projects[3]?.path === legacy &&
      found.projects[3]?.kind === 'git' &&
      found.projects[3]?.complete === false,
    JSON.stringify(found.projects.map((project) => [project.path, project.kind, project.complete])),
  );
  check(
    'index candidates report distance, direction and metadata',
    found.projects
      .filter((project) => project.kind === 'index')
      .every((project) => project.depth === 2 && project.metaFile === 'gitnexus.json'),
    JSON.stringify(found.projects),
  );
  check(
    'git candidates carry no manifest metadata',
    found.projects.find((project) => project.path === legacy)?.indexedAt === null &&
      found.projects.find((project) => project.path === legacy)?.hasGit === true,
  );
  check('an ordinary tree is not reported as truncated', found.truncated === false);

  // Only dependency/hidden trees carry an index: the walk must not enter them.
  const skippedRoot = fixturePath('discover-skipped');
  await fs.rm(skippedRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(skippedRoot, 'node_modules', 'pkg', '.gitnexus'), { recursive: true });
  await fs.writeFile(path.join(skippedRoot, 'node_modules', 'pkg', '.gitnexus', 'gitnexus.json'), '{}');
  await fs.mkdir(path.join(skippedRoot, '.cache', 'pkg', '.gitnexus'), { recursive: true });
  await fs.writeFile(path.join(skippedRoot, '.cache', 'pkg', '.gitnexus', 'gitnexus.json'), '{}');
  const skipped = await findIndexProjects(skippedRoot);
  check(
    'does not descend into node_modules or hidden directories',
    skipped.projects.length === 1 &&
      skipped.projects[0].kind === 'workspace' &&
      skipped.visited === 1,
    JSON.stringify(skipped),
  );

  // A container of git repositories with no index: every git root is listed, and the
  // workspace itself remains the scan target.
  const gitRoot = fixturePath('discover-git');
  await fs.rm(gitRoot, { recursive: true, force: true });
  for (const name of ['admin', 'backend', 'frontend']) {
    await fs.mkdir(path.join(gitRoot, name, '.git'), { recursive: true });
  }
  // Nested inside an already-git project: it must not be visited or listed.
  await fs.mkdir(path.join(gitRoot, 'admin', 'src', '.git'), { recursive: true });
  const gitProjects = await findIndexProjects(gitRoot);
  check(
    'lists every git project under the workspace',
    gitProjects.projects.filter((project) => project.kind === 'git').length === 3 &&
      gitProjects.projects[0].kind === 'workspace',
    JSON.stringify(gitProjects.projects.map((project) => [project.path, project.kind])),
  );
  check(
    'a git project stops the walk at its source tree',
    gitProjects.visited === 4 &&
      !gitProjects.projects.some((project) => project.path.includes(`${path.sep}src`)),
    JSON.stringify({ visited: gitProjects.visited, projects: gitProjects.projects.map((project) => project.path) }),
  );
  await fs.rm(gitRoot, { recursive: true, force: true });

  // The workspace's own index wins over anything below it and stops the walk: a
  // project's source tree is not a set of sibling projects.
  await fs.mkdir(path.join(root, '.gitnexus'), { recursive: true });
  await fs.writeFile(path.join(root, '.gitnexus', 'gitnexus.json'), '{}');
  const atRoot = await findIndexProjects(root);
  check(
    'an index at the workspace root is the only candidate',
    atRoot.projects.length === 1 &&
      atRoot.projects[0].path === path.resolve(root) &&
      atRoot.projects[0].depth === 0 &&
      atRoot.projects[0].direction === 'self' &&
      atRoot.visited === 1,
    JSON.stringify(atRoot),
  );

  const noneRoot = fixturePath('discover-empty');
  await fs.rm(noneRoot, { recursive: true, force: true });
  await fs.mkdir(noneRoot, { recursive: true });
  const none = await findIndexProjects(noneRoot);
  check(
    'a tree with no index or git project still lists the workspace',
    none.projects.length === 1 &&
      none.projects[0].kind === 'workspace' &&
      none.visited === 1 &&
      none.truncated === false,
    JSON.stringify(none),
  );

  // Bounds: the directory cap and the wall clock both stop the walk and say so,
  // rather than turning a status read into an unbounded filesystem walk.
  const limitRoot = fixturePath('discover-limit');
  await fs.rm(limitRoot, { recursive: true, force: true });
  for (const name of ['a', 'b', 'c']) await fs.mkdir(path.join(limitRoot, name), { recursive: true });
  const limited = await findIndexProjects(limitRoot, { maxDirectories: 1 });
  check(
    'the directory cap stops the walk and marks it truncated',
    limited.projects.length === 1 && limited.projects[0].kind === 'workspace' && limited.truncated === true,
    JSON.stringify(limited),
  );
  let tick = 0;
  // Let the root be examined, then jump past the budget: the workspace candidate must
  // survive even when the walk is cut short.
  const timed = await findIndexProjects(limitRoot, {
    timeoutMs: 1,
    now: () => (tick++ < 2 ? 0 : 100),
  });
  check(
    'the time budget stops the walk and marks it truncated',
    timed.projects.length === 1 && timed.projects[0].kind === 'workspace' && timed.truncated === true,
    JSON.stringify(timed),
  );

  const deepRoot = fixturePath('discover-deep');
  await fs.rm(deepRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(deepRoot, 'x', 'y', '.gitnexus'), { recursive: true });
  await fs.writeFile(path.join(deepRoot, 'x', 'y', '.gitnexus', 'gitnexus.json'), '{}');
  const capped = await findIndexProjects(deepRoot, { maxDepth: 1 });
  check(
    'the depth cap stops before an index and marks the result truncated',
    capped.projects.length === 1 && capped.projects[0].kind === 'workspace' && capped.truncated === true,
    JSON.stringify(capped),
  );
  const uncapped = await findIndexProjects(deepRoot);
  check(
    'without the cap the same index is found',
    uncapped.projects[1]?.path === path.resolve(deepRoot, 'x', 'y') &&
      uncapped.projects[1]?.depth === 2,
    JSON.stringify(uncapped.projects),
  );

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(skippedRoot, { recursive: true, force: true });
  await fs.rm(noneRoot, { recursive: true, force: true });
  await fs.rm(limitRoot, { recursive: true, force: true });
  await fs.rm(deepRoot, { recursive: true, force: true });
}

export async function binaryTests() {
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

export async function regressionTests() {
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
/**
 * The workspace-to-index search. A workspace is often a container, so the coverage
 * route asks this module which project to describe; the ordering and the bounds are
 * therefore part of the route's contract, not an implementation detail.
 */

export async function crossCheckTests() {
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

export async function stalenessTests() {
  section('staleness classification (the condition that was once inverted)');
  const { classifyStaleness } = await import('../../lib/gitnexus/git.js');

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

export async function capabilityTests() {
  section('manifest narrowing (fields a checklist would drop)');
  const { readCapabilities, readGraphQuality } = await import('../../lib/gitnexus/coverage.js');

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

export async function languageTests() {
  section('language fallback when GitNexus is absent');
  const { classifyFile, aggregateLanguages } = await import('../../lib/gitnexus/languages.js');

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

export async function commandTests() {
  section('maintenance commands (handed over, not executed)');
  const {
    maintenanceCommands,
    commandRationale,
    defaultGitnexusHome,
    effectiveSkipFts,
    ftsAvailable,
  } = await import('../../lib/gitnexus/commands.js');

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

  // A plain folder: GitNexus refuses an explicit path without `.git` unless this flag
  // is present, so every command offered for that directory must carry it.
  const noGit = maintenanceCommands('/x', { platform: 'linux', skipGit: true });
  check(
    'a non-git directory gets --skip-git on both commands',
    noGit.every((c) => c.argv.includes('--skip-git')),
    noGit.map((c) => c.argv).join(' | '),
  );
  check(
    '--skip-git precedes the quoted path',
    noGit[0].argv.indexOf('--skip-git') < noGit[0].argv.indexOf("'/x'"),
    noGit[0].argv,
  );
  check(
    'the default commands omit --skip-git',
    win.every((c) => !c.argv.includes('--skip-git')),
    win.map((c) => c.argv).join(' | '),
  );
  check(
    'the non-git command explains what is lost',
    noGit[0].when.includes('没有提交基线') && noGit[0].when.includes('增量刷新'),
    noGit[0].when,
  );
  const repairNoGit = maintenanceCommands('/x', {
    platform: 'linux',
    skipGit: true,
    includeRepair: true,
  }).find((c) => c.mode === 'repair-fts');
  check(
    'the repair command also carries --skip-git',
    repairNoGit?.argv.includes('--skip-git') === true,
    String(repairNoGit?.argv),
  );
  const rationaleNoGit = commandRationale({
    skipFts: false,
    skipGit: true,
    memoryOff: true,
    gitnexusHome: null,
  });
  check(
    'the rationale explains --skip-git',
    rationaleNoGit.some((n) => n.includes('--skip-git')),
    JSON.stringify(rationaleNoGit),
  );

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
  // The two ways a repair fails are different problems with different fixes, and both
  // were measured on this machine: a confined shell refuses the extension's child
  // process, and an extension that exists but cannot load means a missing runtime.
  check(
    'the repair caveat separates the two failure modes',
    withRepair[2]?.caveat?.includes('子进程') === true &&
      withRepair[2]?.caveat?.includes('运行时') === true &&
      withRepair[2]?.caveat?.includes('普通终端') === true,
    String(withRepair[2]?.caveat),
  );
  check(
    'the repair precondition names the runtime',
    withRepair[2]?.when?.includes('运行时') === true,
    String(withRepair[2]?.when),
  );
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

export async function formatTests() {
  section('format: model-facing text rendering');
  const { formatReport } = await import('../../lib/gitnexus/format.js');

  const notIndexed = formatReport({ repo: { indexed: false, path: 'X:\\nope' } });
  check('unindexed report says so plainly', notIndexed.includes('NOT FOUND') && notIndexed.includes('gitnexus analyze'));

  // A disposable repository, so this test does not depend on a developer's D: drive.
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-format-'));
  const repo = path.join(fixtureRoot, 'data-screen');
  await fs.mkdir(path.join(repo, '.gitnexus'), { recursive: true });
  await fs.writeFile(path.join(repo, 'index.ts'), 'export const answer = 42;\n');
  await fs.writeFile(
    path.join(repo, '.gitnexus', 'gitnexus.json'),
    JSON.stringify({ stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0 }, branch: 'main' }),
  );
  try {
    const report = await analyzeCoverage(repo, {});
    const text = formatReport(report);
    check('renders the repository name', text.includes('data-screen'));
    check('renders totals line', text.includes('scanned'));
    check('renders language rows', text.includes('Languages'));
    check('contains no ANSI escapes', !/\u001b\[/.test(text), JSON.stringify(text.slice(0, 60)));
    check('withLanguages=false drops the breakdown', !formatReport(report, false).includes('Languages'));
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

export async function compatibilityTests() {
  section('compatibility: index build CLI vs installed CLI');
  check('matching versions are a match', readCompatibility('1.6.12', '1.6.12').status === 'match');
  const mismatch = readCompatibility('1.6.6', '1.6.12');
  check(
    'different versions are a mismatch with both sides named',
    mismatch.status === 'mismatch' && mismatch.message.includes('1.6.6') && mismatch.message.includes('1.6.12'),
    JSON.stringify(mismatch),
  );
  check(
    'a missing side is unknown, never a match',
    readCompatibility(null, '1.6.12').status === 'unknown' && readCompatibility('', '').status === 'unknown',
  );

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-compat-'));
  const repo = path.join(root, 'data-screen');
  await fs.mkdir(path.join(repo, '.gitnexus'), { recursive: true });
  await fs.writeFile(path.join(repo, 'index.ts'), 'export const answer = 42;\n');
  await fs.writeFile(
    path.join(repo, '.gitnexus', 'gitnexus.json'),
    JSON.stringify({
      stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0 },
      branch: 'main',
      runnerIdentity: { cliVersion: '1.6.6' },
    }),
  );
  try {
    const report = await analyzeCoverage(repo, { includeActivity: false });
    check(
      'a report carries the compatibility verdict and a warning',
      report.compatibility.status === 'mismatch' &&
        report.warnings.some((warning) => warning.code === 'version-mismatch'),
      JSON.stringify({ compatibility: report.compatibility, warnings: report.warnings }),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
