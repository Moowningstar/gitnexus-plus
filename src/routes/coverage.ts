/**
 * `GET /api/gitnexus/coverage?repo=<project>` — the panel's data source.
 *
 * Route shape follows the community convention (`/api/<plugin-slug>/…`) and the
 * carrier contract in `@deepseek-ai/dsh-host-webserver`: bare `node:http`, no
 * Express, exact-then-longest-prefix matching, and a disposer for teardown.
 *
 * THE BOUND IS "IS A PROJECT ROOT", NOT "IS IN THE REGISTRY"
 * ----------------------------------------------------------
 * An earlier revision accepted only paths present in `~/.gitnexus/registry.json`.
 * That was wrong for the panel's actual job: it shows the project the user is
 * *in*, and a working directory the global registry has never heard of — a fresh
 * clone, an index built with `GITNEXUS_HOME` redirected — is exactly the case the
 * panel exists to report on. Refusing it would have been a correctness bug wearing
 * a security costume.
 *
 * A later revision required an index. That was also wrong, for the same reason at a
 * different state: a project with no index yet still has a readable working tree,
 * and the engine already builds a useful scan-only report for it. The bound is now a
 * project root (`.gitnexus` or `.git`), which still refuses arbitrary directories.
 *
 * The route still refuses to describe arbitrary directories: the path must be a
 * project root — carrying `.gitnexus/gitnexus.json`, `.gitnexus/meta.json`, or a
 * `.git` marker — so a caller cannot use it to enumerate a filesystem. An index is
 * no longer required: the engine's scan-only report is what makes the "no index
 * yet" state informative instead of an empty command. Loopback and method guards
 * live in `./guard.js`.
 */

import path from 'node:path';
import { isProjectRoot } from '../gitnexus/index-meta.js';
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
  /**
   * `fresh` asks the engine to skip its short-lived cache. A manual refresh carries
   * it; a background poll does not, which is the case the cache exists for.
   */
  get: (repoPath: string, options?: { fresh?: boolean }) => Promise<CoverageReport>;
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
    // The bound changed from "is a GitNexus index" to "is a project root": a
    // directory with neither an index nor a `.git` marker is still refused, so the
    // route cannot be used to enumerate a filesystem. A git repository without an
    // index is the state the panel's initialize action exists for, and the engine
    // already produces a useful scan-only report for it (file counts, bytes,
    // languages, the size cap). Refusing that state was hiding data, not protecting
    // anything — the route only answers loopback callers.
    if (!(await isProjectRoot(absRepo))) {
      sendJson(res, 404, {
        ok: false,
        code: 'not-a-project',
        message: 'directory is neither a GitNexus index nor a git repository root',
      });
      return;
    }

    if (answerHead(req, res)) return;

    // `refresh=1` comes from the panel's manual refresh control. A background poll
    // omits it and gets the cached copy, which is what the TTL is for.
    const fresh = url.searchParams.get('refresh') === '1';
    const report = await deps.get(absRepo, { fresh });
    // The maintenance commands ride along with the report because they are
    // config-derived and only meaningful next to the index they would rebuild.
    const maintenance = typeof deps.maintenance === 'function' ? deps.maintenance(absRepo) : null;
    // `readAt` is what makes a refresh visible: without it two reads of an unchanged
    // repository are byte-identical on screen, so the control looks inert even when
    // it did exactly what it was asked.
    sendJson(res, 200, { ok: true, report, maintenance, readAt: new Date().toISOString() });
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/coverage', handler });
}
