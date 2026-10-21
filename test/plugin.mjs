#!/usr/bin/env node
/**
 * Plugin-contract tests: loads the real host half and drives it through a stub
 * Cordis context.
 *
 * This is the check that catches what unit tests on the engine cannot — that
 * `defineTool` accepts the definition, that `Config` is a schema Cordis will
 * accept, that the tool actually registers under the expected name, and that the
 * route is mounted only through the optional-service injection path. All four are
 * silent-failure modes: get one wrong and the plugin either never loads or loads
 * with no tool, and nothing in the engine tests would notice.
 *
 * The stub is deliberately minimal rather than a Cordis reimplementation: it
 * records what `apply` does and nothing more.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

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
 * @param {{ services?: Record<string, unknown> }} [options] — optional services the
 *   context should resolve. Omitting `shell` models a deployment without one.
 * @returns {{ ctx: object, registered: object[], routes: object[], disposers: Array<() => void>, effects: string[], injected: string[] }}
 */
function makeStubContext(options = {}) {
  const services = options.services ?? {};
  const registered = [];
  const routes = [];
  const disposers = [];
  const effects = [];
  const injected = [];

  const webServer = {
    register(route) {
      routes.push(route);
      const dispose = () => {
        const i = routes.indexOf(route);
        if (i >= 0) routes.splice(i, 1);
      };
      disposers.push(dispose);
      return dispose;
    },
  };

  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition);
        const dispose = () => {
          const i = registered.indexOf(definition);
          if (i >= 0) registered.splice(i, 1);
        };
        disposers.push(dispose);
        return dispose;
      },
    },
    inject(names, callback) {
      injected.push(...names);
      const child = { ...ctx, webServer };
      callback(child);
    },
    /**
     * Stands in for cordis' `get(name, strict)`, which resolves an optional service
     * without waiting for it. Returns `undefined` for anything absent, matching the
     * real one — verified against `new Context().get('nope')`.
     *
     * `services` is how a test supplies a shell executor; leaving it out models a
     * headless deployment, which is the composition the nullable runner exists for.
     */
    get(name) {
      return services[name];
    },
    effect(fn, label) {
      effects.push(label);
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };

  return { ctx, registered, routes, disposers, effects, injected };
}

console.log('\u001b[1mgitnexus-plus · plugin contract tests\u001b[0m');

section('module shape');
let plugin;
try {
  plugin = await import('../lib/index.js');
  check('host half imports', true);
} catch (error) {
  check('host half imports', false, String(error));
  console.log(`\n${passed} passed, ${failed + 1} failed\n`);
  process.exit(1);
}

check('exports name', plugin.name === 'gitnexus-plus', String(plugin.name));
check('injects tools', Array.isArray(plugin.inject) && plugin.inject.includes('tools'), JSON.stringify(plugin.inject));
check(
  'does NOT hard-inject webServer (headless profiles must still load)',
  Array.isArray(plugin.inject) && !plugin.inject.includes('webServer'),
  JSON.stringify(plugin.inject),
);
check('exports a Config schema', typeof plugin.Config === 'function');

const defaults = plugin.Config({});
check(
  'Config supplies defaults',
  defaults.scanDefaultCapKb === 512 && defaults.minifiedSampleLimit === 40 && defaults.serveRoutes === true,
  JSON.stringify(defaults),
);
check(
  'the maintenance commands default to the measured environment',
  defaults.skipFts === false && defaults.memoryOff === true && defaults.analyzeHeapMb === 8192,
  JSON.stringify(defaults),
);
// The default is the measurement, not the older sandbox reasoning: disabling an FTS
// the store already has forces a 21x slower full rebuild. This assertion exists because
// the schema default once disagreed with `commands.ts` and with the README, and only the
// real panel showed the flag still being offered.
check('--skip-fts is not enabled by default', defaults.skipFts === false, JSON.stringify(defaults));
check('gitnexusHome defaults to empty (no redirect)', defaults.gitnexusHome === '', JSON.stringify(defaults));

section('apply() registers the tools');
const stub = makeStubContext();
plugin.apply(stub.ctx, defaults);

