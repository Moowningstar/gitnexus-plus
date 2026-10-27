/**
 * `GET /api/gitnexus/coverage?repo=<project>` — the panel's data source.
 *
 * Route shape follows the community convention (`/api/<plugin-slug>/…`) and the
 * carrier contract in `@deepseek-ai/dsh-host-webserver`: bare `node:http`, no
 * Express, exact-then-longest-prefix matching, and a disposer for teardown.
 *
 * THE BOUND IS "A DIRECTORY THE CALLER NAMED", NOT "IS IN THE REGISTRY"
 * ----------------------------------------------------------------------
 * An earlier revision accepted only paths present in `~/.gitnexus/registry.json`.
 * That was wrong for the panel's actual job: it shows the project the user is
 * *in*, and a working directory the global registry has never heard of — a fresh
 * clone, an index built with `GITNEXUS_HOME` redirected — is exactly the case the
 * panel exists to report on. Refusing it would have been a correctness bug wearing
 * a security costume.
 *
 * A later revision required an index. That was also wrong, for the same reason at a
 * different state: a project with no index yet still has a readable working tree,
 * and the engine already builds a useful scan-only report for it. A further revision
 * still required a `.git` marker, which refused the exact directory this panel is
 * most useful for on a machine without git: GitNexus indexes any folder with
 * `--skip-git`, and the scan-only report never needed git in the first place.
 *
 * The bound is now an existing directory that is not a filesystem root. The route
 * does not offer a directory listing: it describes exactly the path it is given.
 * Loopback and method guards live in `./guard.js`.
 *
 * RESOLUTION IS A SEPARATE READ
 * -----------------------------
 * A workspace may contain several indexed projects. `/api/gitnexus/projects` resolves
 * that list and the client chooses one; this route stays "describe this path", so a
 * project switch does not change what a refresh means and an older client keeps the
 * old contract.
 */

import path from 'node:path';
import { isExistingDirectory, isFilesystemRoot } from '../gitnexus/index-meta.js';
import { guardHandler, passGuard, answerHead, sendJson } from './guard.js';
import type { WebServerService } from '@deepseek-ai/cordis';
import type { CoverageProgress, CoverageReport } from '../gitnexus/coverage.js';
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
  get: (
    repoPath: string,
    options?: {
      fresh?: boolean;
      onProgress?: (progress: CoverageProgress) => void;
      /** How far back the activity window reaches; absent means the engine's default. */
      activitySinceDays?: number;
    },
  ) => Promise<CoverageReport>;
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
    // The bound is the directory itself, not a project marker: a folder with no
    // `.git` and no index is still the operator's working tree, and the engine's
    // scan-only report is exactly what makes that state informative. Refusing it
    // produced the raw 404 the panel rendered as a dead end. Filesystem roots are
    // excluded — scanning a whole drive is not a project report.
    if (!(await isExistingDirectory(absRepo)) || isFilesystemRoot(absRepo)) {
      sendJson(res, 404, {
        ok: false,
        code: 'not-a-directory',
        message: `目录不存在、不是文件夹，或是文件系统根目录：${absRepo}`,
      });
      return;
    }

    if (answerHead(req, res)) return;

    // `refresh=1` comes from the panel's manual refresh control. A background poll
    // omits it and gets the cached copy, which is what the TTL is for.
    const fresh = url.searchParams.get('refresh') === '1';
    // `days` is the activity window the card's own selector shows. Without it the card
    // labelled a 90-day report "近 7 天" and a file whose one change sat on day 12
    // opened a "0 commits" timeline.
    const rawDays = url.searchParams.get('days');
    const parsedDays = rawDays === null ? Number.NaN : Number.parseInt(rawDays, 10);
    const activitySinceDays = Number.isFinite(parsedDays)
      ? Math.max(1, Math.min(90, parsedDays))
      : undefined;
    // The maintenance commands ride along with the report because they are
    // config-derived and only meaningful next to the index they would rebuild.
    const maintenance = typeof deps.maintenance === 'function' ? deps.maintenance(absRepo) : null;

    // `stream=1` is the panel's numeric-progress channel. NDJSON rather than SSE:
    // one JSON object per line needs no event naming and falls back to plain JSON
    // for any caller that does not ask for it.
    if (url.searchParams.get('stream') === '1') {
      const write = (payload: unknown): void => {
        if (res.writableEnded) return;
        try {
          res.write(`${JSON.stringify(payload)}\n`);
        } catch {
          // The reader disconnected; the rest of the work is already in flight.
        }
      };
      res.statusCode = 200;
      res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders();
      try {
        const report = await deps.get(absRepo, {
          fresh,
          activitySinceDays,
          onProgress: (progress) => write({ type: 'progress', ...progress }),
        });
        // The engine ends at 99%; the final boundary is the route having the whole
        // report in hand, so 100 is emitted here rather than invented earlier.
        write({
          type: 'progress',
          phase: 'assemble',
          percent: 100,
          label: '报告已读取',
        });
        write({
          type: 'report',
          report,
          maintenance,
          readAt: new Date().toISOString(),
        });
      } catch (error) {
        write({
          type: 'error',
          status: 500,
          code: 'internal-error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      res.end();
      return;
    }

    const report = await deps.get(absRepo, { fresh, activitySinceDays });
    // `readAt` is what makes a refresh visible: without it two reads of an unchanged
    // repository are byte-identical on screen, so the control looks inert even when
    // it did exactly what it was asked.
    sendJson(res, 200, {
      ok: true,
      report,
      maintenance,
      readAt: new Date().toISOString(),
    });
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/coverage', handler });
}
