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
 * @param {any} node
 * @returns {{text: string, tags: string[]}}
 */
function renderTree(node) {
  const text = [];
  const tags = [];

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
    walk(current.props?.children);
  };

  walk(node);
  return { text: text.join(' '), tags };
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

const current = I.stalenessView({ state: 'current', headCommit: 'a'.repeat(40), indexedCommit: 'a'.repeat(40), gitAvailable: true, dirtyCount: 0 });
check('current staleness is a done dot', current.state === 'done' && current.text.includes('current'), JSON.stringify(current));

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
  diverged.text.includes('diverged') && diverged.text.includes('索引侧另有 2') && !diverged.text.includes('落后'),
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
