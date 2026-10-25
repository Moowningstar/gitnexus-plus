/**
 * Delta detection: the verdict that gates the refresh button, and the route that
 * serves it.
 *
 * `deltaRouteTests` is invoked by `deltaTests` itself, on both the git-less skip path
 * and the normal path, so it is not listed in the runner a second time.
 */


import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { analyzeCoverage, judgeMinified, formatBytes, looksGenerated, readCompatibility } from '../../lib/gitnexus/coverage.js';
import { scanRepository } from '../../lib/gitnexus/scan.js';
import { loadScanPrimitives } from '../../lib/gitnexus/root.js';
import { readRegistry, normalizePathKey } from '../../lib/gitnexus/index-meta.js';
import { buildFixture, check, fixturePath, section } from '../harness.mjs';

export async function deltaTests() {
  section('delta: tier 0 comparison against the index snapshot');
  const { readDelta, describeDelta, refreshAdvice } = await import('../../lib/gitnexus/delta.js');
  const { captureGit } = await import('../../lib/gitnexus/git-capture.js');
  const { createHash } = await import('node:crypto');

  /**
   * Build fixtures through the same file-descriptor capture the engine uses. A plain
   * `execFile` fails with `spawn EPERM` in a confined host — the pipe, not git — so a
   * pipe-based guard would report "git is unavailable" on a machine where it works.
   */
  const gitIn = async (cwd, args) => {
    const result = await captureGit(cwd, args, { timeoutMs: 30_000 });
    if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.failure}`);
    return result.text;
  };
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

  // The tier rules are pure and independent of git; they encode the cases the old
  // yes/no gate could not express (worktree basis, delete-heavy diffs, truncation).
  {
    const counts = {
      checked: 0,
      hashed: 0,
      unchanged: 0,
      modified: 0,
      added: 0,
      deleted: 0,
      excluded: 0,
    };
    const advice = (patch = {}) =>
      refreshAdvice({
        indexed: true,
        comparable: true,
        needsRefresh: true,
        certain: true,
        basis: 'index',
        truncated: false,
        counts,
        notes: [],
        ...patch,
      });
    check('clean certain tree advises no refresh', advice({ needsRefresh: false }).tier === 'none');
    check(
      'clean worktree without a baseline is unknown, not none',
      advice({ needsRefresh: false, certain: false, notes: ['没有提交基线'] }).tier === 'unknown',
    );
    check('missing index advises init', advice({ indexed: false, comparable: false }).tier === 'init');
    check(
      'index-basis dirty tree advises incremental',
      advice({ counts: { ...counts, modified: 2, added: 1 } }).tier === 'incremental',
    );
    check(
      'worktree-basis dirty tree advises reanalyze',
      advice({ basis: 'worktree', counts: { ...counts, modified: 1 } }).tier === 'reanalyze',
    );
    check(
      'truncated candidates advise reanalyze',
      advice({ truncated: true, counts: { ...counts, modified: 1 } }).tier === 'reanalyze',
    );
    check(
      'delete-heavy diff advises rebuild',
      advice({ counts: { ...counts, modified: 20, deleted: 80 } }).tier === 'rebuild',
    );
    check(
      'a small delete does not force rebuild',
      advice({ counts: { ...counts, modified: 20, deleted: 49 } }).tier === 'incremental',
    );
  }

  // A confined DSH process cannot spawn a child over piped stdio (`spawn EPERM`), and
  // every fixture here needs a real `git`. That is a property of the environment, not
  // of the engine, so it is reported as a skip with the same wording the search-helper
  // test uses — the unconfined run covers it.
  let gitSpawnable = false;
  try {
    gitSpawnable = (await captureGit(process.cwd(), ['--version'], { timeoutMs: 10_000 })).ok;
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


  // A --skip-git index has no commit baseline and no git history to inspect. Delta must
  // say "re-analyze", not run git and report a confusing not-a-repository failure.
  {
    const root = fixturePath('delta-no-git');
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    await fs.mkdir(path.join(root, '.gitnexus'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.gitnexus', 'gitnexus.json'),
      JSON.stringify({
        repoPath: root,
        indexedAt: new Date().toISOString(),
        lastCommit: '',
        stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0, embeddings: 0 },
        fileHashes: { 'src/a.ts': sha('export const a = 1;\n') },
      }),
    );
    const report = await readDelta(root);
    check(
      'a --skip-git index is told to re-analyze, never incremental',
      report.comparable === false &&
        report.indexed === true &&
        report.advice.tier === 'reanalyze' &&
        report.notes.some((note) => note.includes('--skip-git')),
      JSON.stringify({ comparable: report.comparable, advice: report.advice, notes: report.notes }),
    );
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
    const git = async (args) => gitIn(root, args);
    // `-c` per command rather than `git config`: a developer machine may have no
    // identity configured, and the fixture must not depend on it.
    const identity = ['-c', 'user.email=test@example.com', '-c', 'user.name=delta-test'];
    await git(['init']);
    await git([...identity, 'add', '-A']);
    await git([...identity, 'commit', '-m', 'fixture']);
    const head = (await git(['rev-parse', 'HEAD'])).trim();

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
      await writeManifest(hashes, head);
      return hashes;
    };
    return { root, git, identity, head, index, writeManifest };
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

  // --- the analyzer's own output cannot ask for a refresh -------------------------
  // `analyze` rewrites AGENTS.md / CLAUDE.md / the `.claude` tree every run. Counting
  // those as pending changes is the loop that made the gate say "refresh me" right after
  // a refresh, so they are dropped from the candidate set and mentioned only as a note.
  {
    const fixture = await build('managed', { 'src/a.ts': 'export const a = 1;\n' });
    await fixture.index();
    await fs.writeFile(path.join(fixture.root, 'AGENTS.md'), '# regenerated by analyze\n');
    await fs.mkdir(path.join(fixture.root, '.claude', 'skills'), { recursive: true });
    await fs.writeFile(path.join(fixture.root, '.claude', 'skills', 'x.md'), 'skill\n');
    const report = await readDelta(fixture.root);
    check(
      'files the analyzer wrote do not ask for a refresh',
      report.needsRefresh === false && report.counts.modified === 0 && report.counts.added === 0,
      JSON.stringify(report.counts),
    );
    check(
      'they are reported as analyzer output instead',
      report.notes.some((note) => note.includes('GitNexus 自己生成的')),
      JSON.stringify(report.notes),
    );
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
    await gitIn(root, ['init']);
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

export async function deltaRouteTests() {
  section('route: /api/gitnexus/delta guards');
  {
    const http = await import('node:http');
    const { mountDeltaRoute } = await import('../../lib/routes/delta.js');
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

    const outside = await hit(`?repo=${encodeURIComponent(path.join(import.meta.dirname, '..', '..'))}`);
    check('the repository itself is answerable', outside.status === 200, `status=${outside.status}`);

    const notProject = await hit(
      `?repo=${encodeURIComponent(path.join(os.tmpdir(), `dsh-gitnexus-plus-missing-${process.pid}`))}`,
    );
    check(
      'a directory that does not exist is refused',
      notProject.status === 404 && notProject.body?.code === 'not-a-directory',
      `status=${notProject.status} code=${notProject.body?.code}`,
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
