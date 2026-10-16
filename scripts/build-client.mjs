/**
 * Build the browser half: compile it with `tsc`, then wrap it into the client
 * module loader's factory artifact.
 *
 * WHY TWO STEPS RATHER THAN A BUNDLER
 * -----------------------------------
 * The client source is a single module whose only imports are platform baseline
 * modules (`react`, the UI primitives), which the loader's own `require` supplies
 * at runtime. Nothing is resolved at build time, so nothing needs bundling: `tsc`
 * emitting CommonJS produces exactly one self-contained file, and the wrap is a
 * text operation. A bundler would add a dependency and a resolution graph to solve
 * a problem this file does not have.
 *
 * The output format is fixed by `packages/client/tsdown.client.ts` (banner/intro/
 * footer) and was read off a working installed plugin
 * (`dsh-bash-terminal-ts/scripts/build-client.mjs`): a `__ModuleLoader__.load` call
 * whose factory builds a CommonJS module and returns its exports.
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
const compiledPath = join(root, 'build', 'client', 'index.js');
const outDir = join(root, 'lib');
const outPath = join(outDir, 'client.js');

/** Must equal the `id` the wrapped module registers and the package name. */
const PLUGIN_ID = 'dsh-gitnexus-plus';

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

compile();

if (!existsSync(compiledPath)) {
  console.error(`build-client: ${compiledPath} was not produced by tsc`);
  process.exit(1);
}

const source = readFileSync(compiledPath, 'utf8');

// The module id in the factory must match what the loader's graph keyed on, which
// is derived from the package name. Written literally here and asserted in tests
// rather than derived, so a rename cannot silently produce a wrapper the table
// refuses to register.
const wrapper = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PLUGIN_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${source}
\t\treturn module.exports;
\t}
});
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, wrapper, 'utf8');

console.log(
  `built ${outPath} (${Buffer.byteLength(wrapper)} bytes from ${Buffer.byteLength(source)} bytes of compiled source)`,
);
