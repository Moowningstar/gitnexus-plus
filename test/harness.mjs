/**
 * Shared harness for the engine suites: counters, section headers and fixture paths.
 *
 * Split out of `run.mjs` when that file passed 4 600 lines. Every suite module
 * imports from here, so the counters are the same two numbers no matter which
 * module called `check()`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

let passed = 0;
let failed = 0;

/** @returns {{passed: number, failed: number}} the totals the runner prints */
export function summary() {
  return { passed, failed };
}

export function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } else {
    failed += 1;
    console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** @param {string} title */

export function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

/**
 * Where fixtures are built.
 *
 * Inside the repository, not `os.tmpdir()`. A confined DSH process may write only
 * within its workspace, so a fixture under `%TEMP%` fails with `EPERM: mkdir` — which
 * is expected confinement rather than a broken ACL, and it made the whole suite
 * unrunnable in the environment the plugin is developed in.
 *
 * `test/run.mjs` is executed directly rather than imported, so `import.meta.dirname` is
 * this file's own directory and the fixture lands beside the tests.
 *
 * @param {string} name
 * @returns {string}
 */

export function fixturePath(name) {
  return path.join(import.meta.dirname, '.fixtures', `${name}-${process.pid}`);
}

/** Build a repository containing one of each case the engine must distinguish. */

export async function buildFixture() {
  const root = fixturePath('coverage');
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
