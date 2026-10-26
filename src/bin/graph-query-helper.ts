#!/usr/bin/env node
/**
 * Agent-tool helper: run one GitNexus MCP tool and print exactly one JSON object.
 *
 * Same execution boundary as `graph-helper`: the host is Electron's Node and cannot
 * load GitNexus's native store, so the query runs here on the system Node and only
 * JSON crosses back.
 *
 * The request travels in a **file**, not in argv. A symbol name is caller-supplied
 * text that may contain spaces, quotes or a newline, and every shell quoting rule is
 * one more thing to get wrong; a path plus a JSON body has no quoting rules at all.
 *
 * Invocation:
 *   node graph-query-helper.js <request.json> [managedPrefix]
 *
 * `managedPrefix` is the plugin's install directory. It is passed in rather than
 * resolved here for the same reason `graph-helper` and `search-helper` take it: the
 * plugin may have installed its own GitNexus, and PATH can point at a different one.
 * Two copies of the package link different native stores (`@ladybugdb/core`), and a
 * reader older than the writer refuses the index outright — "different storage
 * version" is what that looks like from here. Absent or empty means "discover it".
 *
 * The request is `{ "repo": "<absolute path>", "tool": "impact"|"context"|"query",
 * "params": { … } }` — `params` is passed through to the upstream tool.
 *
 * Success: `{ "ok": true, "tool": string, "result": unknown }`
 * Failure: `{ "ok": false, "code": string, "message": string }`
 *
 * It always exits 0 for a reported failure, so the host reads a structured answer
 * instead of inferring one from an exit code.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The stdout writer as it was before anything else loaded.
 *
 * GitNexus installs a sentinel over `process.stdout` that redirects every write not
 * tagged as an MCP frame — including this one, which is a *result*, not a frame. The
 * captured reference still points at the real stream, so the payload reaches fd 1
 * whichever wrappers get installed afterwards.
 */
const rawWrite = process.stdout.write.bind(process.stdout);

/** Set once the sentinel's own tagging helper is available. */
let tagWrite: ((fn: () => void) => void) | null = null;

/** Write the one object, then exit once stdout has flushed. */
function emit(payload: unknown): void {
  const text = JSON.stringify(payload);
  const write = () => {
    rawWrite(text, () => process.exit(0));
  };
  // Only meaningful when the sentinel is installed; guarding on its presence keeps the
  // helper honest on a GitNexus build that does not ship one.
  if (tagWrite === null) write();
  else tagWrite(write);
  // A native handle can keep the event loop alive; the payload is already queued.
  setTimeout(() => process.exit(0), 2000).unref();
}

/** Tools this helper is allowed to run. Mirrors the guards in `graph-query.ts`. */
const TOOLS = new Set(['impact', 'context', 'query']);

interface Request {
  repo: string;
  tool: string;
  params: Record<string, unknown>;
}

function readRequest(file: string): Request {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Request>;
  if (typeof parsed.repo !== 'string' || parsed.repo === '') {
    throw new Error('request is missing `repo`');
  }
  if (typeof parsed.tool !== 'string' || !TOOLS.has(parsed.tool)) {
    throw new Error(`request names an unknown tool: ${String(parsed.tool)}`);
  }
  const params = parsed.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('request is missing `params`');
  }
  return { repo: parsed.repo, tool: parsed.tool, params };
}

/** An error reduced to the one line the caller is willing to show. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function main(): Promise<void> {
  const [, , requestArg, managedArg] = process.argv;
  if (typeof requestArg !== 'string' || requestArg === '') {
    emit({ ok: false, code: 'invalid-request', message: 'usage: graph-query-helper <request.json>' });
    return;
  }

  let request: Request;
  try {
    request = readRequest(requestArg);
  } catch (error) {
    emit({ ok: false, code: 'invalid-request', message: describe(error) });
    return;
  }

  // The package root is resolved here rather than passed in: the helper runs on the
  // system Node, and `root.js` is the plugin's own discovery, so helper and panel agree.
  // The managed prefix comes from the caller so that agreement survives the case where
  // the plugin installed GitNexus itself and PATH points elsewhere.
  const { findGitnexusRoot } = await import('../gitnexus/root.js');
  const root = findGitnexusRoot({
    env: process.env,
    ...(typeof managedArg === 'string' && managedArg !== '' ? { managedPrefix: managedArg } : {}),
  });
  if (root === null) {
    emit({
      ok: false,
      code: 'gitnexus-missing',
      message: '找不到 gitnexus 包；插件的 install 流程装好后才能读图。',
    });
    return;
  }

  const dist = path.join(root, 'dist');
  // Before any heavy import: the sentinel keeps native banners off stdout, which is
  // where the one JSON object goes.
  const stdio = await import(pathToFileURL(path.join(dist, 'mcp', 'stdio-context.js')).href);
  if (typeof stdio.installGlobalStdoutSentinel === 'function') {
    stdio.installGlobalStdoutSentinel();
  }
  if (typeof stdio.withMcpWrite === 'function') {
    tagWrite = (fn) => {
      stdio.withMcpWrite(fn);
    };
  }

  try {
    const module = await import(pathToFileURL(path.join(dist, 'mcp', 'local', 'local-backend.js')).href);
    const backend = new module.LocalBackend();
    await backend.init();
    try {
      // Absolute path, not a name: a name is resolved against whatever registry the
      // home points at, and two checkouts of the same project would collide.
      const result = await backend.callTool(request.tool, {
        ...request.params,
        repo: request.repo,
      });
      emit({ ok: true, tool: request.tool, result });
    } finally {
      await backend.disconnect();
    }
  } catch (error) {
    emit({ ok: false, code: 'tool-failed', message: describe(error) });
  }
}

await main();
