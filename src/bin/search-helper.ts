#!/usr/bin/env node
/**
 * Search helper, run by the **system Node** rather than the DSH host.
 *
 * The host is Electron's Node and cannot load GitNexus's LadybugDB native addon
 * (ABI mismatch: "A dynamic link library (DLL) initialization routine failed").
 * This process is started with the platform Node that the CLI already uses, imports
 * the same adapter, runs one read-only query, and prints exactly one JSON object for
 * the host to parse.
 *
 * Invocation:
 *   node search-helper.js <repo> <sanitized-query> [limit] [managedPrefix]
 *
 * Success: `{ "ok": true, "report": SearchReport }`
 * Failure: `{ "ok": false, "status": <number>, "code": <SearchErrorCode>, "message": string }`
 *
 * It always exits 0 for a reported failure, so the host reads a structured answer
 * instead of inferring one from an exit code. A process-level crash (native fault)
 * is the one case the host handles from an unparseable stdout/stderr pair.
 */

import { SearchError, searchSymbols } from '../gitnexus/search.js';

/** Write the one object, then exit once stdout has flushed. */
function emit(payload: unknown): void {
  const text = JSON.stringify(payload);
  process.stdout.write(text, () => process.exit(0));
  // A native handle can keep the event loop alive; the payload is already queued.
  setTimeout(() => process.exit(0), 2000).unref();
}

const [, , repoArg, queryArg, limitArg, managedArg] = process.argv;

if (typeof repoArg !== 'string' || repoArg === '' || typeof queryArg !== 'string') {
  emit({
    ok: false,
    status: 400,
    code: 'invalid-query',
    message: 'usage: search-helper <repo> <query> [limit] [managedPrefix]',
  });
} else {
  const parsedLimit = limitArg === undefined ? undefined : Number.parseInt(limitArg, 10);
  const limit = parsedLimit === undefined || !Number.isFinite(parsedLimit) ? undefined : parsedLimit;
  try {
    const report = await searchSymbols(repoArg, queryArg, {
      limit,
      managedPrefix: managedArg === undefined || managedArg === '' ? undefined : managedArg,
    });
    emit({ ok: true, report });
  } catch (error) {
    emit({
      ok: false,
      status: error instanceof SearchError ? error.status : 500,
      code: error instanceof SearchError ? error.code : 'search-failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