// Two tools now: the coverage scan (walks the working tree) and the delta check
// (hashes only what git says differs). They are separate because their costs differ
// by orders of magnitude, and the caller should be able to ask the cheap one first.
check('exactly two tools registered', stub.registered.length === 2, `got ${stub.registered.length}`);
const tool = stub.registered.find((entry) => entry.name === 'gitnexus_coverage');
const deltaTool = stub.registered.find((entry) => entry.name === 'gitnexus_delta');
check('tool name is gitnexus_coverage', tool !== undefined, JSON.stringify(stub.registered.map((t) => t.name)));
check(
  'delta tool is registered',
  deltaTool !== undefined,
  JSON.stringify(stub.registered.map((t) => t.name)),
);
check(
  'delta tool takes only repo',
  deltaTool?.parameters?.required?.includes('repo') === true &&
    Object.keys(deltaTool?.parameters?.properties ?? {}).join(',') === 'repo',
  JSON.stringify(deltaTool?.parameters),
);
check(
  'delta tool reports the verdict fields',
  deltaTool?.output?.schema?.properties?.needsRefresh !== undefined &&
    deltaTool?.output?.schema?.properties?.comparable !== undefined &&
    deltaTool?.output?.schema?.properties?.certain !== undefined,
  JSON.stringify(deltaTool?.output?.schema)?.slice(0, 200),
);
check('tool has a description', typeof tool?.description === 'string' && tool.description.length > 50);
check(
  'parameters compiled to a JSON schema',
  tool?.parameters?.type === 'object' && 'repo' in (tool.parameters.properties ?? {}),
  JSON.stringify(tool?.parameters)?.slice(0, 200),
);
check('repo is required', tool?.parameters?.required?.includes('repo') === true, JSON.stringify(tool?.parameters?.required));
check('output schema present', tool?.output?.schema !== undefined);
check('output.render returns content blocks', (() => {
  const blocks = tool.output.render({}, { text: 'hello' });
  return Array.isArray(blocks) && blocks[0]?.type === 'text' && blocks[0]?.text === 'hello';
})());

section('apply() mounts the routes through optional injection');
check('webServer was injected', stub.injected.includes('webServer'), JSON.stringify(stub.injected));
// Nine routes now: list the workspace's indexes, read the working tree, keyword-search
// the graph, read one file's commit history, read one commit's patch for a file, check
// whether a refresh would change anything, read a bounded graph projection, refresh an
// index, and install GitNexus when there is none. Separate modules because their
// privileges differ sharply — listing/reading/searching/history/patch/delta/graph are
// unprivileged, refreshing writes inside the workspace, and installing runs the
// dependency tree's build scripts.
check('exactly nine routes mounted', stub.routes.length === 9, `got ${stub.routes.length} (${stub.routes.map((r) => r.path).join(', ')})`);
check(
  'the projects route is mounted',
  stub.routes.some((r) => r.path === '/api/gitnexus/projects'),
  JSON.stringify(stub.routes.map((r) => r.path)),
);
check(
  'the coverage route is mounted',
  stub.routes.some((r) => r.path === '/api/gitnexus/coverage'),
  JSON.stringify(stub.routes.map((r) => r.path)),
);
check(
  'the search route is mounted',
  stub.routes.some((r) => r.path === '/api/gitnexus/search'),
  JSON.stringify(stub.routes.map((r) => r.path)),
);
check(
  'the file-history route is mounted',
  stub.routes.some((r) => r.path === '/api/gitnexus/file-history'),
  JSON.stringify(stub.routes.map((r) => r.path)),
);
check(
  'the file-diff route is mounted',
  stub.routes.some((r) => r.path === '/api/gitnexus/file-diff'),
  JSON.stringify(stub.routes.map((r) => r.path)),
);
check(
  'the delta route is mounted',
  stub.routes.some((r) => r.path === '/api/gitnexus/delta'),
  JSON.stringify(stub.routes.map((r) => r.path)),
);
check(
  'the graph route is mounted',
  stub.routes.some((r) => r.path === '/api/gitnexus/graph'),
  JSON.stringify(stub.routes.map((r) => r.path)),
);
check(
  'the analyze route is mounted',
  stub.routes.some((r) => r.path === '/api/gitnexus/analyze'),
  JSON.stringify(stub.routes.map((r) => r.path)),
);
check(
  'the install route is mounted',
  stub.routes.some((r) => r.path === '/api/gitnexus/install'),
  JSON.stringify(stub.routes.map((r) => r.path)),
);
check('every route is a prefix kind', stub.routes.every((r) => r.kind === 'prefix'));
// The assertion this replaced said "no route starts a re-index", which was the old
// contract and had to fail when it changed. What matters now is which routes can write.
check(
  'exactly two routes can mutate',
  stub.routes.filter((r) => r.path.includes('analyze') || r.path.includes('install')).length === 2,
  JSON.stringify(stub.routes.map((r) => r.path)),
);
check('effects registered for teardown', stub.effects.length > 0, JSON.stringify(stub.effects));

