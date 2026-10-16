#!/usr/bin/env node
/**
 * Re-link the DSH runtime packages into `node_modules`.
 *
 * The host half imports `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-tools` and
 * `@deepseek-ai/cordis`; the client half is built against `react` and
 * `@deepseek-ai/dsh-client-ui-primitives`. In a real install these arrive as
 * ordinary dependencies, but during development they are taken from the DSH
 * installation that is already on this machine rather than fetched from a registry
 * — the primitives package in particular ships no `lib/` on npm; its JavaScript
 * lives inside the web app bundle, and the published README states that plugins
 * must share it rather than bundle their own copy.
 *
 * WHY THIS IS A SCRIPT AND NOT A ONE-OFF
 * --------------------------------------
 * `npm install` prunes anything in `node_modules` it does not recognise, so a
 * hand-made junction survives exactly until the next dependency change. Twice
 * during development that silently broke the test suite — the failure looked like
 * a missing module, not like a pruned link. Wiring this to `postinstall` makes the
 * links a property of the project instead of a property of the machine.
 *
 * It never fails the install: on a machine without DSH, or on a published package
 * where the real dependencies are present, there is nothing to do.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Packages the project needs, mapped to their location under a DSH install. */
const PACKAGES = [
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
  'react',
];

/** Where a DSH installation keeps its `node_modules`, most specific first. */
function candidateRoots() {
  const roots = [];
  const fromEnv = process.env.DSH_RUNTIME_ROOT;
  if (typeof fromEnv === 'string' && fromEnv !== '') roots.push(fromEnv);

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (typeof local === 'string' && local !== '') {
      roots.push(path.join(local, 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules'));
    }
  }
  // A source checkout, for developers running DSH from a repository.
  roots.push(path.resolve(import.meta.dirname, '..', '..', 'deepseek-harness', 'node_modules'));
  return roots;
}

function findRuntimeRoot() {
  for (const root of candidateRoots()) {
    if (existsSync(path.join(root, '@deepseek-ai', 'dsh-tools'))) return root;
  }
  return null;
}

/**
 * Whether this run is the project's own checkout rather than an installed copy.
 *
 * `postinstall` runs on **every** install, including when this package is a
 * dependency inside someone else's tree. Linking the host's runtime packages into
 * that tree is not ours to do, and a reviewer reading a plugin for "surprising
 * install-time behaviour" would be right to flag a postinstall that walks PATH,
 * probes for a DSH installation and rewrites `node_modules`. Installed copies live
 * under `node_modules/`, so that is the test.
 */
function isOwnCheckout() {
  return !/(^|[\\/])node_modules([\\/]|$)/.test(process.cwd());
}

function main() {
  if (!isOwnCheckout()) return;

  const runtime = findRuntimeRoot();
  if (runtime === null) {
    // Expected on a machine without DSH: nothing to link from.
    return;
  }

  const linked = [];
  const skipped = [];
  for (const name of PACKAGES) {
    const target = path.join(runtime, name);
    if (!existsSync(target)) {
      skipped.push(name);
      continue;
    }

    const link = path.join(process.cwd(), 'node_modules', name);
    // A real installation already satisfies this; leave it alone.
    if (existsSync(link)) {
      let isLink = false;
      try {
        isLink = statSync(link).isDirectory() && existsSync(path.join(link, 'package.json'));
      } catch {
        isLink = false;
      }
      const pointsHere = (() => {
        try {
          return path.resolve(link, '..', '..') === path.resolve(target, '..', '..');
        } catch {
          return false;
        }
      })();
      if (isLink && !pointsHere) {
        skipped.push(`${name} (already present)`);
        continue;
      }
    }

    mkdirSync(path.dirname(link), { recursive: true });
    if (existsSync(link)) rmSync(link, { recursive: true, force: true });
    try {
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      linked.push(name);
    } catch (cause) {
      // `cause` is `unknown` at this boundary. `ErrnoException` rather than `Error`
      // because `code` lives on the former — an fs failure is what is expected here,
      // and reading `.code` off a plain `Error` is not a thing that exists.
      /** @type {string} */
      let detail;
      if (cause instanceof Error) {
        const code = /** @type {NodeJS.ErrnoException} */ (cause).code;
        detail = typeof code === 'string' ? code : cause.message;
      } else {
        detail = String(cause);
      }
      skipped.push(`${name} (${detail})`);
    }
  }

  if (linked.length > 0) {
    console.log(`[link-runtime] linked ${linked.length} package(s) from ${runtime}`);
  }
  if (skipped.length > 0 && process.env.DSH_LINK_VERBOSE === '1') {
    console.log(`[link-runtime] skipped: ${skipped.join(', ')}`);
  }
}

main();
