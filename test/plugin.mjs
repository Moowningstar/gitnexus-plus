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
  'the maintenance commands default to the sandbox-safe environment',
  defaults.skipFts === true && defaults.memoryOff === true && defaults.analyzeHeapMb === 8192,
  JSON.stringify(defaults),
);
check('gitnexusHome defaults to empty (no redirect)', defaults.gitnexusHome === '', JSON.stringify(defaults));

section('apply() registers the tool');
const stub = makeStubContext();
plugin.apply(stub.ctx, defaults);

check('exactly one tool registered', stub.registered.length === 1, `got ${stub.registered.length}`);
const tool = stub.registered[0];
check('tool name is gitnexus_coverage', tool?.name === 'gitnexus_coverage', String(tool?.name));
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
// Three routes now: read the working tree, refresh an index, and install GitNexus when
// there is none. Separate modules because their privileges differ sharply — reading is
// unprivileged, refreshing writes inside the workspace, and installing runs the
// dependency tree's build scripts.
check('exactly three routes mounted', stub.routes.length === 3, `got ${stub.routes.length} (${stub.routes.map((r) => r.path).join(', ')})`);
check(
  'the coverage route is mounted',
  stub.routes.some((r) => r.path === '/api/gitnexus/coverage'),
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

section('serveRoutes=false suppresses the routes');
const off = makeStubContext();
plugin.apply(off.ctx, { ...defaults, serveRoutes: false });
check('no routes when disabled', off.routes.length === 0, `got ${off.routes.length}`);
check('tool still registered when disabled', off.registered.length === 1);

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
