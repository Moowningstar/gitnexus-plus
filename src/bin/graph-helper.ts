#!/usr/bin/env node
/**
 * Graph projection helper, run by the **system Node** rather than the DSH host.
 *
 * The host is Electron's Node and cannot load GitNexus's LadybugDB native addon
 * (ABI mismatch: "A dynamic link library (DLL) initialization routine failed").
 * This process is started with the platform Node the CLI already uses, imports the
 * same adapter, runs the bounded projection, and prints exactly one JSON object.
 *
 * Invocation:
 *   node graph-helper.js <repo> <view> <id> [managedPrefix] [nodeBudget] [edgeBudget]
 *
 * Success: `{ "ok": true, "projection": GraphProjection }`
 * Failure: `{ "ok": false, "status": <number>, "code": <GraphErrorCode>, "message": string }`
 *
 * It always exits 0 for a reported failure, so the host reads a structured answer
 * instead of inferring one from an exit code. A process-level crash (native fault)
 * is the one case the host handles from an unparseable stdout/stderr pair.
 */

import { GraphError, isGraphView, projectGraph } from '../gitnexus/graph.js';

/** Write the one object, then exit once stdout has flushed. */
function emit(payload: unknown): void {
  const text = JSON.stringify(payload);
  process.stdout.write(text, () => process.exit(0));
  // A native handle can keep the event loop alive; the payload is already queued.
  setTimeout(() => process.exit(0), 2000).unref();
}

const [, , repoArg, viewArg, idArg, managedArg, nodeArg, edgeArg] = process.argv;

const parseBudget = (value: string | undefined): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

if (typeof repoArg !== 'string' || repoArg === '') {
  emit({
    ok: false,
    status: 400,
    code: 'invalid-view',
    message: 'usage: graph-helper <repo> <view> [id] [managedPrefix] [nodeBudget] [edgeBudget]',
  });
} else if (!isGraphView(viewArg)) {
  emit({
    ok: false,
    status: 400,
    code: 'invalid-view',
    message: `未知的图视图：${String(viewArg)}（可用：communities、community）`,
  });
} else {
  try {
    const projection = await projectGraph(repoArg, {
      view: viewArg,
      id: typeof idArg === 'string' && idArg !== '' ? idArg : undefined,
      managedPrefix: managedArg === undefined || managedArg === '' ? undefined : managedArg,
      nodeBudget: parseBudget(nodeArg),
      edgeBudget: parseBudget(edgeArg),
    });
    emit({ ok: true, projection });
  } catch (error) {
    emit({
      ok: false,
      status: error instanceof GraphError ? error.status : 500,
      code: error instanceof GraphError ? error.code : 'graph-failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
