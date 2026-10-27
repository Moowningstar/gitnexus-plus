/**
 * HTTP route tests: the plugin's own endpoints, driven over a real socket.
 *
 * The command-running suites (analyze, install, delta, graph) live in `runners.mjs`;
 * they are the ones that need a shell stub, while these only need a request and a
 * response.
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
  /** The activity window each read asked for; `undefined` means the engine default. */
  const windowRequests = [];
  /** The path the coverage route described, so exact-path semantics can be asserted. */
  const requestedRepos = [];
  const maintenanceRepos = [];
  const disposeProjects = mountProjectsRoute(shimServer);
  const dispose = mountCoverageRoute(shimServer, {
    get: async (repoPath, options) => {
      freshnessRequests.push(options?.fresh === true);
      windowRequests.push(options?.activitySinceDays);
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

  // The card's own window selector: without this the label said "近 7 天" above a
  // ninety-day report, and the file timeline (read with the label's 7 days) disagreed
  // with the list it was opened from.
  await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent(known.path) + '&days=7');
  check('days is forwarded as the activity window', windowRequests.at(-1) === 7, String(windowRequests.at(-1)));
  await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent(known.path) + '&days=999');
  check('the activity window is capped at 90 days', windowRequests.at(-1) === 90, String(windowRequests.at(-1)));
  await hit('/api/gitnexus/coverage?repo=' + encodeURIComponent(known.path));
  check('omitting days leaves the engine default', windowRequests.at(-1) === undefined, String(windowRequests.at(-1)));

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
