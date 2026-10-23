/**
 * HTTP routes and the analyze/install/delta/graph runners.
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

export async function routeTests() {
  section('route: /api/gitnexus/coverage guards');
  const http = await import('node:http');
  const { mountCoverageRoute } = await import('../../lib/routes/coverage.js');
  const { mountProjectsRoute } = await import('../../lib/routes/projects.js');

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
  /** The path the coverage route described, so exact-path semantics can be asserted. */
  const requestedRepos = [];
  const maintenanceRepos = [];
  const disposeProjects = mountProjectsRoute(shimServer);
  const dispose = mountCoverageRoute(shimServer, {
    get: async (repoPath, options) => {
      freshnessRequests.push(options?.fresh === true);
      requestedRepos.push(repoPath);
      options?.onProgress?.({
        phase: 'scan',
        percent: 42,
        label: '扫描文件 1/2',
        current: 1,
        total: 2,
      });
      return { stub: true, repoPath, totals: { large: 0 } };
    },
    maintenance: (repoPath) => {
      maintenanceRepos.push(repoPath);
      return {
        commands: [{ mode: 'init', shell: "gitnexus analyze '" + repoPath + "'" }],
        rationale: [],
      };
    },
  });
  check(
    'routes registered',
    registered.length === 2 &&
      registered.some((route) => route.path === '/api/gitnexus/coverage') &&
      registered.some((route) => route.path === '/api/gitnexus/projects'),
    JSON.stringify(registered.map((route) => route.path)),
  );

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

  // The bound that replaced project markers: the operator's working directory is
  // answerable even when it has neither an index nor a `.git` marker. GitNexus can
  // index a plain folder with `--skip-git`, and the scan-only report needs neither —
  // refusing this state is the dead end the panel used to show.
  const tempDir = fixturePath('noindex');
  await fs.mkdir(tempDir, { recursive: true });
  const plainDir = await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent(tempDir));
  check(
    'a plain directory is answered with a scan-only report',
    plainDir.status === 200 && plainDir.body?.ok === true,
    'status=' + plainDir.status + ' body=' + JSON.stringify(plainDir.body),
  );

  const missingDir = await hit(
    '/api/gitnexus/coverage?repo=' + encodeURIComponent(path.join(tempDir, 'missing')),
  );
  check(
    'a directory that does not exist is refused',
    missingDir.status === 404 && missingDir.body?.code === 'not-a-directory',
    'status=' + missingDir.status + ' code=' + missingDir.body?.code,
  );

  const rootDir = await hit(
    '/api/gitnexus/coverage?repo=' + encodeURIComponent(path.parse(tempDir).root),
  );
  check(
    'a filesystem root is refused',
    rootDir.status === 404 && rootDir.body?.code === 'not-a-directory',
    'status=' + rootDir.status + ' code=' + rootDir.body?.code,
  );

  // A `.git` marker still works the same way; the relaxed bound must not take the
  // scan-only report away from a git repository without an index.
  await fs.mkdir(path.join(tempDir, '.git'), { recursive: true });
  const noIndex = await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent(tempDir));
  check(
    'a git project without an index is answered with a scan-only report',
    noIndex.status === 200 && noIndex.body?.ok === true,
    'status=' + noIndex.status + ' body=' + JSON.stringify(noIndex.body),
  );

  // A container workspace: the projects route lists every index below it, and the
  // selected path is then described exactly by coverage — no implicit redirect.
  const container = fixturePath('nested-index');
  await fs.rm(container, { recursive: true, force: true });
  await fs.mkdir(path.join(container, 'apps', 'web', '.gitnexus'), { recursive: true });
  await fs.writeFile(path.join(container, 'apps', 'web', '.gitnexus', 'gitnexus.json'), '{}');
  await fs.writeFile(path.join(container, 'apps', 'web', '.gitnexus', 'lbug'), '');
  await fs.mkdir(path.join(container, 'apps', 'api', '.gitnexus'), { recursive: true });
  await fs.writeFile(path.join(container, 'apps', 'api', '.gitnexus', 'gitnexus.json'), '{}');
  await fs.mkdir(path.join(container, 'apps', 'legacy', '.git'), { recursive: true });

  const resolved = await hit(
    '/api/gitnexus/projects?root=' + encodeURIComponent(container),
  );
  const resolvedWeb = path.resolve(container, 'apps', 'web');
  const resolvedApi = path.resolve(container, 'apps', 'api');
  const resolvedLegacy = path.resolve(container, 'apps', 'legacy');
  check(
    'the projects route lists the workspace, indexes and unindexed git projects',
    resolved.status === 200 &&
      resolved.body?.ok === true &&
      resolved.body.projects?.length === 4 &&
      resolved.body.projects.some((project) => path.resolve(project.path) === resolvedWeb) &&
      resolved.body.projects.some((project) => path.resolve(project.path) === resolvedApi) &&
      resolved.body.projects.some((project) => path.resolve(project.path) === resolvedLegacy),
    JSON.stringify(resolved.body),
  );
  check(
    'candidates carry kind, distance and completeness',
    resolved.body.projects?.[0]?.kind === 'workspace' &&
      resolved.body.projects?.find((project) => path.resolve(project.path) === resolvedWeb)?.complete === true &&
      resolved.body.projects?.find((project) => path.resolve(project.path) === resolvedLegacy)?.kind === 'git',
    JSON.stringify(resolved.body.projects),
  );
  const projectsMissing = await hit('/api/gitnexus/projects');
  check(
    'the projects route requires a root',
    projectsMissing.status === 400 && projectsMissing.body?.code === 'missing-root',
    'status=' + projectsMissing.status,
  );
  const projectsPost = await hit('/api/gitnexus/projects?root=' + encodeURIComponent(container), {
    method: 'POST',
  });
  check('the projects route is read-only', projectsPost.status === 405, 'status=' + projectsPost.status);

  const selected = await hit(
    '/api/gitnexus/coverage?repo=' + encodeURIComponent(resolvedWeb),
  );
  check(
    'the selected project is described exactly',
    selected.status === 200 &&
      path.resolve(requestedRepos[requestedRepos.length - 1]) === resolvedWeb,
    String(requestedRepos[requestedRepos.length - 1]),
  );
  check(
    'maintenance targets the selected project',
    path.resolve(maintenanceRepos[maintenanceRepos.length - 1]) === resolvedWeb,
    String(maintenanceRepos[maintenanceRepos.length - 1]),
  );

  // Coverage itself no longer resolves: asking for the container describes the
  // container, so an older client cannot have its refresh redirected somewhere else.
  const containerReport = await hit(
    '/api/gitnexus/coverage?repo=' + encodeURIComponent(container),
  );
  check(
    'coverage describes the path it was given, not a discovered child',
    containerReport.status === 200 &&
      path.resolve(requestedRepos[requestedRepos.length - 1]) === path.resolve(container) &&
      containerReport.body?.discovery === undefined,
    JSON.stringify({ last: requestedRepos[requestedRepos.length - 1], discovery: containerReport.body?.discovery }),
  );
  await fs.rm(container, { recursive: true, force: true });
  await fs.rm(tempDir, { recursive: true, force: true });

  const post = await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent(known.path), { method: 'POST' });
  check('non-GET method rejected', post.status === 405, 'status=' + post.status);

  const head = await fetch('http://127.0.0.1:' + port + '/api/gitnexus/coverage?repo=' + encodeURIComponent(known.path), { method: 'HEAD' });
  check('HEAD allowed without a body', head.status === 200, 'status=' + head.status);

  await new Promise((resolve) => server.close(resolve));
  dispose();
  disposeProjects();
  check('disposer clears the registration', registered.length === 0);
}

