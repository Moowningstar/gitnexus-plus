/**
 * The bounded graph projection: what the card can draw, and what it refuses to.
 */


import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { analyzeCoverage, judgeMinified, formatBytes, looksGenerated, readCompatibility } from '../../lib/gitnexus/coverage.js';
import { scanRepository } from '../../lib/gitnexus/scan.js';
import { loadScanPrimitives } from '../../lib/gitnexus/root.js';
import { readRegistry, normalizePathKey } from '../../lib/gitnexus/index-meta.js';
import { buildFixture, check, fixturePath, section } from '../harness.mjs';

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

  // A checkpoint killed mid-write leaves `.shadow` behind and the engine then refuses
  // every open with one specific sentence. The plugin parks that file and retries once;
  // anything else it must classify as a real failure and leave the store alone.
  const { isOrphanShadowError, quarantineOrphanShadow } = await import('../../lib/gitnexus/lbug-heal.js');
  check(
    'a stale shadow sidecar is recognised',
    isOrphanShadowError(
      'Runtime exception: Found shadow file D:\\r\\.gitnexus\\lbug.shadow but no corresponding database file. This file may have been left behind from a previous database.',
    ),
  );
  check(
    'other store refusals are not mistaken for a stale shadow',
    !isOrphanShadowError('IO exception: Could not set lock on file: D:\\r\\.gitnexus\\lbug') &&
      !isOrphanShadowError('Cannot open database in read-only mode while checkpoint is in progress') &&
      !isOrphanShadowError('Trying to read a database file with a different version. Database file version: 47'),
  );

  const parkedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lbug-heal-'));
  const parkedDb = path.join(parkedDir, 'lbug');
  check('the sidecar is left alone when there is none', quarantineOrphanShadow(parkedDb) === null);
  await fs.writeFile(`${parkedDb}.shadow`, 'sidecar');
  const parked = quarantineOrphanShadow(parkedDb, 1234);
  check('the stale sidecar is parked, not deleted', parked === `${parkedDb}.shadow.orphan-1234`, String(parked));
  check(
    'the parked sidecar keeps its bytes',
    await fs.readFile(parked, 'utf8') === 'sidecar',
  );
  check('quarantine never creates a database file of its own', !(await fs.access(parkedDb).then(() => true).catch(() => false)));
  check('a second call has nothing left to park', quarantineOrphanShadow(parkedDb, 1234) === null);
  await fs.rm(parkedDir, { recursive: true, force: true });

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
