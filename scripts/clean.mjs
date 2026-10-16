#!/usr/bin/env node
/**
 * Remove previous build output before a rebuild.
 *
 * `tsc` never deletes: it writes a file per source and leaves everything else alone.
 * So a source that is renamed or deleted keeps its stale compiled copy in `lib/`,
 * and that copy is indistinguishable from a live one — `lib/routes/__probe.js` was
 * still sitting in the output after the module it came from was gone, and `npm pack`
 * would have shipped it.
 *
 * Plain `.mjs` and dependency-free, for the same reason `link-runtime.mjs` is: this
 * runs before the build it enables, so it cannot depend on that build or on anything
 * the build produces.
 */

import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * `lib/` is fully generated, and `build/` is the client's intermediate output.
 * Both are safe to remove wholesale — nothing hand-written lives in either.
 */
for (const dir of ['lib', 'build']) {
  const target = join(root, dir);
  if (!existsSync(target)) continue;
  rmSync(target, { recursive: true, force: true });
}
