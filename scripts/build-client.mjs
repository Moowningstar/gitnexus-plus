/**
 * Build the browser half: compile it with `tsc`, then wrap it into the client
 * module loader's factory artifact.
 *
 * WHY AMD + `outFile` RATHER THAN A BUNDLER
 * -----------------------------------------
 * The client half is several source files but ships as **one** artifact: the loader
 * evaluates a single `__ModuleLoader__.load({id, factory})` call, and inside that
 * factory `require` resolves only platform baseline modules. So the client's own
 * modules have to be linked before the loader sees them.
 *
 * The obvious answer is a bundler, and it is the wrong answer here: esbuild starts a
 * native helper process over piped stdio, which the confined build environment
 * denies (`spawn EPERM`) — a build that cannot run where the project is built is not
 * a build. `tsc` with `module: "AMD"` and `outFile` does the same job in-process: it
 * emits one concatenated file where every source file is a `define(name, deps, …)`
 * block, relative imports are already resolved into the dependency arrays, and
 * baseline packages (`react`, the UI primitives) are named dependencies. All that is
 * left for this script is a ~25-line registry that satisfies those `define` calls
 * and hands back the entry module — no bundler, no `node_modules` in the loop, and
 * no resolution graph to get wrong.
 *
 * The output format of the outer wrapper is fixed by `packages/client/tsdown.client.ts`
 * and was read off a working installed plugin (`dsh-bash-terminal-ts/scripts/build-client.mjs`):
 * a `__ModuleLoader__.load` call whose factory builds a CommonJS module and returns
 * its exports.
 *
 * `lib/client.js` — not `dist/client.js` — is what the client module table serves,
 * so that is the only path written here. Emitting a second copy would create two
 * artifacts for one source with no way to tell which one a given host loaded.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const compiledPath = join(root, 'build', 'client', 'bundle.js');
const outDir = join(root, 'lib');
const outPath = join(outDir, 'client.js');

/** Must equal the `id` the wrapped module registers and the package name. */
const PLUGIN_ID = 'dsh-gitnexus-plus';

/** The module `apply()` lives in; the loader's contract is that this one is exported. */
const ENTRY_MODULE = 'index';

/** Compile, so `node scripts/build-client.mjs` is a complete instruction. */
function compile() {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    throw new Error('typescript is not installed; run `npm install` first');
  }
  try {
    execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.client.json')], {
      cwd: root,
      stdio: 'inherit',
    });
  } catch {
    // tsc has already printed the diagnostics; a stack trace on top of them buries
    // the actual error.
    process.exit(1);
  }
}

/**
 * The AMD registry, as it appears inside the loader factory.
 *
 * Written as a template literal rather than a separate file so the artifact stays
 * one self-contained text blob, and indented to sit inside the factory body.
 *
 * Three details are load-bearing:
 *
 * 1. `define` is a `var`, not a function declaration, and it is named literally
 *    `define` — the compiled AMD blocks call it bare.
 * 2. `__load` registers the instance **before** running the factory, so a cycle
 *    (module A imports B, B imports A) sees partial exports instead of recursing
 *    forever. Cycles are a bug in the source, but a build artifact should not hang
 *    the page when one slips in.
 * 3. An unknown dependency name is handed to the loader's own `require`. That is how
 *    `react` and `@deepseek-ai/dsh-client-ui-primitives` resolve; they are named in
 *    the dependency arrays and must not be treated as missing.
 */
function shim() {
  return `\t\tvar __registry = {};
\t\tvar __instances = {};
\t\tvar define = function (name, deps, factory) {
\t\t\t__registry[name] = { deps: deps, factory: factory };
\t\t};
\t\tvar __load = function (name) {
\t\t\tvar instance = __instances[name];
\t\t\tif (instance !== undefined) return instance.exports;
\t\t\tvar definition = __registry[name];
\t\t\tif (definition === undefined) return require(name);
\t\t\tinstance = __instances[name] = { exports: {} };
\t\t\tvar args = [__load, instance.exports];
\t\t\tfor (var i = 2; i < definition.deps.length; i += 1) args.push(__load(definition.deps[i]));
\t\t\tdefinition.factory.apply(instance.exports, args);
\t\t\treturn instance.exports;
\t\t};
`;
}

compile();

if (!existsSync(compiledPath)) {
  console.error(`build-client: ${compiledPath} was not produced by tsc`);
  process.exit(1);
}

const source = readFileSync(compiledPath, 'utf8');

// A missing entry means the module names changed (a rename, or `rootDir` moved) and
// the loader would hand back an empty module with no error anywhere — the panel
// would simply never appear. Fail the build instead.
if (!source.includes(`define("${ENTRY_MODULE}"`)) {
  console.error(
    `build-client: no define("${ENTRY_MODULE}") block in ${compiledPath}; ` +
      'the client entry module name or the client tsconfig rootDir changed',
  );
  process.exit(1);
}

// The module id in the factory must match what the loader's graph keyed on, which
// is derived from the package name. Written literally here and asserted in tests
// rather than derived, so a rename cannot silently produce a wrapper the table
// refuses to register.
const wrapper = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PLUGIN_ID)},
\tfactory: (require) => {
${shim()}${source}
\t\treturn __load(${JSON.stringify(ENTRY_MODULE)});
\t}
});
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, wrapper, 'utf8');

console.log(
  `built ${outPath} (${Buffer.byteLength(wrapper)} bytes from ${Buffer.byteLength(source)} bytes of compiled source)`,
);