export async function fileHistoryRouteTests() {
  section('route: /api/gitnexus/file-history');
  const http = await import('node:http');
  const { mountFileHistoryRoute } = await import('../../lib/routes/file-history.js');

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

  // Same shim, second route: one commit's patch for one file.
  const { mountFileDiffRoute } = await import('../../lib/routes/file-diff.js');
  const { readCommitDiff } = await import('../../lib/gitnexus/git-activity.js');
  const diffCalls = [];
  const disposeDiff = mountFileDiffRoute(shimServer, {
    read: async (repoPath, filePath, sha) => {
      diffCalls.push({ repoPath, filePath, sha });
      return {
        path: filePath,
        sha,
        available: true,
        patch: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b',
        truncated: false,
        reason: null,
      };
    },
  });
  const diffBase = 'http://127.0.0.1:' + port + '/api/gitnexus/file-diff';
  const diffHit = async (query) => {
    const res = await fetch(diffBase + query);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const fileEnc = encodeURIComponent('src/client/index.ts');
  const diffOk = await diffHit(`?repo=${encodeURIComponent(repo)}&path=${fileEnc}&sha=deadbeef`);
  check('file diff answers 200', diffOk.status === 200 && diffOk.body?.ok === true, 'status=' + diffOk.status);
  check('file diff forwards the sha', diffCalls.at(-1)?.sha === 'deadbeef', JSON.stringify(diffCalls.at(-1)));
  check('file diff carries the patch', String(diffOk.body?.patch ?? '').includes('@@ -1 +1 @@'), JSON.stringify(diffOk.body));
  const badSha = await diffHit(`?repo=${encodeURIComponent(repo)}&path=${fileEnc}&sha=not-a-hash`);
  check('a non-hash sha is rejected', badSha.status === 400, 'status=' + badSha.status);
  const noSha = await diffHit(`?repo=${encodeURIComponent(repo)}&path=${fileEnc}`);
  check('a missing sha is rejected', noSha.status === 400, 'status=' + noSha.status);
  disposeDiff();
  const refused = await readCommitDiff(process.cwd(), 'README.md', 'not-a-sha');
  check(
    'readCommitDiff refuses an invalid hash before calling git',
    refused.available === false && String(refused.reason).includes('不合法'),
    JSON.stringify(refused),
  );

  await new Promise((resolve) => server.close(resolve));
  dispose();
  check('file history disposer clears the registration', registered.length === 0);
}

export async function analyzeTests() {
  section('analyze runner (the one mutating capability)');
  const { createAnalyzeRunner, analyzeCommandLine } = await import('../../lib/gitnexus/analyze.js');

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

  // The directory half of the same policy: a folder without `.git` is refused by the
  // CLI even when its path is explicit, and `--skip-git` is its documented escape.
  const noGitLine = analyzeCommandLine('C:\\tools\\gitnexus.cmd', 'D:\\repo', {
    flavor: 'win32',
    skipGit: true,
  });
  check('--skip-git is emitted for a folder without .git', noGitLine.includes('--skip-git'), noGitLine);
  check('the path stays the last argument', noGitLine.trimEnd().endsWith("'D:\\repo'"), noGitLine);

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

  // The refined rule: this runner never constructs a policy — it may only forward one
  // the host resolved. Without a provider the request carries none, so the executor's
  // deployment default applies exactly as before.
  check(
    'the runner sets no sandboxPolicy when the host provides none',
    captured !== null && !Object.prototype.hasOwnProperty.call(captured, 'sandboxPolicy'),
    JSON.stringify(Object.keys(captured ?? {})),
  );

  // And when the host does resolve one, it must travel unchanged: the workspace root is
  // the input an agentless route cannot otherwise supply, and the sandbox derives its
  // write capability SID from it (measured: a plugin route without it is confined to the
  // DSH application directory and cannot write `.gitnexus` at all).
  {
    // `captured` is shared with the assertions below; restore it so this block cannot
    // make them report on the wrong run.
    const savedCaptured = captured;
    const cliRoot = path.join(import.meta.dirname, '..', '.fixtures', `policy-cli-${process.pid}`);
    const cliPkg = path.join(cliRoot, 'node_modules', 'gitnexus');
    await fs.mkdir(path.join(cliPkg, 'dist', 'cli'), { recursive: true });
    await fs.mkdir(path.join(cliPkg, 'dist', 'core', 'ingestion'), { recursive: true });
    await fs.writeFile(path.join(cliPkg, 'package.json'), JSON.stringify({ name: 'gitnexus', version: '1.6.12' }));
    await fs.writeFile(path.join(cliPkg, 'dist', 'cli', 'index.js'), '');
    await fs.writeFile(path.join(cliPkg, 'dist', 'core', 'ingestion', 'filesystem-walker.js'), '');
    const policy = { mode: 'workspace-write', workspaceRoot: 'D:\\Project\\policy' };
    const asked = [];
    const runner = createAnalyzeRunner({
      ...stubShell({ exitCode: 0 }),
      toolchain: { managedPrefix: cliRoot },
      sandboxPolicy: (repoPath) => {
        asked.push(repoPath);
        return policy;
      },
    });
    runner.start('D:/Project/policy');
    await settle();
    check(
      'a host-resolved sandbox policy is forwarded unchanged',
      captured?.sandboxPolicy === policy,
      JSON.stringify(captured?.sandboxPolicy),
    );
    check(
      'the policy is resolved for the run repository',
      asked.length === 1 && path.resolve(String(asked[0])).toLowerCase().endsWith('policy'),
      JSON.stringify(asked),
    );
    runner.dispose();
    await fs.rm(cliRoot, { recursive: true, force: true });
    captured = savedCaptured;
  }
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
  check(
    'a directory without .git gets --skip-git automatically',
    done.status('D:/Project/x')?.command.includes('--skip-git') === true,
    done.status('D:/Project/x')?.command,
  );

  // The other half of that decision: a real git repository must not get the flag, or
  // the index would silently lose its commit baseline.
  const gitFixture = fixturePath('runner-git');
  await fs.rm(gitFixture, { recursive: true, force: true });
  await fs.mkdir(path.join(gitFixture, '.git'), { recursive: true });
  const withGit = createAnalyzeRunner(stubShell({ exitCode: 0 }));
  withGit.start(gitFixture);
  await settle();
  check(
    'a git repository does not get --skip-git',
    withGit.status(gitFixture)?.command.includes('--skip-git') === false,
    withGit.status(gitFixture)?.command,
  );
  withGit.dispose();
  await fs.rm(gitFixture, { recursive: true, force: true });

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

    const lockRepo = path.join(import.meta.dirname, '..', '.fixtures', `retry-${process.pid}`);
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

    // The other EPERM measured in this deployment, and the opposite verdict: the
    // confined token can create files in `.gitnexus` but not directories, so the worker
    // cannot make its shard store. Retrying cannot grant that right.
    const storeMessage =
      "Error: EPERM: operation not permitted, mkdir 'D:\\Project\\r\\.gitnexus\\parsedfile-store'";
    const storeDenied = sequenceShell([
      { exitCode: 1, stderr: { text: storeMessage } },
      { exitCode: 0 },
    ]);
    const deniedStore = createAnalyzeRunner({ shell: storeDenied.shell, retryDelayMs: 5, toolchain });
    deniedStore.start(lockRepo);
    await new Promise((r) => setTimeout(r, 80));
    check('a denied cache-directory creation is not retried', storeDenied.calls() === 1, String(storeDenied.calls()));
    check(
      'it is reported as a sandbox refusal, not a transient lock',
      deniedStore.status(lockRepo)?.state === 'denied',
      JSON.stringify(deniedStore.status(lockRepo)),
    );
    check(
      'the message says the sandbox forbids the directory and points at the terminal',
      deniedStore.status(lockRepo)?.message?.includes('创建缓存目录') === true &&
        deniedStore.status(lockRepo)?.message?.includes('普通终端') === true,
      deniedStore.status(lockRepo)?.message,
    );
    deniedStore.dispose();

    // The FTS repair starts a child process; a confined shell refuses it, and no retry
    // grants a spawn right. Measured as `Analysis failed: spawn EPERM`.
    const spawnDenied = sequenceShell([
      { exitCode: 1, stderr: { text: '  Analysis failed: spawn EPERM' } },
      { exitCode: 0 },
    ]);
    const repairRun = createAnalyzeRunner({ shell: spawnDenied.shell, retryDelayMs: 5, toolchain });
    repairRun.start(lockRepo, { repairFts: true });
    await new Promise((r) => setTimeout(r, 80));
    check('a refused child process is not retried', spawnDenied.calls() === 1, String(spawnDenied.calls()));
    check('it is reported as a sandbox refusal', repairRun.status(lockRepo)?.state === 'denied', JSON.stringify(repairRun.status(lockRepo)));
    check(
      'the message names the child process and the terminal',
      repairRun.status(lockRepo)?.message?.includes('子进程') === true &&
        repairRun.status(lockRepo)?.message?.includes('终端') === true,
      repairRun.status(lockRepo)?.message,
    );
    repairRun.dispose();

    // An extension that is present but cannot load is an upstream runtime gap. Telling
    // the operator to retry would be wrong; naming the runtime is the useful answer.
    const unloadable = sequenceShell([
      {
        exitCode: 1,
        stderr: {
          text: 'Analysis failed: Cannot repair FTS indexes: The FTS extension file was found but could not be loaded',
        },
      },
      { exitCode: 0 },
    ]);
    const ftsRun = createAnalyzeRunner({ shell: unloadable.shell, retryDelayMs: 5, toolchain });
    ftsRun.start(lockRepo, { repairFts: true });
    await new Promise((r) => setTimeout(r, 80));
    check('an unloadable FTS extension is not retried', unloadable.calls() === 1, String(unloadable.calls()));
    check('it is a failure, not a sandbox refusal', ftsRun.status(lockRepo)?.state === 'failed', JSON.stringify(ftsRun.status(lockRepo)));
    check(
      'the message names the missing runtime',
      ftsRun.status(lockRepo)?.message?.includes('运行时') === true,
      ftsRun.status(lockRepo)?.message,
    );
    ftsRun.dispose();

    // A confined shell cannot start git, so a successful run writes an empty
    // `lastCommit`. The index is fine; the baseline is not, and the operator should know
    // why the gate says 无法确认 afterwards.
    await fs.writeFile(
      path.join(lockRepo, '.gitnexus', 'gitnexus.json'),
      JSON.stringify({ lastCommit: '', stats: { files: 1 } }),
    );
    const noBaseline = sequenceShell([{ exitCode: 0, stdout: { text: 'done' } }]);
    const baselineRun = createAnalyzeRunner({ shell: noBaseline.shell, retryDelayMs: 5, toolchain });
    baselineRun.start(lockRepo);
    await new Promise((r) => setTimeout(r, 80));
    check('a successful run without a baseline still completes', baselineRun.status(lockRepo)?.state === 'done');
    check(
      'it explains the missing commit baseline',
      baselineRun.status(lockRepo)?.message?.includes('提交基线') === true,
      baselineRun.status(lockRepo)?.message,
    );
    baselineRun.dispose();

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

  const { findGitnexusRoot } = await import('../../lib/gitnexus/root.js');
  const { findGitnexusCli } = await import('../../lib/gitnexus/toolchain.js');
  const foundRoot = findGitnexusRoot({ managedPrefix: path.join(managedRoot, 'managed') });
  check('a managed install is found as the package root', foundRoot === managedPackage, String(foundRoot));
  const foundCli = findGitnexusCli({ managedPrefix: path.join(managedRoot, 'managed') });
  check(
    'a managed install is selected as the CLI',
    foundCli.present === true && foundCli.source === 'managed' && foundCli.cliPath === path.join(managedPackage, 'dist', 'cli', 'index.js'),
    JSON.stringify(foundCli),
  );

  // The PATH probe used to read `env.PATH` from a spread copy of `process.env`, where
  // Windows spells the key `Path` — so the probe silently looked at nothing. This
  // fixture puts the package only behind a `Path` entry, which is the shape that failed.
  const pathRoot = fixturePath('path-probe');
  const pathPackage = path.join(pathRoot, 'node_modules', 'gitnexus');
  await fs.rm(pathRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(pathPackage, 'dist', 'core', 'ingestion'), { recursive: true });
  await fs.writeFile(path.join(pathPackage, 'package.json'), JSON.stringify({ name: 'gitnexus', version: '1.6.12' }));
  await fs.writeFile(path.join(pathPackage, 'dist', 'core', 'ingestion', 'filesystem-walker.js'), '');
  const viaWindowsSpelling = findGitnexusRoot({
    env: { Path: pathRoot, GITNEXUS_PACKAGE_ROOT: '' },
  });
  check(
    'a PATH entry spelled `Path` is probed',
    viaWindowsSpelling === pathPackage,
    String(viaWindowsSpelling),
  );
  const viaPosixSpelling = findGitnexusRoot({
    env: { PATH: pathRoot, GITNEXUS_PACKAGE_ROOT: '' },
  });
  check(
    'a PATH entry spelled `PATH` is probed',
    viaPosixSpelling === pathPackage,
    String(viaPosixSpelling),
  );

  // Two installs on PATH: an older copy first, the shim's own package second. The shim
  // is what the CLI runs, so its installation must win — otherwise the helper loads a
  // different native build than the one that wrote the index.
  const staleEntry = fixturePath('stale-entry');
  const shimEntry = fixturePath('shim-entry');
  const stalePackage = path.join(staleEntry, 'node_modules', 'gitnexus');
  const shimPackage = path.join(shimEntry, 'node_modules', 'gitnexus');
  for (const pkg of [stalePackage, shimPackage]) {
    await fs.rm(path.dirname(path.dirname(pkg)), { recursive: true, force: true });
    await fs.mkdir(path.join(pkg, 'dist', 'core', 'ingestion'), { recursive: true });
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'gitnexus', version: '1.6.12' }));
    await fs.writeFile(path.join(pkg, 'dist', 'core', 'ingestion', 'filesystem-walker.js'), '');
  }
  await fs.writeFile(path.join(shimEntry, 'gitnexus.cmd'), '@echo off\r\n');
  const withShim = findGitnexusRoot({
    env: {
      Path: `${staleEntry}${path.delimiter}${shimEntry}`,
      GITNEXUS_PACKAGE_ROOT: '',
    },
  });
  check(
    'the install that carries the shim wins over an earlier copy on PATH',
    withShim === shimPackage,
    String(withShim),
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

export async function installTests() {
  section('gitnexus installer (the prerequisite the plugin can satisfy)');
  const { createInstallRunner, installCommandLine, defaultInstallPrefix } = await import('../../lib/gitnexus/install.js');

  // The two properties that make this safe to offer at all.
  const win = installCommandLine('C:\\Users\\u\\.dsh\\gitnexus-plus\\gitnexus', 'gitnexus@^1.6.12', { platform: 'win32' });
  check('the install is an npm install', win.includes('npm install'), win);
  check('it installs under a prefix rather than changing directory', win.includes("--prefix '"), win);
  check(
    'npm writes its cache inside the granted install tree',
    win.includes('npm_config_cache') && win.includes('.npm-cache'),
    win,
  );
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

  const prefix = path.join(import.meta.dirname, '..', '.fixtures', 'install-prefix');
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

  // The install is a no-session spawn. Without a policy it inherits the DSH
  // application directory, whose Windows ACL grant fails under Program Files; the
  // install target is the only tree the command needs to write.
  const installPolicy = { mode: 'workspace-write', workspaceRoot: prefix };
  let policyPrefix = null;
  let policyRequest = null;
  const policyShell = {
    shell: {
      resolve: (req) => {
        policyRequest = req;
        return req;
      },
      execute: async () => ({
        result: async () => ({ exitCode: 0, stdout: { text: 'added 206 packages' } }),
      }),
    },
  };
  const withPolicy = createInstallRunner({
    ...policyShell,
    prefix,
    sandboxPolicy: (target) => {
      policyPrefix = target;
      return installPolicy;
    },
  });
  withPolicy.start();
  await new Promise((r) => setTimeout(r, 30));
  check(
    'the install policy is rooted at the install prefix',
    policyRequest?.sandboxPolicy === installPolicy &&
      path.resolve(policyPrefix) === path.resolve(prefix),
    JSON.stringify({ asked: policyPrefix, policy: policyRequest?.sandboxPolicy }),
  );

  // A policy failure happens inside `shell.resolve`, before any process exists. It
  // must become a failed install with the copyable command, not an exception that
  // escapes the route as an opaque 500.
  const brokenShell = createInstallRunner({
    shell: {
      resolve: () => {
        throw new Error(
          'sandbox mode "workspace-write" is requested but no sandbox backend is usable: ' +
            'windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\\Program Files\\DSH Desktop)',
        );
      },
      execute: async () => ({ result: async () => ({ exitCode: 0 }) }),
    },
    prefix,
  });
  check('a policy failure does not throw out of start()', (() => {
    try {
      brokenShell.start();
      return true;
    } catch {
      return false;
    }
  })());
  check(
    'a policy failure becomes a failed run with the command',
    brokenShell.status()?.state === 'failed' &&
      brokenShell.status()?.message?.includes('普通终端') === true &&
      brokenShell.status()?.message?.includes('windows-acl-run') === true,
    JSON.stringify(brokenShell.status()),
  );

  const noShell = createInstallRunner({ shell: null, prefix });
  noShell.start();
  check('a deployment with no shell reports unavailable', noShell.status()?.state === 'unavailable');
  check(
    'the unavailable message tells the operator to run it themselves',
    noShell.status()?.message?.includes('手动执行') === true,
  );
}

export async function deltaTests() {
  section('delta: tier 0 comparison against the index snapshot');
  const { readDelta, describeDelta, refreshAdvice } = await import('../../lib/gitnexus/delta.js');
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

export async function graphTests() {
  section('graph: bounded projection');
  const { projectGraph, sanitizeGraphId, isGraphView, GraphError } = await import('../../lib/gitnexus/graph.js');

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
  check(
    'the three views are known',
    isGraphView('communities') && isGraphView('community') && isGraphView('symbols') && !isGraphView('neighbors'),
  );

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
    check(
      'the overview names a representative member file',
      overview.nodes.some((node) => typeof node.representativeFile === 'string' && node.representativeFile !== ''),
      JSON.stringify(overview.nodes.slice(0, 2)),
    );
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

    const symbols = await projectGraph(repo, { view: 'symbols', nodeBudget: 20 });
    check(
      'the symbol view returns symbol nodes outside communities',
      symbols.nodes.length > 0 && symbols.nodes[0].kind !== 'Community',
      JSON.stringify(symbols.nodes.slice(0, 2)),
    );
    check(
      'the symbol view reports the true symbol total and truncation',
      symbols.total >= symbols.nodes.length && symbols.truncated === symbols.total > symbols.nodes.length,
      `${symbols.total} total / ${symbols.nodes.length} shown`,
    );
    check(
      'the symbol view explains the truncation',
      symbols.notes.some((note) => note.includes('符号')) || !symbols.truncated,
      JSON.stringify(symbols.notes),
    );
    check(
      'every symbol edge has both endpoints in the node list',
      (() => {
        const ids = new Set(symbols.nodes.map((node) => node.id));
        return symbols.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target));
      })(),
      JSON.stringify(symbols.edges.slice(0, 3)),
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
      const helper = path.join(import.meta.dirname, '..', '..', 'lib', 'bin', 'graph-helper.js');
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
      const helper = path.join(import.meta.dirname, '..', '..', 'lib', 'bin', 'graph-helper.js');

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
      const { projectViaHelper } = await import('../../lib/gitnexus/graph.js');
      const viaShell = await projectViaHelper(repo, 'communities', null, { shell, helperPath: helper });
      check(
        'the host command string runs through a real shell',
        viaShell.view === 'communities' && viaShell.nodes.length > 0,
        `nodes=${viaShell.nodes.length}`,
      );

      // Same request twice must spawn once: the projection is a pure function of the
      // index, the view/id and the budgets, and the index mtime is part of the key.
      let executed = 0;
      let graphPolicy = null;
      const counting = {
        resolve: (request) => {
          graphPolicy = request.sandboxPolicy;
          return request;
        },
        execute: async (spec) => {
          executed += 1;
          const { stdout, stderr } = await runCommand(spec.command, spec.workdir);
          return {
            result: async () => ({ exitCode: 0, stdout: { text: stdout }, stderr: { text: stderr } }),
          };
        },
      };
      const repoPolicy = { mode: 'workspace-write', workspaceRoot: repo };
      let graphPolicyRoot = null;
      const options = {
        shell: counting,
        helperPath: helper,
        nodeBudget: 100,
        sandboxPolicy: (root) => {
          graphPolicyRoot = root;
          return repoPolicy;
        },
      };
      const first = await projectViaHelper(repo, 'communities', null, options);
      const second = await projectViaHelper(repo, 'communities', null, options);
      check(
        'a repeated projection is served from cache',
        executed === 1 && second.nodes.length === first.nodes.length,
        `executed=${executed} nodes=${second.nodes.length}`,
      );
      check(
        'the graph helper receives the index-rooted sandbox policy',
        graphPolicy === repoPolicy &&
          path.resolve(graphPolicyRoot) === path.resolve(repo, '.gitnexus'),
        JSON.stringify({ policy: graphPolicy, asked: graphPolicyRoot }),
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

  const notProject = await projectGraph(path.join(import.meta.dirname, '..', '..', 'scripts'), {}).then(
    () => false,
    (error) => error instanceof GraphError && error.code === 'not-a-project',
  );
  check('a directory that is not a project root is refused', notProject === true);

  section('route: /api/gitnexus/graph guards');
  {
    const http = await import('node:http');
    const { mountGraphRoute } = await import('../../lib/routes/graph.js');
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
