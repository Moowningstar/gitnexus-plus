/**
 * `GET /api/gitnexus/coverage?repo=<project>` — the panel's data source.
 *
 * Route shape follows the community convention (`/api/<plugin-slug>/…`) and the
 * carrier contract in `@deepseek-ai/dsh-host-webserver`: bare `node:http`, no
 * Express, exact-then-longest-prefix matching, and a disposer for teardown.
 *
 * THE BOUND IS "IS A GITNEXUS INDEX", NOT "IS IN THE REGISTRY"
 * -----------------------------------------------------------
 * An earlier revision accepted only paths present in `~/.gitnexus/registry.json`.
 * That was wrong for the panel's actual job: it shows the project the user is
 * *in*, and a working directory the global registry has never heard of — a fresh
 * clone, an index built with `GITNEXUS_HOME` redirected — is exactly the case the
 * panel exists to report on. Refusing it would have been a correctness bug wearing
 * a security costume.
 *
 * The route still refuses to describe arbitrary directories: the path must already
 * contain `.gitnexus/gitnexus.json` or `.gitnexus/meta.json`, so a caller cannot
 * use it to enumerate a filesystem. Loopback and method guards live in `./guard.js`.
 */

import path from 'node:path';
import { hasIndex } from '../gitnexus/index-meta.js';
import { guardHandler, passGuard, answerHead, sendJson } from './guard.js';
import type { WebServerService } from '@deepseek-ai/cordis';
import type { CoverageReport } from '../gitnexus/coverage.js';
import type { MaintenanceInfo } from '../index.js';

/**
 * What the route needs from the host half.
 *
 * Injected rather than imported so the route stays testable without a GitNexus
 * install: the engine arrives as two functions, and a test supplies stubs.
 */
export interface CoverageRouteDeps {
  get: (repoPath: string) => Promise<CoverageReport>;
  maintenance?: (repoPath: string) => MaintenanceInfo;
}

/**
 * @returns disposer that unregisters the route
 */
export function mountCoverageRoute(webServer: WebServerService, deps: CoverageRouteDeps): () => void {
  const handler = guardHandler(async (req, res) => {
    if (!passGuard(req, res)) return;

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const repo = url.searchParams.get('repo');
    if (repo === null || repo.trim() === '') {
      sendJson(res, 400, {
        ok: false,
        code: 'missing-repo',
        message: 'repo query parameter is required',
      });
      return;
    }

    const absRepo = path.resolve(repo);
    if (!(await hasIndex(absRepo))) {
      // Not an error the caller should retry: this directory simply has no index
      // yet, which is the state the panel's initialize action exists for.
      sendJson(res, 404, {
        ok: false,
        code: 'not-indexed',
        message: 'directory has no GitNexus index (.gitnexus/gitnexus.json or meta.json)',
      });
      return;
    }

    if (answerHead(req, res)) return;

    const report = await deps.get(absRepo);
    // The maintenance commands ride along with the report because they are
    // config-derived and only meaningful next to the index they would rebuild.
    const maintenance = typeof deps.maintenance === 'function' ? deps.maintenance(absRepo) : null;
    sendJson(res, 200, { ok: true, report, maintenance });
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/coverage', handler });
}
