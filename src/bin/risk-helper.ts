#!/usr/bin/env node
/**
 * Dependency-risk helper, run by the **system Node** rather than the DSH host.
 *
 * Same execution boundary and same reason as `graph-helper.ts`: the host cannot load
 * GitNexus's LadybugDB native addon. The difference is the input — a change set can hold
 * hundreds of paths, which is not something argv should carry, so the request is a JSON file
 * the host writes and deletes.
 *
 * Invocation:
 *   node risk-helper.js <repo> <requestFile> [managedPrefix]
 *
 * Success: `{ "ok": true, "risk": RiskQueryResult }`
 * Failure: `{ "ok": false, "status": <number>, "code": string, "message": string }`
 *
 * It always exits 0 for a reported failure, so the host reads a structured answer.
 */

import fs from 'node:fs/promises';
import { projectRisk, type RiskRequest } from '../gitnexus/risk-query.js';

/** Write the one object, then exit once stdout has flushed. */
function emit(payload: unknown): void {
  const text = JSON.stringify(payload);
  process.stdout.write(text, () => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

const [, , repoArg, requestArg, managedArg] = process.argv;

async function main(): Promise<void> {
  if (typeof repoArg !== 'string' || repoArg === '' || typeof requestArg !== 'string' || requestArg === '') {
    emit({ ok: false, status: 400, code: 'bad-request', message: 'usage: risk-helper <repo> <requestFile> [managedPrefix]' });
    return;
  }
  let request: RiskRequest;
  try {
    const text = await fs.readFile(requestArg, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { files?: unknown }).files)) {
      throw new Error('request must be an object with a files array');
    }
    request = parsed as RiskRequest;
  } catch (error) {
    emit({
      ok: false,
      status: 400,
      code: 'bad-request',
      message: `无法读取请求：${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  try {
    const risk = await projectRisk(repoArg, request, {
      ...(typeof managedArg === 'string' && managedArg !== '' ? { managedPrefix: managedArg } : {}),
    });
    emit({ ok: true, risk });
  } catch (error) {
    emit({
      ok: false,
      status: 500,
      code: 'risk-failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

await main();
