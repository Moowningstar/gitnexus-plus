#!/usr/bin/env node
/**
 * Browser-half tests.
 *
 * Three levels, because each catches a failure the others cannot:
 *
 *   wrapper  — load the built `lib/client.js` through a stubbed
 *              `window.__ModuleLoader__` and assert the factory hands back a
 *              module with the right shape. A malformed wrapper is invisible to
 *              every other test and fails only in a browser.
 *   wiring   — drive `apply()` against a stub context and assert what it
 *              contributes. Catches a slot name typo, which produces no error
 *              anywhere — the surface simply never appears.
 *   render   — actually render the pure view against fixtures. This is the only
 *              check that would notice a null dereference or a wrong prop name
 *              inside the panel, and it is why fetching was split from
 *              presentation.
 *
 * `react-dom` is not installed on this machine, so rendering uses a minimal
 * single-pass hooks shim: `useState` yields its initial value and `useEffect` is
 * recorded but never run. That is sufficient for a pure component and honest
 * about what it does not cover — effect behaviour and re-render are untested here.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
/** @param {string} name @param {boolean} ok @param {string} [detail] */
import { renderSuite } from './client/render.mjs';
import { graphSuite } from './client/graph.mjs';

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } else {
    failed += 1;
    console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
/** @param {string} title */
function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

// ---------------------------------------------------------------------------
// Minimal single-pass render harness
// ---------------------------------------------------------------------------

const React = require('react');
const FRAGMENT = Symbol.for('react.fragment');

/** @type {Array<{slots: any[], cursor: number}>} */
const hookStack = [];

function withHookFrame(fn) {
  hookStack.push({ slots: [], cursor: 0 });
  try {
    return fn();
  } finally {
    hookStack.pop();
  }
}

/** React-compatible hook subset, enough for one synchronous render. */
const hooks = {
  useState(initial) {
    const frame = hookStack[hookStack.length - 1];
    const index = frame.cursor++;
    if (!(index in frame.slots)) frame.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [frame.slots[index], () => {}];
  },
  useEffect() {
    /* recorded by design; not run */
  },
  useMemo(fn) {
    return fn();
  },
  useRef(initial) {
    return { current: initial };
  },
};

/**
 * Render an element tree to flat text plus the host tag sequence.
 *
 * `styles` collects every `style` object met on the way: a layout decision that only
 * exists in CSS (a sticky header, an opaque background) cannot be asserted from text.
 * `nodes` keeps each host element with its props for the same reason one level down:
 * an SVG line's `stroke` is the whole point of a lane colour and appears nowhere in
 * the text.
 *
 * @param {any} node
 * @returns {{text: string, tags: string[], styles: any[], nodes: Array<{type: string, props: any}>}}
 */
function renderTree(node) {
  const text = [];
  const tags = [];
  const styles = [];
  const nodes = [];

  const walk = (current) => {
    if (current === null || current === undefined || typeof current === 'boolean') return;
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (typeof current === 'string' || typeof current === 'number') {
      text.push(String(current));
      return;
    }
    if (typeof current !== 'object' || current.type === undefined) return;

    if (current.type === FRAGMENT) {
      walk(current.props?.children);
      return;
    }
    if (typeof current.type === 'function') {
      withHookFrame(() => walk(current.type({ ...current.props, children: current.props?.children })));
      return;
    }
    tags.push(String(current.type));
    nodes.push({ type: String(current.type), props: current.props ?? {} });
    if (current.props?.style !== undefined) styles.push(current.props.style);
    walk(current.props?.children);
  };

  walk(node);
  return { text: text.join(' '), tags, styles, nodes };
}

/** Render a component with the hook shim active. */
function render(Component, props) {
  return withHookFrame(() => renderTree(React.createElement(Component, props)));
}

// ---------------------------------------------------------------------------
// Load the built bundle the way the browser module table does
// ---------------------------------------------------------------------------

console.log('\u001b[1mgitnexus-plus · client-half tests\u001b[0m');

section('wrapper contract');

const bundlePath = path.join(root, 'lib', 'client.js');
let source;
try {
  source = readFileSync(bundlePath, 'utf8');
  check('lib/client.js exists (run npm run build)', true);
} catch {
  check('lib/client.js exists (run npm run build)', false, `missing ${bundlePath}`);
  console.log(`\n${passed} passed, ${failed + 1} failed\n`);
  process.exit(1);
}

/** @type {{id: string, factory: Function} | null} */
let captured = null;
const previousWindow = globalThis.window;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry;
    },
  },
};

try {
  // eslint-disable-next-line no-eval -- the loader also evaluates the bundle text
  (0, eval)(source);
  check('bundle calls __ModuleLoader__.load', captured !== null);
} catch (error) {
  check('bundle evaluates', false, String(error));
}

check('registered id matches the package name', captured?.id === 'dsh-gitnexus-plus', String(captured?.id));

// The install confirmation spells the version spec out, and it cannot import the
// node-only constant that the installer actually uses. Assert the two agree, so the
// card can never promise a range the runner would not install.
const { GITNEXUS_RANGE } = await import('../lib/gitnexus/install.js');
check(
  "the install confirmation quotes the runner's version range",
  source.includes(`gitnexus@${GITNEXUS_RANGE}`),
  GITNEXUS_RANGE,
);

/**
 * Every `@deepseek-ai/dsh-client-ui-primitives` export this plugin may use.
 *
 * Extracted from real call sites in the installed plugin bundles — not from
 * documentation prose. The guard matters because a wrong component name fails
 * silently in React: `createElement(undefined, …)` throws only at render, in the
 * browser, where no test here would see it. An earlier revision invented
 * `IconFileOutlineRegular`; it does not exist.
 */
const VERIFIED_PRIMITIVES = new Set([
  'Button',
  'SegmentedControl',
  'FileTypeIcon',
  'PathLabel',
  'StateDot',
  'Tag',
  'Tooltip',
  'IconRefreshOutlineRegular',
  'IconWarningOutlineRegular',
  'RiskConfirmation',
  'classifyFileType',
  'fileSizeText',
  'writeClipboard',
]);

