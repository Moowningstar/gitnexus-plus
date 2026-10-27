/**
 * `POST /api/gitnexus/checkout?repo=<project>` with `{ "branch": "<ref>" }`
 *
 * The one route that changes the working tree. Every other route reads; this one runs
 * `git checkout`, so it is deliberately separate from the readers and takes the write
 * guard that a cross-origin page cannot satisfy.
 *
 * What it does not do:
 * - no `--force`: staged or unstaged changes that conflict must stop the switch, and
 *   git's own refusal is forwarded word for word
 * - no rebuild: `.gitnexus` still describes the previous branch until `analyze` runs,
 *   and the coverage report already says so
 * - no ref guessing: the branch is validated here as well as in the engine, because a
 *   route that forwards `--all` to `git checkout` is a route that can detach a HEAD
 */

import path from 'node:path';
import { isProjectRoot } from '../gitnexus/index-meta.js';
import { normalizeActivityRef } from '../gitnexus/git-activity.js';
import { guardHandler, passGuard, passWriteGuard, answerHead, sendJson, readJsonBody } from './guard.js';
import type { WebServerService } from '@deepseek-ai/cordis';

/** `POST` switches; `HEAD` lets the host answer a probe without starting git. */
const CHECKOUT_METHODS: ReadonlySet<string> = new Set(['POST', 'HEAD']);

export interface CheckoutRouteDeps {
  checkout: (repoPath: string, branch: string) => Promise<{
    ok: boolean;
    branch: string;
    message: string | null;
  }>;
}

/**
 * @returns disposer that unregisters the route
 */
export function mountCheckoutRoute(
  webServer: WebServerService,
  deps: CheckoutRouteDeps,
): () => void {
  const handler = guardHandler(async (req, res) => {
    if (!passGuard(req, res, CHECKOUT_METHODS)) return;

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const repo = url.searchParams.get('repo');
    if (repo === null || repo.trim() === '') {
      sendJson(res, 400, {
        ok: false,
        code: 'missing-params',
        message: 'repo query parameter is required',
      });
      return;
    }

    if (answerHead(req, res)) return;

    // The only mutating route, so the only one behind the write guard.
    if (!passWriteGuard(req, res)) return;

    const absRepo = path.resolve(repo);
    if (!(await isProjectRoot(absRepo))) {
      sendJson(res, 404, {
        ok: false,
        code: 'not-a-project',
        message: 'directory is neither a GitNexus index nor a git repository root',
      });
      return;
    }

    const body = await readJsonBody(req).catch(() => null);
    const branch = (body as { branch?: unknown } | null)?.branch;
    if (typeof branch !== 'string' || branch.trim() === '') {
      sendJson(res, 400, {
        ok: false,
        code: 'missing-branch',
        message: 'branch is required',
      });
      return;
    }
    // Refuse before spawning: `git checkout --all` would detach HEAD, and answering
    // that with a generic failure hides the reason.
    const ref = normalizeActivityRef(branch);
    if (ref === null) {
      sendJson(res, 400, {
        ok: false,
        code: 'invalid-branch',
        message: 'branch must be a plain ref name (no flags, whitespace, or ..)',
      });
      return;
    }

    const result = await deps.checkout(absRepo, ref);
    if (!result.ok) {
      // 409: the request was well-formed, the working tree refused it. A dirty tree is
      // the common case and the message is git's, not ours.
      sendJson(res, 409, {
        ok: false,
        code: 'checkout-failed',
        message: result.message ?? 'git checkout 失败',
      });
      return;
    }
    sendJson(res, 200, { ok: true, branch: result.branch });
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/checkout', handler });
}