section('analyze route: force is explicit');
{
  const analyzeRoute = stub.routes.find((r) => r.path === '/api/gitnexus/analyze');
  const call = async (url) => {
    const req = { method: 'POST', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    let body = '';
    const res = {
      statusCode: 0,
      headersSent: false,
      setHeader() {},
      end(value) {
        body = String(value ?? '');
        this.headersSent = true;
      },
    };
    await analyzeRoute.handler(req, res);
    // The POST path validates the target with an async stat; wait for the response
    // rather than assuming it was synchronous.
    for (let attempt = 0; attempt < 20 && body === ''; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return JSON.parse(body);
  };

  const target = path.resolve('.');
  const plain = await call('/api/gitnexus/analyze?repo=' + encodeURIComponent(target));
  check('a POST without force asks for an incremental run', plain.run?.force === false, JSON.stringify(plain.run));
  const forced = await call(
    '/api/gitnexus/analyze?repo=' + encodeURIComponent(target) + '&force=1',
  );
  check('force=1 reaches the runner', forced.run?.force === true, JSON.stringify(forced.run));
  check('the forced run names --force in its command', String(forced.run?.command ?? '').includes('--force'), forced.run?.command);

  // The repair mode is a different write, and it must not be confused with either of
  // the other two: not forced, and never asking to skip the indexes it repairs.
  const repair = await call(
    '/api/gitnexus/analyze?repo=' + encodeURIComponent(target) + '&mode=repair-fts',
  );
  check('mode=repair-fts reaches the runner', repair.run?.repairFts === true, JSON.stringify(repair.run));
  check('a repair run is not a forced rebuild', repair.run?.force === false, JSON.stringify(repair.run));
  check(
    'the repair run names --repair-fts and not --skip-fts',
    String(repair.run?.command ?? '').includes('--repair-fts') &&
      !String(repair.run?.command ?? '').includes('--skip-fts'),
    repair.run?.command,
  );

  // The mutating route must not hand a missing path or a whole drive to analyze.
  const missing = await call(
    '/api/gitnexus/analyze?repo=' + encodeURIComponent(path.resolve('test/.fixtures/analyze-missing-target')),
  );
  check(
    'a missing analyze target is refused',
    missing.code === 'not-a-directory',
    JSON.stringify(missing),
  );
  const driveRoot = path.parse(target).root;
  const atRoot = await call('/api/gitnexus/analyze?repo=' + encodeURIComponent(driveRoot));
  check(
    'a filesystem root is refused',
    atRoot.code === 'not-a-directory',
    JSON.stringify(atRoot),
  );
}

section('coverage route: a plain folder is described');
{
  // The reported bug: a real working directory with no `.git` and no index used to
  // get a 404, so the panel showed a raw error and no numbers. This drives the real
  // route, engine and maintenance payload rather than a stub, which is where the
  // `--skip-git` wiring lives.
  const coverageRoute = stub.routes.find((r) => r.path === '/api/gitnexus/coverage');
  const projectsRoute = stub.routes.find((r) => r.path === '/api/gitnexus/projects');
  const fixture = path.join(import.meta.dirname, '.fixtures', `plugin-plain-${process.pid}`);
  await fs.rm(fixture, { recursive: true, force: true });
  await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, 'a.ts'), 'export const x = 1;\n');

  const callWith = async (route, url) => {
    const req = { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    let body = '';
    let finish;
    const settled = new Promise((resolve) => {
      finish = resolve;
    });
    const res = {
      statusCode: 0,
      headersSent: false,
      setHeader() {},
      end(value) {
        body = String(value ?? '');
        this.headersSent = true;
        finish();
      },
    };
    await route.handler(req, res);
    // The route is async: `handler` returns before the scan finishes. Wait for the
    // response to be ended rather than for a fixed number of turns.
    await settled;
    return JSON.parse(body);
  };
  const call = (url) => callWith(coverageRoute, url);

  const plain = await call(
    '/api/gitnexus/coverage?repo=' + encodeURIComponent(fixture),
  );
  check(
    'a plain folder is answered with a report instead of a 404',
    plain.ok === true && plain.report?.repo?.indexed === false,
    JSON.stringify(plain).slice(0, 300),
  );
  check(
    'the report records that the folder has no .git',
    plain.report?.repo?.hasGit === false,
    JSON.stringify(plain.report?.repo),
  );
  check(
    'the initialize command carries --skip-git',
    plain.maintenance?.commands?.[0]?.argv?.includes('--skip-git') === true,
    JSON.stringify(plain.maintenance?.commands?.[0]),
  );
  check(
    'the maintenance payload tells the client not to say 增量刷新',
    plain.maintenance?.skipGit === true,
    JSON.stringify(plain.maintenance),
  );

  const missing = await call(
    '/api/gitnexus/coverage?repo=' +
      encodeURIComponent(path.join(fixture, 'does-not-exist')),
  );
  check(
    'a missing directory is still refused',
    missing.ok === false && missing.code === 'not-a-directory',
    JSON.stringify(missing),
  );

  // The workspace is a container. The projects route lists the index below it; the
  // client selects that path and coverage/maintenance are requested for it exactly.
  const container = path.join(
    import.meta.dirname,
    '.fixtures',
    `plugin-nested-${process.pid}`,
  );
  await fs.rm(container, { recursive: true, force: true });
  await fs.mkdir(path.join(container, 'pkg', '.gitnexus'), { recursive: true });
  await fs.writeFile(
    path.join(container, 'pkg', '.gitnexus', 'gitnexus.json'),
    JSON.stringify({ fileHashes: {}, stats: { files: 1 } }),
  );
  await fs.writeFile(path.join(container, 'pkg', '.gitnexus', 'lbug'), '');
  await fs.writeFile(path.join(container, 'pkg', 'index.ts'), 'export const nested = 1;\n');
  await fs.mkdir(path.join(container, 'legacy', '.git'), { recursive: true });
  const nestedProject = path.resolve(container, 'pkg');
  const legacyProject = path.resolve(container, 'legacy');

  const resolved = await callWith(
    projectsRoute,
    '/api/gitnexus/projects?root=' + encodeURIComponent(container),
  );
  const nestedCandidate = resolved.projects?.find(
    (project) => path.resolve(project.path) === nestedProject,
  );
  const legacyCandidate = resolved.projects?.find(
    (project) => path.resolve(project.path) === legacyProject,
  );
  check(
    'the projects route lists the index and the unindexed git project',
    resolved.ok === true &&
      resolved.projects?.length === 3 &&
      nestedCandidate !== undefined &&
      legacyCandidate !== undefined,
    JSON.stringify(resolved),
  );
  check(
    'the candidates carry kind, distance and completeness',
    nestedCandidate?.depth === 1 &&
      nestedCandidate?.direction === 'descendant' &&
      nestedCandidate?.complete === true &&
      nestedCandidate?.kind === 'index' &&
      legacyCandidate?.kind === 'git' &&
      legacyCandidate?.complete === false,
    JSON.stringify({ nestedCandidate, legacyCandidate }),
  );

  const selected = await call(
    '/api/gitnexus/coverage?repo=' + encodeURIComponent(nestedProject),
  );
  check(
    'the selected project is described exactly',
    selected.ok === true &&
      selected.report?.repo?.indexed === true &&
      path.resolve(selected.report.repo.path) === nestedProject,
    JSON.stringify(selected.report?.repo),
  );
  check(
    'the maintenance commands target the selected project',
    String(selected.maintenance?.commands?.[0]?.argv ?? '').includes('pkg') &&
      String(selected.maintenance?.commands?.[0]?.argv ?? '').includes('--skip-git'),
    JSON.stringify(selected.maintenance?.commands?.[0]),
  );

  await fs.rm(container, { recursive: true, force: true });
  await fs.rm(fixture, { recursive: true, force: true });
}

section('serveRoutes=false suppresses the routes');
const off = makeStubContext();
plugin.apply(off.ctx, { ...defaults, serveRoutes: false });
check('no routes when disabled', off.routes.length === 0, `got ${off.routes.length}`);
check('tool still registered when disabled', off.registered.length === 2, `got ${off.registered.length}`);

section('tool execution against a real repository');
const repo = 'D:\\project\\data-screen';
const indexed = await fs
  .access(`${repo}\\.gitnexus\\gitnexus.json`)
  .then(() => true)
  .catch(() => false);

if (!indexed) {
  check('data-screen is indexed (skipped otherwise)', true, 'not present — skipped');
} else {
  const result = await tool.execute({ repo }, { signal: new AbortController().signal });
  check('execute returns the declared output shape', (
    typeof result.text === 'string' &&
    typeof result.indexed === 'boolean' &&
    Number.isInteger(result.largeFileCount) &&
    Number.isInteger(result.largeBytes) &&
    Array.isArray(result.warnings)
  ), JSON.stringify(result).slice(0, 200));
  check('execute reports the repo as indexed', result.indexed === true);
  check('rendered text names the repository', result.text.includes('data-screen'));
  check('rendered text is plain (no ANSI)', !/\u001b\[/.test(result.text));

  const noLanguages = await tool.execute({ repo, includeLanguages: false }, { signal: new AbortController().signal });
  check('includeLanguages=false drops the breakdown', !noLanguages.text.includes('Languages'));

  // A missing repository must be a reported state, not a thrown error: the model
  // asked a question, and "not indexed" is the answer.
  const absent = await tool.execute({ repo: 'D:\\definitely-not-a-repo' }, { signal: new AbortController().signal });
  check('missing repository does not throw', absent.indexed === false);
  check('missing repository explains the next step', absent.text.includes('gitnexus analyze'));
}

section('argument validation is delegated to defineTool');
let rejected = false;
try {
  await tool.execute({}, { signal: new AbortController().signal });
} catch {
  rejected = true;
}
check('missing required arg is rejected', rejected === true);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