/** Minimal stand-ins that render their children so text assertions still work. */
const primitivesStub = {
  Button: ({ children }) => React.createElement('button', { type: 'button' }, children),
  SegmentedControl: ({ options, value, onChange }) =>
    React.createElement(
      'div',
      null,
      (options ?? []).map((o) =>
        React.createElement(
          'button',
          { key: o.value, type: 'button', onClick: () => onChange?.(o.value) },
          o.label,
        ),
      ),
    ),
  Tooltip: ({ children }) => children,
  Tag: ({ children }) => React.createElement('span', null, children),
  // Closed by default in these fixtures; when open, the body is what the operator
  // reads, so the stub renders the same prop the real modal renders.
  RiskConfirmation: ({ open, title, description, acknowledgeLabel }) =>
    open ? React.createElement('div', null, title, description, acknowledgeLabel) : null,
  StateDot: () => null,
  FileTypeIcon: () => null,
  PathLabel: ({ path }) => React.createElement('span', null, path),
  IconRefreshOutlineRegular: () => null,
  IconWarningOutlineRegular: () => null,
  classifyFileType: () => 'code',
  fileSizeText: (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`),
  writeClipboard: () => Promise.resolve(),
};

/**
 * React facade handed to the bundle.
 *
 * `createElement` and `Fragment` are the real ones — element creation needs no
 * dispatcher, so the element shapes under test stay genuine. The hooks are NOT:
 * real `useState` requires a mounted renderer, and `react-dom` is not installed on
 * this machine. Substituting only the hooks keeps the rest of React honest while
 * making a single synchronous render possible.
 */
const ReactFacade = {
  Component: React.Component,
  createElement: React.createElement,
  cloneElement: React.cloneElement,
  isValidElement: React.isValidElement,
  Fragment: React.Fragment,
  useState: hooks.useState,
  useEffect: hooks.useEffect,
  useLayoutEffect: () => {},
  useMemo: hooks.useMemo,
  useCallback: (fn) => fn,
  useRef: hooks.useRef,
  useReducer: (_reducer, initial) => [initial, () => {}],
  memo: (component) => component,
  forwardRef: (component) => component,
  createContext: (value) => ({ Provider: ({ children }) => children, _currentValue: value }),
  useContext: (context) => context?._currentValue,
};

// The loader supplies `require`; only baseline modules are available to it.
const requested = [];
const clientModule = captured.factory((name) => {
  requested.push(name);
  if (name === 'react') return ReactFacade;
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
  throw new Error(`unexpected require('${name}') — only platform baseline modules may be requested`);
});
globalThis.window = previousWindow;

check('factory returns a module object', clientModule !== null && typeof clientModule === 'object');
check('exports inject', Array.isArray(clientModule.inject), JSON.stringify(clientModule.inject));
check('injects slots', clientModule.inject.includes('slots'));
check(
  'does not hard-inject sidebarRightTabs (optional capability)',
  !clientModule.inject.includes('sidebarRightTabs'),
);
check('exports apply', typeof clientModule.apply === 'function');
check('exports internals for tests', typeof clientModule.__internals === 'object');
check(
  'requests only baseline modules',
  requested.every((n) => n === 'react' || n === '@deepseek-ai/dsh-client-ui-primitives'),
  JSON.stringify(requested),
);
check('requests the shared primitives package', requested.includes('@deepseek-ai/dsh-client-ui-primitives'));

const I = clientModule.__internals;
check('no jsx pragma leaked (plain createElement throughout)', !source.includes('jsx('));

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

section('apply() contributions');

// Guard against inventing component names: read the destructuring block out of the
// built bundle and require every name in it to be one that a real plugin uses.
const destructure = source.match(/const\s*\{([\s\S]*?)\}\s*=\s*primitives\s*;/);
check('bundle destructures the primitives package', destructure !== null);
if (destructure !== null) {
  const used = destructure[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  check(
    `every destructured primitive is verified to exist (${used.length} names)`,
    used.every((n) => VERIFIED_PRIMITIVES.has(n)),
    `unverified: ${JSON.stringify(used.filter((n) => !VERIFIED_PRIMITIVES.has(n)))}`,
  );
}

const slotRegistrations = [];
/** @type {Array<{name: string, cb: Function}>} */
const injected = [];
const tabTypes = [];
const effects = [];

const stubCtx = {
  slots: {
    register(options, Component) {
      const record = { options, Component };
      slotRegistrations.push(record);
      return () => {
        const i = slotRegistrations.indexOf(record);
        if (i >= 0) slotRegistrations.splice(i, 1);
      };
    },
    inject(name, cb) {
      injected.push({ name, cb });
      cb();
    },
  },
  inject(names, cb) {
    const child = {
      ...stubCtx,
      sidebarRightTabs: {
        register(definition) {
          tabTypes.push(definition);
          return () => {
            const i = tabTypes.indexOf(definition);
            if (i >= 0) tabTypes.splice(i, 1);
          };
        },
      },
    };
    if (names.includes('sidebarRightTabs')) cb(child);
  },
  effect(fn, label) {
    effects.push(label);
    return fn();
  },
};

clientModule.apply(stubCtx);

check('registered a sidebar-right tab type', tabTypes.length === 1, `got ${tabTypes.length}`);
check('tab kind is gitnexus', tabTypes[0]?.kind === 'gitnexus', String(tabTypes[0]?.kind));
check('tab id matches the plugin id', tabTypes[0]?.id === 'dsh-gitnexus-plus', String(tabTypes[0]?.id));
check('tab title is callable', typeof tabTypes[0]?.title === 'function' && tabTypes[0].title() === 'GitNexus');
check(
  'tab contributes a guide entry (how a user discovers it)',
  Array.isArray(tabTypes[0]?.guide) && tabTypes[0].guide.length === 1 && typeof tabTypes[0].guide[0].title === 'function',
);

const slotNames = slotRegistrations.map((r) => r.options.name);
check('registers the pane body', slotNames.includes('sidebar.right.pane.tab'), JSON.stringify(slotNames));
check('registers the pane title', slotNames.includes('sidebar.right.pane.tab.title'), JSON.stringify(slotNames));
check(
  'every registration is keyed by the plugin id',
  slotRegistrations.every((r) => r.options.key === 'dsh-gitnexus-plus'),
  JSON.stringify(slotRegistrations.map((r) => r.options)),
);
check('every registration is a component', slotRegistrations.every((r) => typeof r.Component === 'function'));
check(
  'all three slot surfaces registered through slots.inject',
  injected.filter((i) => typeof i.name === 'string' && i.name.startsWith('sidebar.right')).length === 2 &&
    slotRegistrations.length === 2,
  JSON.stringify({ injected: injected.map((i) => i.name), registrations: slotNames }),
);
// Exactly one `ctx.effect`, around the tab type — and deliberately not around the
// slot registrations. `ctx.slots.inject(key, cb)` re-runs `cb` per declaration
// lifetime and the slot system removes what it contributes, which is why the
// documented example and both installed third-party plugins use a bare `register`
// there. Wrapping them too would imply the framework does not, and a test that
// demanded it would push future edits away from the documented pattern.
check('exactly one effect, for the tab type', effects.length === 1, JSON.stringify(effects));
check(
  'the effect is labelled with the plugin id',
  typeof effects[0] === 'string' && effects[0].startsWith('dsh-gitnexus-plus'),
  JSON.stringify(effects),
);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

section('view-model helpers');

check('percent handles a zero whole', I.percent(5, 0) === 0);
check('percent is exact', I.percent(25, 200) === 12.5);
check('formatBytes scales', I.formatBytes(2048) === '2.0 KB' && I.formatBytes(5 * 1024 * 1024) === '5.0 MB');
check('formatBytes rejects non-finite input', I.formatBytes(Number.NaN) === '—');

const segments = I.stackSegments(
  [
    { key: 'a', label: 'A', color: '#111111', bytes: 1 },
    { key: 'b', label: 'B', color: '#222222', bytes: 1 },
    { key: 'c', label: 'C', color: '#333333', bytes: 1 },
  ],
  3,
);
check(
  'stack segments sum to exactly 100 despite rounding',
  Math.abs(segments.reduce((acc, s) => acc + s.percent, 0) - 100) < 1e-9,
  JSON.stringify(segments.map((s) => s.percent)),
);
check('stackSegments([]) is empty', I.stackSegments([], 0).length === 0);

const split = I.splitWarnings([
  { level: 'warn', code: 'w', message: 'W' },
  { level: 'info', code: 'i', message: 'I' },
]);
check('warnings split by level', split.notable.length === 1 && split.context.length === 1);
check('splitWarnings tolerates undefined', I.splitWarnings(undefined).notable.length === 0);

check('coverageRatio is null without totals', I.coverageRatio({}) === null);
check('coverageRatio clamps to 1', I.coverageRatio({ totals: { scanned: 10, indexedInGraph: 99 } }) === 1);

section('enriched view-model helpers');

check('compactNumber keeps small values exact', I.compactNumber(999) === '999');
check('compactNumber keeps one decimal for thousands', I.compactNumber(26788) === '26.8k', I.compactNumber(26788));
check('compactNumber compacts millions', I.compactNumber(2_366_932) === '2.4M');
check('compactNumber rejects non-finite', I.compactNumber(Number.NaN) === '—');

// A+C: the flow count only means something next to its budgets, and the version pair
// only means "problem" when the pair was checked against the supported range.
const budgetedFlows = I.processCoverageLine({
  processes: 315,
  processCoverage: { state: 'budget-limited', note: '流程 315 条——在分支 ≤4、深度 ≤10、入口候选 ≤200 的预算内得到；可能漏报，不代表流程只有这些。' },
});
check('a budget-limited flow count is a warning', budgetedFlows.tone === 'warn' && budgetedFlows.text.includes('可能漏报'));

const unseenFlows = I.processCoverageLine({
  processes: 0,
  processCoverage: { state: 'unseen', note: '0 条流程——入口点存在（候选上限 200），但本次没有流程进入排名；不代表仓库里没有流程。' },
});
check('zero flows with entry candidates is unseen, not empty', unseenFlows.tone === 'warn' && unseenFlows.text.includes('不代表'));

const legacyFlows = I.processCoverageLine({
  processes: 0,
  processCoverage: { state: 'unknown', note: '该索引未记录流程检测预算（旧版分析器）；0 条流程的完整性无法判断。' },
});
check('a manifest without budgets is unknown, not zero', legacyFlows.text.includes('无法判断'));

const completeFlows = I.processCoverageLine({ processes: 42, processCoverage: { state: 'complete', note: '流程 42 条，分析器未记录任何流程预算上限。' } });
check('a complete flow count is muted, not a warning', completeFlows.tone === 'muted' && completeFlows.text.includes('42'));

check('a graph without a verdict yields no line', I.processCoverageLine(null) === null && I.processCoverageLine({}) === null);

const crossing = I.compatibilityLine({
  status: 'mismatch',
  relation: 'cross-line',
  message: '',
  supportedRange: '^1.6.12 || >=1.6.13-rc.0 <2.0.0',
  indexedBy: '1.6.12',
  indexedLine: 'stable',
  installed: '1.6.13-rc.159',
  installedLine: 'candidate',
});
check('cross-line is muted and says 跨线', crossing.tone === 'muted' && crossing.text.includes('跨线'));

const outOfRange = I.compatibilityLine({
  status: 'mismatch',
  relation: 'cli-out-of-range',
  message: '',
  supportedRange: '^1.6.12 || >=1.6.13-rc.0 <2.0.0',
  indexedBy: '1.6.12',
  indexedLine: 'stable',
  installed: '2.0.0',
  installedLine: 'other',
});
check('an out-of-range pair is a warning naming the version', outOfRange.tone === 'warn' && outOfRange.text.includes('2.0.0'));

check('no compatibility data yields no line', I.compatibilityLine(null) === null);

// UI pass: the reader's clock, and a verdict that fits beside the project name.
const localInstant = I.localTimeText('2026-10-16T03:31:31.049Z');
check('timestamps render on the local clock, not raw ISO', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(localInstant) && !localInstant.includes('T'));
check('a clock-only read time has no date', I.localTimeText('2026-10-16T03:31:31.049Z', false).length === 5);
check('an unparseable timestamp survives verbatim', I.localTimeText('not-a-date') === 'not-a-date');
const behindShort = I.stalenessShort({ state: 'behind', gitAvailable: true, aheadBehind: { ahead: 12 }, dirtyCount: 2 });
check(
  'the header verdict is a fragment, not a paragraph',
  behindShort.state === 'warning' && behindShort.text === '落后 12 个提交 · 2 处未提交',
  behindShort.text,
);
check('a fresh index says so in four characters', I.stalenessShort({ state: 'current', gitAvailable: true }).text === '已是最新');

const current = I.stalenessView({ state: 'current', headCommit: 'a'.repeat(40), indexedCommit: 'a'.repeat(40), gitAvailable: true, dirtyCount: 0 });
check('current staleness is a done dot', current.state === 'done' && current.text.includes('已是最新'), JSON.stringify(current));

// Diverged is a SPLIT history: the indexed commit holds work HEAD no longer
// reaches, so `behind` (the indexed-side count) is non-zero. A linear fast-forward
// is `behind: 0`, which is the `behind` case below — the two fixtures differ in
// exactly the field the classification turns on.
const diverged = I.stalenessView({
  state: 'diverged',
  headCommit: 'b'.repeat(40),
  indexedCommit: 'a'.repeat(40),
  aheadBehind: { behind: 2, ahead: 1 },
  gitAvailable: true,
  dirtyCount: 0,
});
check('diverged staleness warns', diverged.state === 'warning', JSON.stringify(diverged));
check(
  'diverged reports the indexed-side count, not a "behind N" it cannot give',
  diverged.text.includes('已偏离') && diverged.text.includes('索引侧另有 2') && !diverged.text.includes('落后'),
  diverged.text,
);

const behind = I.stalenessView({
  state: 'behind',
  headCommit: 'b'.repeat(40),
  indexedCommit: 'a'.repeat(40),
  // A linear fast-forward: nothing on the indexed side HEAD lacks, N on HEAD's.
  aheadBehind: { behind: 0, ahead: 7 },
  gitAvailable: true,
  dirtyCount: 3,
});
check('behind names the count', behind.text.includes('7') && behind.text.includes('未提交改动'), behind.text);
check('no git means unknown, not a guess', I.stalenessView({ gitAvailable: false }).state === 'idle');
check('no git still says why, when the report carries a reason', (
  I.stalenessView({ gitAvailable: false, reason: 'git rev-parse HEAD → EPERM' }).text.includes('EPERM')
), I.stalenessView({ gitAvailable: false, reason: 'git rev-parse HEAD → EPERM' }).text);
check('a blank reason does not leave empty parentheses behind', (
  I.stalenessView({ gitAvailable: false, reason: '   ' }).text === 'git 不可用，无法判断新鲜度'
), I.stalenessView({ gitAvailable: false, reason: '   ' }).text);

const caps = I.capabilityRows({
  graph: { provider: 'ladybugdb', status: 'available' },
  fts: { provider: 'ladybugdb-fts', status: 'unavailable', skipReason: 'extension-unavailable' },
  vectorSearch: { provider: 'ladybugdb-vector', status: 'unavailable' },
});
check('capabilityRows keeps a fixed order', caps.map((c) => c.key).join(',') === 'graph,fts,vectorSearch');
check('available capability is marked ok', caps[0].ok === true);
// The manifest's machine reason is translated, and the consequence is appended: a
// reader needs to know what stops working, not the flag name that stopped it.
check(
  'unavailable capability carries a readable reason and its consequence',
  caps[1].ok === false &&
    caps[1].note.includes('扩展无法加载') &&
    caps[1].note.includes('仅按名称/路径匹配'),
  JSON.stringify(caps[1]),
);
check('missing capabilities object does not throw', I.capabilityRows(undefined).length === 3);

// "vector index not built" is not "semantic search off": the provider still scans chunks
// exactly, up to a reported ceiling, and that ceiling is the number a reader can act on.
const capsScan = I.capabilityRows({
  vectorSearch: { provider: 'ladybugdb-vector', status: 'unavailable', exactScanLimit: 10000 },
});
check(
  'an unbuilt vector index states the exact-scan ceiling',
  capsScan[2].note.includes('精确扫描') && capsScan[2].note.includes('10.0k'),
  capsScan[2].note,
);
const capsNoScan = I.capabilityRows({
  vectorSearch: { provider: 'ladybugdb-vector', status: 'unavailable' },
});
check(
  'without a ceiling the note does not invent one',
  capsNoScan[2].note.includes('精确扫描') === false,
  capsNoScan[2].note,
);

const quality = I.graphQualitySummary({ counts: { unwrap: 272, map: 163 }, totalSites: 435 });
check('graphQualitySummary sorts by count', quality.names[0].name === 'unwrap', JSON.stringify(quality));
check('graphQualitySummary prefers the reported total', quality.total === 435);
check('graphQualitySummary returns null without counts', I.graphQualitySummary(null) === null);

const actView = I.activityView({
  window: { sinceDays: 90, truncated: true },
  totals: { commits: 300, authors: 45, insertions: 2_366_932, deletions: 1_164_866, verdicts: { indexed: 1567, excluded: 1435, missing: 4 } },
});
check('activityView labels the window in days, not a git expression', actView.window === '近 90 天', actView.window);
check('activityView surfaces truncation', actView.truncated === true);
check(
  'activityView orders the actionable verdict first',
  actView.verdicts[0].key === 'indexed' && actView.verdicts[1].key === 'missing',
  JSON.stringify(actView.verdicts.map((v) => v.key)),
);
check(
  'a non-zero missing count turns the dot to warning',
  actView.verdicts.find((v) => v.key === 'missing').tone === 'warning',
);
check('activityView returns null for no activity', I.activityView(null) === null);

section('git activity: the branch switch lives in the header, the timeline under the row');
const activityFixture = {
  window: { sinceDays: 7, truncated: false },
  totals: { commits: 93, authors: 3, files: 124, indexKnown: true, verdicts: { indexed: 100, excluded: 20, missing: 4 } },
  branches: [{ name: 'main', current: true }, { name: 'feat/gitnexus-1.6.13-rc' }],
  currentBranch: 'main',
  byChanges: [{ path: 'src/index.ts', changes: 7, insertions: 1, deletions: 1, lastChange: '', verdict: 'indexed' }],
  byRecency: [{ path: 'src/index.ts', changes: 7, insertions: 1, deletions: 1, lastChange: '', verdict: 'indexed' }],
  timeline: [],
  timelineTruncated: false,
};
const activityTree = render(I.GitActivitySection, { activity: activityFixture, projectPath: null, selectedFile: null });
check(
  'the card no longer repeats the branch control the header owns',
  !activityTree.text.includes('活动分支') && !activityTree.text.includes('回到当前分支'),
  activityTree.text.slice(0, 160),
);
// The fold is a control, not a sentence: as a ghost button it read as prose on a card of
// prose, and the reader had to hover to find out it opened anything.
const foldButton = activityTree.nodes.find(
  (node) => node.type === 'button' && String(node.props['aria-label'] ?? '').includes('提交时间线'),
);
check(
  'the timeline fold is dressed as a button and reports its state',
  foldButton !== undefined &&
    foldButton.props['aria-expanded'] === false &&
    String(foldButton.props.style?.border ?? '').length > 0 &&
    String(foldButton.props.style?.cursor ?? '') === 'pointer',
  JSON.stringify(foldButton?.props?.style ?? null),
);
const opened = render(I.GitActivitySection, {
  activity: activityFixture,
  projectPath: null,
  selectedFile: 'src/index.ts',
});
const headers = (opened.text.match(/文件时间线/g) ?? []).length;
check('selecting a file from the header renders exactly one timeline block', headers === 1, String(headers));
// The header picker names a file without naming a list, so the block lands under the
// bar next to it. Inline placement belongs to a row click, which is what the baseline
// fixture below exercises (`renderBlock`) — the harness cannot dispatch a click.
check(
  'a header pick renders the timeline at the top, not under a row',
  opened.text.indexOf('文件时间线') < opened.text.indexOf('改动最频繁'),
  opened.text.slice(0, 240),
);
const failedHistory = render(I.FileHistorySection, {
  projectPath: '/tmp/repo',
  filePath: 'src/a.ts',
  history: null,
  busy: false,
  error: 'boom',
  onClose: () => {},
  onRetry: () => {},
});
check('a failed file read can be retried', failedHistory.text.includes('重试'), failedHistory.text.slice(0, 200));

const excludedRow = { path: 'notes.log', changes: 1, insertions: 0, deletions: 0, lastChange: '', verdict: 'excluded' };
check('the index filter hides an excluded row in the normal view', I.listedActivityFiles([excludedRow]).length === 0);
check(
  'a kept row survives the index filter',
  I.listedActivityFiles([{ ...excludedRow, verdict: 'indexed' }]).length === 1,
);
check('an absent list is empty, not an error', I.listedActivityFiles(undefined).length === 0);

section('git activity: the timeline opens under the row that was clicked');
check(
  'a click in the by-changes list hosts the block there',
  I.activityBlockHost({ path: 'a.ts', list: 'byChanges' }, 'a.ts') === 'byChanges',
  String(I.activityBlockHost({ path: 'a.ts', list: 'byChanges' }, 'a.ts')),
);
check(
  'the same path in another list is not the host',
  I.activityBlockHost({ path: 'a.ts', list: 'byChanges' }, 'b.ts') === null,
);
check('a selection the header picker made has no host', I.activityBlockHost(null, 'a.ts') === null);
check(
  'a stale origin does not claim a new selection',
  I.activityBlockHost({ path: 'a.ts', list: 'baseline' }, 'c.ts') === null,
);

const baselineTree = render(I.ActivityBaseline, {
  baseline: {
    ref: 'e3a18715',
    available: true,
    commits: 3,
    files: 1,
    insertions: 2,
    deletions: 1,
    changedFiles: [
      { path: 'src/a.ts', changes: 2, insertions: 2, deletions: 1, lastChange: '', verdict: 'indexed' },
    ],
  },
  onSelect: () => {},
  selectedPath: 'src/a.ts',
  renderBlock: (path) => (path === 'src/a.ts' ? 'BLOCK-HERE' : null),
});
check(
  'the baseline list renders the block under its own row',
  baselineTree.text.includes('BLOCK-HERE'),
  baselineTree.text.slice(0, 200),
);
check('the baseline row marks itself open', baselineTree.text.includes('收起'), baselineTree.text.slice(0, 200));

section('git activity: lanes, commit file lists, and the page that never ends at 8');

// Lane geometry is a pure function over `parents`, so the shapes that actually occur in
// history can be asserted without a repository: a trunk, a merge, many branches at
// once, and the window edge where a commit's child is outside the range.
const laneLinear = I.commitLanes([
  { sha: 'c3', parents: ['c2'] },
  { sha: 'c2', parents: ['c1'] },
  { sha: 'c1', parents: [] },
]);
check(
  'a linear history stays in one lane',
  laneLinear.laneCount === 1 && laneLinear.cells.every((cell) => cell.lane === 0),
  JSON.stringify(laneLinear),
);
check(
  'only a commit that waits for a parent continues downwards',
  laneLinear.cells[0].continuesDown === true && laneLinear.cells[2].continuesDown === false,
  JSON.stringify(laneLinear.cells.map((cell) => cell.continuesDown)),
);

const laneMerge = I.commitLanes([
  { sha: 'm', parents: ['p1', 'p2'] },
  { sha: 'p1', parents: [] },
  { sha: 'p2', parents: [] },
]);
check(
  'a merge opens a second lane and curves into it',
  laneMerge.laneCount === 2 && laneMerge.cells[0].merges.length === 1 && laneMerge.cells[0].merges[0].to === 1,
  JSON.stringify(laneMerge.cells[0]),
);
check(
  'the mainline keeps lane 0 while the side branch is still pending',
  laneMerge.cells[1].lane === 0 && laneMerge.cells[1].passThrough.join(',') === '1' && laneMerge.cells[2].lane === 1,
  JSON.stringify(laneMerge.cells.map((cell) => ({ lane: cell.lane, pass: cell.passThrough }))),
);

const laneWide = I.commitLanes(Array.from({ length: 10 }, (_, index) => ({ sha: `c${index}`, parents: [`p${index}`] })));
check(
  'ten pending branches get ten lanes instead of sharing one',
  laneWide.laneCount === 10 && laneWide.cells[9].lane === 9,
  JSON.stringify({ lanes: laneWide.laneCount, last: laneWide.cells[9].lane }),
);

check(
  'a payload without parents still renders as one lane',
  I.commitLanes([{ sha: 'a' }, { sha: 'b' }]).laneCount === 1,
  JSON.stringify(I.commitLanes([{ sha: 'a' }, { sha: 'b' }])),
);

const orphan = I.commitLanes([{ sha: 'x', parents: ['outside'] }, { sha: 'y' }]);
check(
  'a commit whose child is outside the window starts its own lane',
  orphan.laneCount === 2 && orphan.cells[1].lane === 1,
  JSON.stringify(orphan.cells.map((cell) => cell.lane)),
);

const commitFiles = render(I.CommitFileList, {
  commit: {
    sha: 'deadbeef',
    files: 5,
    filesTruncated: true,
    changed: [
      { path: 'src/a.ts', insertions: 50, deletions: 5 },
      { path: 'src/b.ts', insertions: 0, deletions: 12 },
    ],
  },
  projectPath: null,
  openPath: null,
  diff: null,
  busy: false,
  error: null,
  onOpenPath: () => {},
});
check(
  'a commit lists its own files with both deltas',
  commitFiles.text.includes('src/a.ts') && commitFiles.text.includes('+50') && commitFiles.text.includes('−12'),
  commitFiles.text.slice(0, 240),
);
check(
  'a capped file list says how many there really were',
  commitFiles.text.includes('仅列出前 2 个文件（共 5 个）'),
  commitFiles.text.slice(0, 240),
);
check(
  'without a host route a file row is not offered as clickable',
  commitFiles.text.includes('改动') === false,
  commitFiles.text.slice(0, 240),
);

const commitNoFiles = render(I.CommitFileList, {
  commit: { sha: 'feedface', files: 3, changed: [] },
  projectPath: null,
  openPath: null,
  diff: null,
  busy: false,
  error: null,
  onOpenPath: () => {},
});
check(
  'a commit from an old host explains the missing file list',
  commitNoFiles.text.includes('该提交的文件列表没有随活动数据下发。'),
  commitNoFiles.text,
);

const timelineTree = render(I.ActivityTimeline, {
  timeline: [
    {
      sha: 'aaa1111cccc',
      shortSha: 'aaa1111',
      date: '2026-10-27T10:00:00+08:00',
      author: 'Ada',
      subject: 'merge side branch',
      files: 1,
      insertions: 3,
      deletions: 1,
      verdict: 'indexed',
      parents: ['bbb2222dddd', 'ccc3333'],
      refs: ['main'],
      changed: [],
    },
    {
      sha: 'bbb2222dddd',
      shortSha: 'bbb2222',
      date: '2026-10-26T10:00:00+08:00',
      author: 'Ada',
      subject: 'mainline work',
      files: 1,
      insertions: 1,
      deletions: 0,
      verdict: 'missing',
      parents: [],
      refs: ['origin/main', 'tag: v0.1.9'],
      changed: [],
    },
  ],
  indexKnown: true,
  projectPath: null,
});
check(
  'each timeline row draws its lane gutter',
  timelineTree.tags.filter((tag) => tag === 'svg').length === 2,
  JSON.stringify(timelineTree.tags.filter((tag) => tag === 'svg').length),
);
check(
  'the timeline names every visible commit subject',
  timelineTree.text.includes('merge side branch') && timelineTree.text.includes('mainline work'),
  timelineTree.text.slice(0, 240),
);
check(
  'a commit labels the branches and tags that point at it',
  timelineTree.text.includes('origin/main') && timelineTree.text.includes('tag: v0.1.9'),
  timelineTree.text.slice(0, 320),
);

// A lane graph is only followable through colour: with one grey for every line the reader
// has to trace pixels, which is exactly the complaint the first version earned.
const laneStrokes = timelineTree.nodes
  .filter((node) => node.type === 'line' || node.type === 'path')
  .map((node) => node.props.stroke)
  .filter((stroke) => typeof stroke === 'string');
check(
  'two lanes are drawn in two different colours',
  new Set(laneStrokes).size >= 2,
  JSON.stringify([...new Set(laneStrokes)]),
);
const dots = timelineTree.nodes.filter(
  (node) => node.type === 'circle' && node.props.fill !== 'none',
);
const rings = timelineTree.nodes.filter((node) => node.type === 'circle' && node.props.fill === 'none');
check(
  'the merge commit keeps the trunk colour, and no verdict repaints it',
  dots.length === 2 && dots[0].props.fill === '#4c8dff' && dots[1].props.fill === '#4c8dff',
  JSON.stringify(dots.map((dot) => dot.props.fill)),
);
check(
  'only the commit with missing files wears a verdict ring',
  rings.length === 1 && String(rings[0].props.stroke).includes('state-warning'),
  JSON.stringify(rings.map((ring) => ring.props.stroke ?? null)),
);

// The curve is a contract on numbers, so it is asserted without a renderer. Both control
// points must sit at the midpoint of the run: a fixed inset doubles back on a short move
// and reads as a kink, which is the difference between "merge" and "misplaced dash".
const curve = I.laneCurve(10, 24, 23, 46);
check('a merge curve is a vertical bezier between the two lanes', curve === 'M10 23 C 10 34.5, 24 34.5, 24 46', curve);
const curveBack = I.laneCurve(24, 10, 23, 46);
check(
  'a lane closing back into the trunk curves the other way',
  curveBack === 'M24 23 C 24 34.5, 10 34.5, 10 46',
  curveBack,
);
const curveNumbers = curve.match(/-?\d+(?:\.\d+)?/g).map(Number);
check(
  'both control points sit halfway down the run, not at a fixed inset',
  curveNumbers[3] === 34.5 && curveNumbers[5] === 34.5 && curveNumbers[1] === 23 && curveNumbers[7] === 46,
  JSON.stringify(curveNumbers),
);
// And the row actually uses it, so the tests above cannot drift from the view. The run
// starts at the dot's clearance (4.5 radius + 2 gap) rather than at the centre: a curve
// that starts inside the dot shows a bright seam through it.
const mergePaths = timelineTree.nodes
  .filter((node) => node.type === 'path')
  .map((node) => String(node.props.d ?? ''));
check(
  'the rendered merge uses the shared curve, starting at the dot clearance',
  mergePaths.length === 1 && mergePaths[0] === I.laneCurve(10, 24, 29.5, 46),
  JSON.stringify(mergePaths),
);

// Past six lanes the gutter cannot grow any wider without eating the commit text, so the
// extras are counted rather than drawn. The count has to be per row: a row that only
// crosses two of the clamped lanes should say "+2", not "+3".
const gutterCell = (lane, passThrough, merges = []) => ({
  lane,
  passThrough,
  merges,
  continuesDown: false,
});
const wideGutter = renderTree(
  React.createElement(I.LaneGutter, {
    cell: gutterCell(2, [0, 1, 3, 4, 5, 6, 7, 8]),
    laneCount: 9,
    verdict: 'done',
  }),
);
check(
  'lanes past the width limit are counted at the right edge',
  wideGutter.text.includes('+3'),
  wideGutter.text,
);
check(
  'the count explains itself on hover',
  wideGutter.nodes.some(
    (node) => node.type === 'title' && String(node.props.children).includes('共 9 条分支线'),
  ),
  JSON.stringify(wideGutter.nodes.filter((node) => node.type === 'title').map((node) => node.props.children)),
);
const narrowGutter = renderTree(
  React.createElement(I.LaneGutter, { cell: gutterCell(0, [1]), laneCount: 2, verdict: 'done' }),
);
check(
  'a graph that fits says nothing about hidden lanes',
  !narrowGutter.text.includes('+'),
  narrowGutter.text,
);

// Hover emphasis: the row's own lane thickens and everything it crosses fades, so the
// line you are on is the only one at full weight.
const hoveredGutter = renderTree(
  React.createElement(I.LaneGutter, {
    cell: gutterCell(1, [0, 2]),
    laneCount: 3,
    verdict: 'done',
    emphasised: true,
  }),
);
const calmGutter = narrowGutter;
const ownStrokes = (tree) =>
  tree.nodes
    .filter((node) => node.type === 'line' && Number(node.props.strokeWidth) > 0)
    .map((node) => Number(node.props.strokeWidth));
check(
  'hovering a row thickens its lane and thins the lanes it crosses',
  ownStrokes(hoveredGutter).includes(2.8) &&
    ownStrokes(calmGutter).every((width) => width <= 2) &&
    hoveredGutter.nodes.some((node) => node.type === 'line' && node.props.opacity === 0.3),
  JSON.stringify({ hovered: ownStrokes(hoveredGutter), calm: ownStrokes(calmGutter) }),
);
check(
  'hovering also grows the dot, so the row reads as selected',
  hoveredGutter.nodes.some((node) => node.type === 'circle' && Number(node.props.r) === 5.2) &&
    calmGutter.nodes.some((node) => node.type === 'circle' && Number(node.props.r) === 4.5),
  JSON.stringify(hoveredGutter.nodes.filter((node) => node.type === 'circle').map((node) => node.props.r)),
);

// The branch chips are tinted with their own lane's colour: a neutral chip on a coloured
// graph is a legend the reader has to build in their head.
const chip = timelineTree.nodes.find(
  (node) => node.type === 'span' && String(node.props.title ?? '') === 'origin/main',
);
check(
  'a branch chip is drawn in its lane colour',
  chip !== undefined &&
    String(chip.props.style?.border ?? '').includes('#4c8dff') &&
    String(chip.props.style?.background ?? '').includes('#4c8dff'),
  JSON.stringify(chip?.props?.style ?? null),
);

section('route URL resolution');
// In Node there is no `document`, so each case is exercised with an explicit fake
// page base — which is also the only way to test the reverse-proxy and desktop-
// shell bases that the resolution exists to handle.
const withBase = (baseURI, fn) => {
  const had = 'document' in globalThis;
  const previous = globalThis.document;
  globalThis.document = { baseURI };
  try {
    return fn();
  } finally {
    if (had) globalThis.document = previous;
    else delete globalThis.document;
  }
};

const plain = withBase('http://127.0.0.1:43120/', () => I.routeUrl('/api/gitnexus/repos'));
check(
  'resolves against a plain origin',
  plain === 'http://127.0.0.1:43120/api/gitnexus/repos',
  plain,
);

const proxied = withBase('https://host.example/dsh/proxy/43120/', () => I.routeUrl('/api/gitnexus/repos'));
check(
  'stays inside a reverse-proxy directory prefix',
  proxied === 'https://host.example/dsh/proxy/43120/api/gitnexus/repos',
  proxied,
);
check('leading slash does not escape the prefix', !proxied.includes('host.example/api'), proxied);

const shell = withBase('dsh-app://app/', () => I.routeUrl('/api/gitnexus/repos'));
check(
  'desktop shell base keeps its own scheme and host',
  shell.startsWith('dsh-app://app/') && shell.endsWith('/api/gitnexus/repos'),
  shell,
);

const bare = (() => {
  const had = 'document' in globalThis;
  const previous = globalThis.document;
  delete globalThis.document;
  try {
    return I.routeUrl('/api/gitnexus/repos');
  } finally {
    if (had) globalThis.document = previous;
  }
})();
check('without a document it still yields an absolute URL', /^https?:\/\/[^/]+\/api\/gitnexus\/repos$/.test(bare), bare);

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const maintenance = {
  commands: [
    {
      mode: 'init',
      label: '初始化索引',
      when: '该项目还没有 .gitnexus 索引时使用。',
      argv: "gitnexus analyze --index-only 'D:\\demo'",
      shell: "$env:GITNEXUS_MEMORY='off'; gitnexus analyze --index-only 'D:\\demo'",
      destructive: false,
      caveat: null,
    },
    {
      mode: 'full',
      label: '强制全量重构',
      when: '增量刷新卡死时的逃生舱。',
      argv: "gitnexus analyze --index-only --force 'D:\\demo'",
      shell: "$env:GITNEXUS_MEMORY='off'; gitnexus analyze --index-only --force 'D:\\demo'",
      destructive: true,
      caveat: '--force 重建图与 FTS。',
    },
  ],
  rationale: ['GITNEXUS_MEMORY=off：阻止 CLI 重启自身。', '--index-only：不会改动 AGENTS.md。'],
  // The host that predates `force=1` omits this; the button must then be disabled.
  supportsForce: true,
};
const search = {
  query: 'analyze',
  onQueryChange: () => {},
  onSubmit: () => {},
  onClear: () => {},
  searching: false,
  error: null,
  mode: 'graph',
  results: [
    {
      kind: 'Function',
      name: 'analyzeCoverage',
      filePath: 'src/gitnexus/coverage.ts',
      startLine: 507,
      endLine: 862,
    },
  ],
  total: 1,
  truncated: false,
  contentSearch: false,
  warning: null,
  copied: null,
  onOpen: () => {},
  onCopy: () => {},
};
const viewProps = { maintenance, search, projectPath: 'D:\\demo', busy: false, error: null, onRefresh: () => {} };

section('project resolution');

// Forward slashes throughout: the point under test is which source wins, and a
// Windows path here only adds escaping noise to the assertions.
const sessionProps = {
  sessionId: 'sess-1',
  useSessions: (sel) => sel({ byId: { 'sess-1': { cwd: '/proj/from-session' } } }),
  useWorkspaces: (sel) => sel({ workspaces: [{ sessionIds: ['sess-1'], cwd: '/proj/from-workspace' }] }),
};
check('session cwd wins over workspace cwd', I.useProjectPath(sessionProps) === '/proj/from-session', String(I.useProjectPath(sessionProps)));

const wsOnly = {
  sessionId: 'sess-2',
  useSessions: (sel) => sel({ byId: {} }),
  useWorkspaces: (sel) => sel({ workspaces: [{ sessionIds: ['sess-2'], cwd: '/proj/ws' }] }),
};
check('falls back to the workspace list', I.useProjectPath(wsOnly) === '/proj/ws', String(I.useProjectPath(wsOnly)));

check(
  'an explicit params.repo wins over both',
  I.useProjectPath({ ...sessionProps, params: { repo: '/proj/explicit' } }) === '/proj/explicit',
);

check('no context yields null rather than a guess', I.useProjectPath({}) === null);
check(
  'a host with neither hook does not throw',
  I.useProjectPath({ sessionId: 'x' }) === null,
);

const diag = I.contextDiagnostic({ sessionId: 'a', useSessions: () => null });
check('diagnostic lists what is present', diag.present.includes('sessionId') && diag.present.includes('useSessions'), JSON.stringify(diag));
check('diagnostic lists what is missing', diag.absent.includes('useWorkspaces') && !diag.absent.includes('sessionId'), JSON.stringify(diag));

section('maintenance: the run card');

// The card, not the panel: the panel's job is polling, and polling is a host behaviour.
// What the anchoring phase changed lives here — whether the buttons stay disabled while
// the baseline is being written, and whether the host's sentence is shown verbatim.
const runProps = {
  maintenance,
  projectPath: 'D:\\demo',
  indexed: true,
  runError: null,
  onStartRun: () => undefined,
  onCancelRun: () => undefined,
};
const anchorSentence =
  '已把提交 678c6e6 写入索引基线 —— 刷新门禁现在可以回答"已是最新"，不必再去终端跑一次 analyze。';
const anchoringView = render(I.MaintenanceSection, {
  ...runProps,
  run: {
    state: 'done',
    command: 'node .gitnexus/run.cjs analyze --repo .',
    startedAt: Date.now() - 12_000,
    finishedAt: Date.now(),
    exitCode: 0,
    message: anchorSentence,
    output: '',
    anchoring: true,
  },
});
check(
  'the anchoring phase names itself instead of showing a stopwatch',
  anchoringView.text.includes('正在记录提交基线…'),
  anchoringView.text.slice(0, 160),
);
check(
  'the sentence the host wrote for the anchor is shown verbatim',
  anchoringView.text.includes(anchorSentence),
  anchoringView.text.slice(0, 240),
);
check(
  'the run buttons stay disabled while the baseline is written',
  anchoringView.text.includes('运行中'),
  anchoringView.text.slice(0, 240),
);
check(
  'nothing is offered to cancel during the anchoring phase',
  !anchoringView.text.includes('取消'),
  anchoringView.text.slice(0, 240),
);

const liveView = render(I.MaintenanceSection, {
  ...runProps,
  run: {
    state: 'running',
    command: 'node .gitnexus/run.cjs analyze --repo .',
    startedAt: Date.now() - 5_000,
    finishedAt: null,
    exitCode: null,
    message: null,
    output: '',
  },
});
check(
  'a live run keeps the stopwatch',
  /已运行 \d+s/.test(liveView.text),
  liveView.text.slice(0, 200),
);
check(
  'a live run can still be cancelled',
  liveView.text.includes('取消'),
  liveView.text.slice(0, 240),
);

const renderOut = renderSuite({
  I,
  viewProps,
  search,
  maintenance,
  split,
  current,
  diverged,
  behind,
  quality,
  caps,
  plain,
  bare,
  shell,
  withHookFrame,
  check,
  section,
  render,
  readFileSync,
  path,
  root,
});

graphSuite({
  I,
  report: renderOut.report,
  viewProps,
  project: renderOut.project,
  maintenance,
  search,
  check,
  section,
  render,
  withHookFrame,
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
