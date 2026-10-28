/**
 * Engine test runner: executes every suite in order and prints the totals.
 *
 * The suites themselves live in `test/suites/`, grouped by subject; this file only
 * owns the order (which matters: several suites build fixtures and clean them up).
 */

import { summary } from './harness.mjs';
import { fixtureTests, discoveryTests, binaryTests, regressionTests, crossCheckTests, stalenessTests, capabilityTests, languageTests, commandTests, formatTests, compatibilityTests, graphQualityTests } from './suites/coverage.mjs';
import { versionLinesTests } from './suites/version-lines.mjs';
import { searchTests, ftsSearchTests, searchRouteTests } from './suites/search.mjs';
import { routeTests, fileHistoryRouteTests } from './suites/routes.mjs';
import { checkoutRouteTests } from './suites/checkout-route.mjs';
import { analyzeTests, installTests } from './suites/runners.mjs';
import { deltaTests } from './suites/delta.mjs';
import { freshnessTests } from './suites/freshness.mjs';
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
process.exit(failed === 0 ? 0 : 1);
