/**
 * The endpoint that installs GitNexus on this machine.
 *
 * Its own route rather than a branch in `analyze.ts`, because it is a different kind of
 * action: `analyze` reads and writes an index that already exists, while this downloads
 * several hundred megabytes and runs the package's build scripts. Separating them keeps
 * the cheap, frequent operation from being reviewed alongside the expensive, rare one.
 *
 * `POST` starts, `GET` reports, `DELETE` cancels — the same shape as the analyze route,
 * for the same reason: the panel polls the URL it started.
 */

import path from 'node:path';
import { guardHandler, passGuard, passWriteGuard, answerHead, sendJson } from './guard.js';
import type { WebServerService } from '@deepseek-ai/cordis';
import type { InstallStatus } from '../gitnexus/install.js';

const INSTALL_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'DELETE']);

export interface InstallRouteDeps {
  start: () => InstallStatus;
  status: () => InstallStatus | null;
  cancel: () => boolean;
  /** Where a successful install puts the CLI, so the panel can show it. */
  cliPath: () => string;
}

/**
 * @returns disposer that unregisters the route
 */
export function mountInstallRoute(webServer: WebServerService, deps: InstallRouteDeps): () => void {
  const handler = guardHandler(async (req, res) => {
    if (!passGuard(req, res, INSTALL_METHODS)) return;
    if (answerHead(req, res)) return;

    if (req.method === 'POST') {
      // Installing runs arbitrary build scripts from the dependency tree, so this is the
      // most privileged verb this plugin exposes and takes the cross-origin write guard.
      if (!passWriteGuard(req, res)) return;
      sendJson(res, 200, { ok: true, run: deps.start(), cliPath: deps.cliPath() });
      return;
    }

    if (req.method === 'DELETE') {
      if (!passWriteGuard(req, res)) return;
      sendJson(res, 200, { ok: true, cancelled: deps.cancel(), run: deps.status() });
      return;
    }

    sendJson(res, 200, { ok: true, run: deps.status(), cliPath: deps.cliPath() });
  });

  return webServer.register({ kind: 'prefix', path: '/api/gitnexus/install', handler });
}

/** Narrow a repo path for the panel's benefit; unused by the route itself. */
export function projectName(repoPath: string): string {
  return path.basename(repoPath);
}
