/**
 * Engine test runner: executes every suite in order and prints the totals.
 *
 * The suites themselves live in `test/suites/`, grouped by subject; this file only
 * owns the order (which matters: several suites build fixtures and clean them up).
 *
 * The awaits live inside `main()` instead of at module top level, and that is not
 * stylistic: `detect-changes` maps changed files to symbols, and a changed file whose
 * diff contains no symbol at all makes the whole pre-commit check answer `PARTIAL
 * RESULT` ("No symbols mapped for changed source files"). One exported entry point
 * gives this file a symbol without changing what `node test/run.mjs` does.
 */

import { pathToFileURL } from 'node:url';
import { summary } from './harness.mjs';
import { fixtureTests, discoveryTests, binaryTests, regressionTests, crossCheckTests, stalenessTests, capabilityTests, languageTests, commandTests, formatTests, compatibilityTests, graphQualityTests } from './suites/coverage.mjs';
import { versionLinesTests } from './suites/version-lines.mjs';
import { searchTests, ftsSearchTests, searchRouteTests } from './suites/search.mjs';
import { routeTests, fileHistoryRouteTests } from './suites/routes.mjs';
import { checkoutRouteTests } from './suites/checkout-route.mjs';
import { analyzeTests, installTests } from './suites/runners.mjs';
import { deltaTests } from './suites/delta.mjs';
import { freshnessTests } from './suites/freshness.mjs';
import { coverageGateTests } from './suites/coverage-gate.mjs';
import { storageStateTests } from './suites/storage-state.mjs';
import { managedPathTests, anchorTests } from './suites/anchor.mjs';
import { gitLogTests } from './suites/git-log.mjs';
import { graphTests } from './suites/graphs.mjs';
import { graphQueryRenderTests, graphQueryToolTests } from './suites/graph-query.mjs';
import { subprocessTests } from './suites/subprocess.mjs';
import { encodingTests } from './suites/encoding.mjs';
import { hygieneTests } from './suites/hygiene.mjs';
import { shellTests, aiSettingsTests, webDistTests, webViewProbeTests } from './suites/webview-setup.mjs';
import { webViewTests } from './suites/webview.mjs';
import { graphToolSmoke, realRepoSmoke } from './suites/smoke.mjs';

/**
 * Run every engine suite in order and report the totals.
 *
 * Exported so the file has an analysable symbol (see the header) — and so a future
 * runner can call it instead of shelling out.
 *
 * @returns {Promise<{ passed: number, failed: number }>}
 */
export async function main() {
  console.log('\u001b[1mgitnexus-plus · coverage engine tests\u001b[0m');
  await fixtureTests();
  await discoveryTests();
  await binaryTests();
  await regressionTests();
  await crossCheckTests();
  await stalenessTests();
  await capabilityTests();
  await languageTests();
  await commandTests();
  await formatTests();
  await compatibilityTests();
  await versionLinesTests();
  await graphQualityTests();
  await searchTests();
  await ftsSearchTests();
  await searchRouteTests();
  await routeTests();
  await fileHistoryRouteTests();
  await checkoutRouteTests();
  await analyzeTests();
  await installTests();
  // `deltaRouteTests` is not listed here: the delta suite invokes it itself, in both the
  // git-less skip path and the normal path, so awaiting it again would double-count.
  await deltaTests();
  // Pure: the report is a literal, so this runs whether or not git is available here.
  await freshnessTests();
  // Same reason: the gate turns literal reports into a verdict, no index involved.
  await coverageGateTests();
  // The storage decision is a pure table plus a few real directories; no git, no index.
  await storageStateTests();
  await managedPathTests();
  await anchorTests();
  await gitLogTests();
  await graphTests();
  await graphQueryRenderTests();
  await graphQueryToolTests();
  await subprocessTests();
  await encodingTests();
  await hygieneTests();
  await shellTests();
  await aiSettingsTests();
  await webDistTests();
  await webViewProbeTests();
  await webViewTests();
  await realRepoSmoke();
  await graphToolSmoke();

  const { passed, failed } = summary();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  return { passed, failed };
}

// `node test/run.mjs` still runs the suites and still sets the exit code; importing
// this module does nothing.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const { failed } = await main();
  process.exit(failed === 0 ? 0 : 1);
}
