/**
 * The read-only half of the web-view runner: does a server answer, and can it see
 * this repository?
 *
 * Kept apart from the lifecycle in `webview.ts` because the questions are different
 * in kind. Nothing here spawns, stops or remembers anything: every function is a
 * question about the outside world, answerable without owning a process.
 */

import path from 'node:path';
import { defaultGitnexusHome } from './commands.js';
import { globalDir, normalizePathKey, readRegistry } from './index-meta.js';

/** The slice of `fetch` the probes use, so tests can answer without a socket. */
export type ProbeFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Health checks are local and loopback; waiting long here only delays the panel. */
export const HEALTH_TIMEOUT_MS = 700;

/** Two paths name the same repository, tolerating case, separators and trailing slashes. */
export function repoPathMatches(left: string, right: string): boolean {
  try {
    return normalizePathKey(left) === normalizePathKey(right);
  } catch {
    return false;
  }
}

/**
 * Registry directories to try, in order, for one repository.
 *
 * The configured home wins because it is what the operator asked for; the plugin-owned
 * home next to the index comes next because that is where this plugin's own analysis
 * registers; `~/.gitnexus` last, for an index made by hand.
 */
export function registryHomesFor(repoPath: string, configured?: string): string[] {
  const homes: string[] = [];
  if (typeof configured === 'string' && configured.trim() !== '') homes.push(path.resolve(configured));
  homes.push(defaultGitnexusHome(repoPath));
  homes.push(globalDir());
  // De-duplicate while keeping the order: the first hit is the one that counts.
  const seen = new Set<string>();
  return homes.filter((home) => {
    const key = normalizePathKey(home);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Whether a registry directory holds an entry for this repository. */
export async function registryHasRepo(home: string, repoPath: string): Promise<boolean> {
  const entries = await readRegistry({ env: { ...process.env, GITNEXUS_HOME: home } });
  return entries.some((entry) => repoPathMatches(entry.path, repoPath));
}

/** What a running server can be asked, without giving it an owner. */
export interface WebViewProbe {
  /** `/api/health` answers `{status: 'ok'}`. */
  probeHealth(port: number): Promise<boolean>;
  /** The repository paths the server reports, or null when it will not say. */
  listRepos(port: number): Promise<string[] | null>;
  /** The server lists this repository, so `?repo=` will resolve to it. */
  serverHasRepo(port: number, repoPath: string): Promise<boolean>;
}

/** Bind the probes to one host and one fetch. */
export function createWebViewProbe(options: { host: string; fetchLike: ProbeFetch }): WebViewProbe {
  const { host, fetchLike } = options;

  const probeHealth = async (port: number): Promise<boolean> => {
    try {
      const response = await fetchLike(`http://${host}:${port}/api/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { status?: unknown } | null;
      return body !== null && body.status === 'ok';
    } catch {
      return false;
    }
  };

  const listRepos = async (port: number): Promise<string[] | null> => {
    try {
      const response = await fetchLike(`http://${host}:${port}/api/repos`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as unknown;
      if (!Array.isArray(body)) return null;
      return body
        .map((entry) => (entry as { path?: unknown }).path)
        .filter((value): value is string => typeof value === 'string');
    } catch {
      return null;
    }
  };

  const serverHasRepo = async (port: number, repoPath: string): Promise<boolean> => {
    const paths = await listRepos(port);
    if (paths === null) return false;
    return paths.some((value) => repoPathMatches(value, repoPath));
  };

  return { probeHealth, listRepos, serverHasRepo };
}
