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

const caps = I.capabilityRows({
  graph: { provider: 'ladybugdb', status: 'available' },
  fts: { provider: 'ladybugdb-fts', status: 'unavailable', skipReason: 'extension-unavailable' },
  vectorSearch: { provider: 'ladybugdb-vector', status: 'unavailable' },
});
check('capabilityRows keeps a fixed order', caps.map((c) => c.key).join(',') === 'graph,fts,vectorSearch');
check('available capability is marked ok', caps[0].ok === true);
check('unavailable capability carries its reason', caps[1].ok === false && caps[1].note === 'extension-unavailable', JSON.stringify(caps[1]));
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
check('diagnostic lists what is missing', diag.absent.includes('useWorkspaces'), JSON.stringify(diag));

section('render: populated report');

const report = {
  repo: {
    path: 'D:\\demo',
    name: 'demo',
    indexed: true,
    metaFile: 'gitnexus.json',
    indexedAt: '2026-10-16T03:31:31.049Z',
    lastCommit: 'b51f2560deadbeef',
    branch: 'main',
  },
  analyzer: { gitnexusVersion: '1.6.12', primitives: 'gitnexus' },
  cap: { bytes: 524288, text: '512.0 KB', source: 'index', defaultText: '512.0 KB', maxText: '32.0 MB' },
  totals: { scanned: 120, selected: 118, large: 2, suppressedDeclarations: 0, indexedInGraph: 118, largeBytes: 3145728, scannedBytes: 4194304 },
  largeFiles: [
    {
      path: 'dist/app.min.js',
      size: 2097152,
      sizeText: '2.0 MB',
      language: { key: 'javascript', label: 'JavaScript', color: '#f1e05a', klass: 'parsed' },
      minified: { suspect: true, avgLineLength: 120000, estimatedLines: 18 },
      generatedHint: true,
      shareOfLanguage: 0.62,
    },
    {
      path: 'CHANGELOG.old.md',
      size: 1048576,
      sizeText: '1.0 MB',
      language: { key: 'markdown', label: 'Markdown', color: '#8b949e', klass: 'recognized' },
      minified: { suspect: false, avgLineLength: 44, estimatedLines: 23000 },
      generatedHint: false,
      shareOfLanguage: 0.35,
    },
  ],
  attribution: { oversizeCount: 2, oversizeBytes: 3145728, oversizeShareOfScanned: 0.75 },
  index: { uncoveredCount: 0, uncoveredSample: [], staleCount: 0, staleSample: [], dirtyPaths: [] },
  warnings: [
    { level: 'warn', code: 'large-files-skipped', message: '2 个文件超过上限被跳过', evidence: {} },
    { level: 'warn', code: 'minified-dominates-language', message: 'dist/app.min.js 疑似压缩产物', evidence: {} },
    { level: 'info', code: 'cap-not-recorded', message: '未记录上限', evidence: {} },
  ],
  languages: {
    rows: [
      { key: 'typescript', label: 'TypeScript', color: '#3178c6', klass: 'parsed', files: 90, bytes: 1000000 },
      { key: 'javascript', label: 'JavaScript', color: '#f1e05a', klass: 'parsed', files: 10, bytes: 500000 },
      { key: 'markdown', label: 'Markdown', color: '#8b949e', klass: 'recognized', files: 20, bytes: 100000 },
    ],
    totalFiles: 120,
    totalBytes: 1600000,
    largeExcluded: [],
  },
  graph: { files: 120, nodes: 26788, edges: 46713, communities: 512, processes: 248, embeddings: 0, edgesPerNode: 1.7438 },
  capabilities: {
    graph: { provider: 'ladybugdb', status: 'available' },
    fts: { provider: 'ladybugdb-fts', status: 'unavailable', skipReason: 'extension-unavailable' },
    vectorSearch: { provider: 'ladybugdb-vector', status: 'unavailable' },
  },
  staleness: {
    state: 'diverged',
    indexedCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    branch: 'main',
    dirtyCount: 0,
    aheadBehind: { behind: 2, ahead: 1 },
    gitAvailable: true,
  },
  provenance: {
    schemaFingerprint: '60fc01e4e4ed',
    contentRetention: 'full',
    ftsProfile: 'full',
    analysisFeatures: { 'graph.class-framework-annotations': 1 },
    crossLanguageProperties: 25,
    runnerCliVersion: '1.6.12',
  },
  graphQuality: { counts: { unwrap: 272, map: 163 }, totalSites: 435 },
  activity: {
    window: { sinceDays: 90, truncated: true },
    totals: { commits: 300, authors: 12, bots: 1, insertions: 12345, deletions: 6789, verdicts: { indexed: 91, excluded: 60, missing: 2 } },
    authors: [
      { name: 'Ada', email: 'ada@example.com', commits: 100, insertions: 9000, deletions: 4000, files: 80, lastCommit: '2026-10-16T00:00:00Z', bot: false },
      { name: 'dependabot[bot]', email: 'bot@github.com', commits: 80, insertions: 300, deletions: 200, files: 12, lastCommit: '2026-10-15T00:00:00Z', bot: true },
    ],
    byChanges: [
      { path: 'src/hot.ts', changes: 54, insertions: 900, deletions: 100, lastChange: '2026-10-16T00:00:00Z', indexed: true, verdict: 'indexed' },
      { path: 'src/lock.json', changes: 30, insertions: 10, deletions: 10, lastChange: '2026-10-15T00:00:00Z', indexed: false, verdict: 'excluded' },
      { path: 'src/fresh.ts', changes: 12, insertions: 50, deletions: 5, lastChange: '2026-10-16T01:00:00Z', indexed: false, verdict: 'missing' },
    ],
    byRecency: [
      { path: 'src/fresh.ts', changes: 12, insertions: 50, deletions: 5, lastChange: '2026-10-16T01:00:00Z', indexed: false, verdict: 'missing' },
    ],
    branches: [
      { name: 'main', lastCommitDate: '2026-10-16T00:00:00Z', lastAuthor: 'Ada', current: true },
      { name: 'feature/x', lastCommitDate: '2026-10-10T00:00:00Z', lastAuthor: 'Bob', current: false },
    ],
    currentBranch: 'main',
    histogram: {
      bucketDays: 7,
      buckets: [
        { label: '2026-09-25', commits: 12, insertions: 400, deletions: 90 },
        { label: '2026-10-02', commits: 0, insertions: 0, deletions: 0 },
        { label: '2026-10-09', commits: 31, insertions: 900, deletions: 120 },
      ],
    },
    cross: {
      rows: [
        { verdict: 'indexed', files: 91, changes: 210, insertions: 9000, deletions: 4000 },
        { verdict: 'excluded', files: 60, changes: 80, insertions: 300, deletions: 200 },
        { verdict: 'missing', files: 2, changes: 40, insertions: 120, deletions: 20 },
      ],
      totalFiles: 153,
      totalChanges: 330,
    },
    baseline: {
      ref: 'abc12345def67890',
      available: true,
      shortSha: 'abc12345',
      date: '2026-10-01T00:00:00Z',
      subject: 'baseline',
      author: 'Ada',
      commits: 4,
      files: 3,
      insertions: 120,
      deletions: 30,
      changedFiles: [
        { path: 'src/fresh.ts', changes: 1, insertions: 50, deletions: 5, lastChange: '2026-10-01T00:00:00Z', indexed: false, verdict: 'missing' },
      ],
    },
    timeline: [
      {
        sha: 'deadbeefcafebabe',
        shortSha: 'deadbeef',
        date: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        author: 'Ada',
        subject: 'Add fresh module',
        files: 2,
        insertions: 50,
        deletions: 5,
        verdict: 'missing',
      },
    ],
  },
};

const repos = [
  { path: 'D:\\demo', name: 'demo' },
  { path: 'D:\\other', name: 'other' },
];

const view = render(I.CoverageView, { report, ...viewProps });

check('a settled report shows no progress bar', !view.tags.includes('progress'));

const loadingView = render(I.CoverageView, {
  report: null,
  ...viewProps,
  busy: true,
  error: null,
});
check(
  'the first read shows an indeterminate progress bar',
  loadingView.tags.includes('progress') && loadingView.text.includes('正在读取索引'),
  loadingView.text.slice(0, 300),
);

const numericLoadingView = render(I.CoverageView, {
  report: null,
  ...viewProps,
  busy: true,
  progress: { percent: 42, label: '扫描文件 12/30' },
});
check(
  'host progress is rendered as a number and a phase',
  numericLoadingView.text.includes('42%') && numericLoadingView.text.includes('扫描文件 12/30'),
  numericLoadingView.text.slice(0, 300),
);

const refreshingView = render(I.CoverageView, {
  report,
  ...viewProps,
  busy: true,
  error: null,
});
check(
  'a manual refresh shows progress above the existing report',
  refreshingView.tags.includes('progress') && refreshingView.text.includes('正在刷新索引'),
  refreshingView.text.slice(0, 300),
);

check('renders without throwing', view.text.length > 0);
// A `<select>` is now the timeline range control, not a project picker. Assert the
// resolved path and that the unresolved-workspace state is absent.
check(
  'shows the project path instead of an unresolved workspace',
  view.text.includes('D:\\demo') && !view.text.includes('未解析到工作区'),
);
check('shows the maintenance commands', view.text.includes('维护命令') && view.text.includes('强制全量重构'));
// On an indexed project the incremental command is the normal action and must not
// read as "initialize"; the full rebuild is an escape hatch, never the applicable one.
check('an indexed project shows 增量刷新, not 初始化索引', view.text.includes('增量刷新') && !view.text.includes('初始化索引'));
check('marks the incremental command as applicable', view.text.includes('当前适用'));
check('both commands remain visible', view.text.includes('增量刷新') && view.text.includes('强制全量重构'));
check('offers an executable full rebuild', view.text.includes('全量重建'));
check('shows the totals line', view.text.includes('扫描 120'));
check('shows the skipped-file count', view.text.includes('被跳过的超大文件'));
check('lists each skipped file', view.text.includes('dist/app.min.js') && view.text.includes('CHANGELOG.old.md'));
check('flags the minified file', view.text.includes('单行'));
// The cap now renders as a value plus a separate source hint in the metric grid,
// rather than the two concatenated into one string.
check(
  'shows the size cap and where it came from, in the panel language',
  view.text.includes('512.0 KB') && view.text.includes('索引记录'),
  view.text.slice(0, 400),
);
check('renders the keyword search card', view.text.includes('关键词搜索') && view.text.includes('搜索'));
check('renders a search input', view.tags.includes('input'));
const address = I.fileResourceAddress('sess-1', 'src/a b.ts');
check(
  'builds the platform file address with line-compatible encoding',
  address === 'dsh-resource://file/session/sess-1/src/a%20b.ts',
  address,
);
check(
  'normalizes Windows separators in the file address',
  I.fileResourceAddress('sess-1', 'src\\client\\index.ts') ===
    'dsh-resource://file/session/sess-1/src/client/index.ts',
);
check('the result row offers an open action, not only copy', view.text.includes('点击结果打开文件'));
check(
  'renders a search hit with its kind, name and path',
  view.text.includes('analyzeCoverage') && view.text.includes('src/gitnexus/coverage.ts'),
  view.text.slice(0, 500),
);
check('names the search scope, not a full-text claim', view.text.includes('按符号名与文件路径'));
check('renders the language legend', view.text.includes('TypeScript') && view.text.includes('JavaScript'));
check('renders the notable warning text', view.text.includes('2 个文件超过上限被跳过'));
check('renders the context warning separately', view.text.includes('未记录上限'));
check('language percentages appear', /TypeScript\s+62\.5%/.test(view.text), view.text.slice(0, 200));

section('render: chart surfaces');
check(
  'renders the coverage ring with its value and caption',
  view.text.includes('98.3%') && view.text.includes('覆盖'),
  view.text.slice(0, 200),
);
check('the ring is an svg with an accessible label', view.tags.includes('svg'));
check('renders a metric grid of the graph composition', view.text.includes('符号') && view.text.includes('社区'));
check('offers the language metric switch', view.text.includes('按字节') && view.text.includes('按文件'));
check('names the active language metric in the footnote', view.text.includes('按字节计的占比'));
check('renders the commit histogram', view.text.includes('每') && /峰值/.test(view.text), view.text.slice(-500));
// The panel is a card grid, not a vertical stack: at a wide pane a single column of
// full-width cards stretches every row across a metre of empty space.
check(
  'every section renders as a card element',
  // Exactly the eight cards: 关键词搜索, 索引概览, 语言分布, 需要注意,
  // 解析质量与溯源, 被跳过的超大文件, Git 活动, 维护命令. Pinned rather than a
  // floor, because the failure this guards against is a section quietly losing its
  // card wrapper — which shows up as a lower count, not a higher one.
  view.tags.filter((t) => t === 'section').length === 8,
  'sections=' + view.tags.filter((t) => t === 'section').length,
);
check(
  'the two caveat cards are adjacent (they share a grid row)',
  // `需要注意` and `解析质量与溯源` must be consecutive in the render order, or the
  // grid puts them in different rows and the pairing is lost. Their text positions
  // are the only ordering evidence available from a rendered tree.
  view.text.indexOf('需要注意') < view.text.indexOf('解析质量与溯源') &&
    view.text.indexOf('解析质量与溯源') < view.text.indexOf('被跳过的超大文件'),
  view.text.slice(0, 400),
);
check(
  'warnings and context warnings share one card',
  // One card, two volumes: amber boxes for the loud ones, quiet rows for the rest.
  view.text.includes('需要注意 · 3') && view.text.includes('未记录上限'),
  view.text.slice(0, 400),
);
check(
  'every section is expanded — nothing is hidden behind a click',
  // Three sections used to be folded away behind a disclosure row. Inside a card
  // the click bought nothing, so every section now renders its body unconditionally.
  view.text.includes('增量刷新') && view.text.includes('未解析接收者') && view.text.includes('已索引'),
  view.text.slice(0, 300),
);
check(
  'the summary line is not rendered twice',
  (view.text.match(/扫描 120/g) ?? []).length === 1,
  String((view.text.match(/扫描 120/g) ?? []).length),
);

section('render: git and graph enrichment');
// File coverage and graph contents are one card now, split by the 文件 / 图谱
// group labels rather than by a card border.
check(
  'the overview card carries both file and graph metrics',
  view.text.includes('文件') && view.text.includes('图谱') && view.text.includes('26.8k'),
  view.text.slice(0, 300),
);
check('the merged card keeps the capability list', view.text.includes('查询能力') && view.text.includes('ladybugdb'));
check('renders edge-per-node ratio', view.text.includes('1.74'));
check('renders capability labels', view.text.includes('查询能力') && view.text.includes('关键词搜索'));
check('renders an unavailable capability reason', view.text.includes('extension-unavailable'));
check('renders staleness as diverged', view.text.includes('diverged'), view.text.slice(0, 400));
check(
  'staleness does not fake a "behind N" for a diverged head',
  // Scoped to a count: the maintenance copy legitimately says "索引落后或…" without
  // claiming how far, and a bare substring check confused that with a stale index.
  !/落后\s*\d+/.test(view.text),
  view.text.slice(0, 400),
);
check('renders the git activity section title', view.text.includes('Git 活动'), view.text.slice(0, 400));
check('renders the git activity window in days', view.text.includes('近 90 天'));
check(
  'renders the activity × index cross-tab',
  view.text.includes('活动 × 索引交叉对比') && view.text.includes('330 次变更'),
  view.text.slice(-800),
);
check(
  'renders the index baseline review',
  view.text.includes('索引基线审查') && view.text.includes('abc12345') && view.text.includes('4 个提交'),
  view.text.slice(-800),
);
check(
  'renders the commit timeline',
  view.text.includes('提交时间线') &&
    view.text.includes('deadbeef') &&
    view.text.includes('Add fresh module'),
  view.text.slice(-800),
);
check(
  'offers 7/14/30-day project timeline ranges',
  view.text.includes('7 天') && view.text.includes('14 天') && view.text.includes('30 天'),
  view.text.slice(-500),
);

const fileTimeline = render(I.FileHistorySection, {
  filePath: 'src/fresh.ts',
  history: {
    path: 'src/fresh.ts',
    available: true,
    days: 7,
    commits: 1,
    insertions: 50,
    deletions: 5,
    timeline: [
      {
        sha: 'deadbeefcafebabe',
        shortSha: 'deadbeef',
        date: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        author: 'Ada',
        subject: 'Add fresh module',
        insertions: 50,
        deletions: 5,
      },
    ],
  },
  busy: false,
  error: null,
  onClose: () => {},
});
check(
  'renders a selected file timeline',
  fileTimeline.text.includes('文件时间线') &&
    fileTimeline.text.includes('src/fresh.ts') &&
    fileTimeline.text.includes('deadbeef') &&
    fileTimeline.text.includes('Add fresh module') &&
    fileTimeline.text.includes('近 7 天 · 1 提交'),
  fileTimeline.text.slice(0, 500),
);
check('renders the three-way verdict labels', view.text.includes('已索引') && view.text.includes('索引缺失') && view.text.includes('有意排除'));
check('renders a missing-file tag', view.text.includes('缺失'));
check('renders the author list', view.text.includes('Ada') && view.text.includes('dependabot[bot]'));
check('marks a bot author', view.text.includes('bot'));
check('renders branches with the current marker', view.text.includes('feature/x') && view.text.includes('当前'));
check('renders the provenance block', view.text.includes('解析质量与溯源'));
check('provenance surfaces the untyped receiver total', view.text.includes('435'), view.text.slice(-400));

section('render: edge states');

const empty = render(I.CoverageView, { report: { ...report, largeFiles: [], warnings: [], totals: { ...report.totals, large: 0, largeBytes: 0 } }, ...viewProps });
check('a clean report renders without a skipped-file section', !empty.text.includes('被跳过的超大文件'));
check('a clean report still renders languages', empty.text.includes('语言分布'));

const noIndex = render(I.CoverageView, {
  report: {
    repo: { indexed: false, path: 'D:\\demo' },
    totals: { scanned: 10, selected: 9, indexedInGraph: 0, large: 0, largeBytes: 0, suppressedDeclarations: 0, scannedBytes: 2048 },
    cap: { text: '512.0 KB', source: 'default' },
    languages: {
      rows: [{ key: 'typescript', label: 'TypeScript', color: '#3178c6', klass: 'recognized', files: 9, bytes: 2048 }],
      totalFiles: 9,
      totalBytes: 2048,
      detector: 'builtin',
    },
    toolchain: { verdict: 'ready' },
  },
  ...viewProps,
});
check('an unindexed project leads with the initialize command', noIndex.text.includes('还没有 GitNexus 索引') && noIndex.text.includes('初始化索引'));
check('an unindexed project still shows a scan overview', noIndex.text.includes('扫描概览') && noIndex.text.includes('扫描文件'));
check(
  'an unindexed project shows the fallback language split',
  noIndex.text.includes('语言分布') && noIndex.text.includes('TypeScript') && noIndex.text.includes('内置扩展名映射'),
  noIndex.text.slice(0, 400),
);
check('still marks an applicable command when unindexed', noIndex.text.includes('当前适用'));

const errored = render(I.CoverageView, { report: null, ...viewProps, error: '工作区未解析' });
check('error state surfaces the message', errored.text.includes('工作区未解析'));

const partial = render(I.CoverageView, { report: { ...report, languages: null }, ...viewProps });
check('missing language data degrades without crashing', partial.text.includes('被跳过的超大文件'));

const searchEmpty = render(I.CoverageView, {
  report,
  ...viewProps,
  search: { ...search, results: [], total: 0 },
});
check('an empty search result says so', searchEmpty.text.includes('没有匹配'), searchEmpty.text.slice(0, 400));

const searchFailed = render(I.CoverageView, {
  report,
  ...viewProps,
  search: { ...search, results: null, error: '图查询失败' },
});
check('a search error is surfaced', searchFailed.text.includes('图查询失败'), searchFailed.text.slice(0, 400));

const textFallback = render(I.CoverageView, {
  report,
  ...viewProps,
  search: {
    ...search,
    mode: 'text',
    results: [
      { kind: 'Text', name: 'const x = analyzeCoverage(y);', filePath: 'src/gitnexus/coverage.ts', startLine: 507, endLine: 507 },
    ],
    warning: '图查询不可用；已回退到索引文件的源码关键词搜索。结果来自文本，不是图谱。',
  },
});
check(
  'a text fallback labels itself and names its scope',
  textFallback.text.includes('源码关键词（回退）') &&
    textFallback.text.includes('处源码匹配') &&
    textFallback.text.includes('结果来自文本'),
  textFallback.text.slice(0, 500),
);

const oldHost = render(I.CoverageView, {
  report,
  ...viewProps,
  maintenance: { ...maintenance, supportsForce: false },
});
check(
  'an older host does not offer an enabled full rebuild',
  oldHost.text.includes('全量重建（需重启）'),
  oldHost.text.slice(-500),
);
check(
  'an older host asks for a restart before maintenance',
  oldHost.text.includes('执行增量刷新（需重启）') && oldHost.text.includes('当前宿主是旧版本'),
  oldHost.text.slice(-500),
);

// ---------------------------------------------------------------------------
// Tier 0 gate and the FTS repair control
// ---------------------------------------------------------------------------

section('maintenance: the refresh is gated by the delta verdict');

/** @param {Record<string, unknown>} patch */
const withDelta = (patch) => ({
  indexed: true,
  comparable: true,
  basis: 'index',
  indexedCommit: 'a'.repeat(40),
  headCommit: 'b'.repeat(40),
  entries: [],
  counts: { checked: 0, hashed: 0, unchanged: 0, modified: 0, added: 0, deleted: 0, excluded: 0 },
  needsRefresh: false,
  truncated: false,
  notes: ['工作区与索引记录一致：没有任何文件相对索引提交发生改动'],
  durationMs: 12,
  readAt: new Date().toISOString(),
  ...patch,
});

const cleanGate = render(I.CoverageView, { report, ...viewProps, delta: withDelta({}) });
check(
  'a clean tree disables the normal refresh and says why',
  cleanGate.text.includes('无需刷新') && cleanGate.text.includes('索引已是最新'),
  cleanGate.text.slice(-600),
);
check(
  'a clean tree keeps an escape hatch instead of removing the decision',
  cleanGate.text.includes('仍然刷新'),
  cleanGate.text.slice(-600),
);

const dirtyGate = render(I.CoverageView, {
  report,
  ...viewProps,
  delta: withDelta({
    needsRefresh: true,
    counts: { checked: 3, hashed: 2, unchanged: 1, modified: 1, added: 1, deleted: 1, excluded: 0 },
    entries: [
      { path: 'src/a.ts', kind: 'modified', reason: null },
      { path: 'src/c.ts', kind: 'added', reason: null },
      { path: 'src/b.ts', kind: 'deleted', reason: null },
    ],
    notes: ['索引内容已落后：1 个修改、1 个新增、1 个删除'],
  }),
});
check(
  'a dirty tree explains what changed before asking',
  dirtyGate.text.includes('索引内容已落后') && dirtyGate.text.includes('1 改 / 1 增 / 1 删'),
  dirtyGate.text.slice(-800),
);
check(
  'the changed paths are listed with their kind',
  dirtyGate.text.includes('M src/a.ts') &&
    dirtyGate.text.includes('A src/c.ts') &&
    dirtyGate.text.includes('D src/b.ts'),
  dirtyGate.text.slice(-800),
);

const excludedGate = render(I.CoverageView, {
  report,
  ...viewProps,
  delta: withDelta({
    needsRefresh: false,
    counts: { checked: 1, hashed: 0, unchanged: 0, modified: 0, added: 0, deleted: 0, excluded: 1 },
    entries: [{ path: 'assets/big.bin', kind: 'excluded', reason: '超过索引记录的大小上限（512 KB）' }],
    notes: ['工作区与索引记录一致：1 个候选文件中 0 个内容哈希匹配，1 个属索引策略排除'],
  }),
});
check(
  'an excluded-only change says it is not a reason to refresh',
  excludedGate.text.includes('刷新也不会收录'),
  excludedGate.text.slice(-600),
);

// A legacy index (or a host without the route) has no verdict. The control must keep
// working rather than block a refresh it cannot justify.
const unknownGate = render(I.CoverageView, {
  report,
  ...viewProps,
  delta: withDelta({
    comparable: false,
    notes: ['该索引没有记录文件哈希（旧格式 manifest），无法判断内容是否变化 —— 直接刷新'],
  }),
});
check(
  'an incomparable index explains itself and still allows a refresh',
  unknownGate.text.includes('没有记录文件哈希') && unknownGate.text.includes('执行增量刷新'),
  unknownGate.text.slice(-600),
);

const missingRoute = render(I.CoverageView, { report, ...viewProps, delta: null, deltaError: null });
check(
  'a host without the delta route behaves as before',
  missingRoute.text.includes('执行增量刷新') && !missingRoute.text.includes('无需刷新'),
  missingRoute.text.slice(-600),
);

section('maintenance: FTS repair');

const repairCommand = {
  mode: 'repair-fts',
  label: '修复搜索索引（FTS）',
  when: '面板显示 FTS 不可用、关键词搜索只能按名称匹配时使用。',
  argv: "gitnexus analyze --index-only --repair-fts 'D:\\demo'",
  shell: "$env:GITNEXUS_MEMORY='off'; gitnexus analyze --index-only --repair-fts 'D:\\demo'",
  destructive: false,
  caveat: null,
};
const withRepair = render(I.CoverageView, {
  report,
  ...viewProps,
  maintenance: {
    ...maintenance,
    supportsRepair: true,
    commands: [...maintenance.commands, repairCommand],
  },
  delta: withDelta({}),
});
check(
  'the repair control is offered when the host supports it',
  withRepair.text.includes('修复搜索索引') && withRepair.text.includes('--repair-fts'),
  withRepair.text.slice(-900),
);

const repairFromOldHost = render(I.CoverageView, {
  report,
  ...viewProps,
  maintenance: {
    ...maintenance,
    commands: [...maintenance.commands, repairCommand],
  },
  delta: withDelta({}),
});
check(
  'a host without repair support does not get a repair button',
  !repairFromOldHost.text.includes('修复搜索索引'),
  repairFromOldHost.text.slice(-900),
);

const repairRun = render(I.CoverageView, {
  report,
  ...viewProps,
  run: {
    state: 'done',
    force: false,
    repairFts: true,
    command: 'gitnexus analyze --index-only --repair-fts',
    startedAt: Date.now() - 3000,
    finishedAt: Date.now(),
    exitCode: 0,
    message: null,
    output: '',
  },
  delta: withDelta({}),
});
check('a repair run is labelled as such', repairRun.text.includes('修复 FTS'), repairRun.text.slice(-900));

// ---------------------------------------------------------------------------
// Graph card
// ---------------------------------------------------------------------------

section('graph: bounded projection card');

const graphEdge = { source: 'comm_43', target: 'comm_8', type: 'CALLS', weight: 2 };
const graphState = (patch) => ({
  projection: {
    view: 'communities',
    scope: null,
    total: 39,
    nodes: [
      { id: 'comm_43', kind: 'Community', name: 'Test', filePath: null, startLine: null, symbolCount: 26 },
      { id: 'comm_8', kind: 'Community', name: 'Routes', filePath: null, startLine: null, symbolCount: 18 },
    ],
    edges: [graphEdge],
    truncated: true,
    budget: { nodes: 220, edges: 800 },
    notes: ['共 39 个社区，显示符号数最多的 2 个'],
    readAt: new Date().toISOString(),
  },
  loading: false,
  error: null,
  routeState: 'ready',
  scope: null,
  onOpenCommunity: () => {},
  onBack: () => {},
  onReload: () => {},
  onOpenSymbol: () => {},
  ...patch,
});

const overview = render(I.CoverageView, { report, ...viewProps, graph: graphState({}) });
check(
  'the graph card names the overview and its coverage',
  overview.text.includes('社区总览') && overview.text.includes('2 / 39 个社区'),
  overview.text.slice(-700),
);
check(
  'a truncated view says how much it left out',
  overview.text.includes('已截断') && overview.text.includes('共 39 个社区'),
  overview.text.slice(-700),
);
check(
  'the reachable list mirrors the drawn nodes',
  overview.text.includes('Test · 26') && overview.text.includes('Routes · 18'),
  overview.text.slice(-700),
);
check(
  'the card explains the interaction and the budget',
  overview.text.includes('滚轮缩放') && overview.text.includes('220'),
  overview.text.slice(-700),
);

const drilled = render(I.CoverageView, {
  report,
  ...viewProps,
  graph: graphState({
    scope: 'comm_43',
    projection: {
      view: 'community',
      scope: 'comm_43',
      total: 26,
      nodes: [
        {
          id: 'Function:test/run.mjs:check',
          kind: 'Function',
          name: 'check',
          filePath: 'test/run.mjs',
          startLine: 30,
        },
      ],
      edges: [],
      truncated: false,
      budget: { nodes: 220, edges: 800 },
      notes: [],
      readAt: new Date().toISOString(),
    },
  }),
});
check(
  'a drill-down names its scope and offers a way back',
  drilled.text.includes('社区 comm_43') && drilled.text.includes('← 全部社区'),
  drilled.text.slice(-700),
);
check(
  'a symbol member is listed with its name',
  drilled.text.includes('check'),
  drilled.text.slice(-700),
);
check(
  'the drill-down explains that a symbol opens its file',
  drilled.text.includes('打开它并定位到行'),
  drilled.text.slice(-700),
);

const graphFailed = render(I.CoverageView, { report, ...viewProps, graph: graphState({ projection: null, error: '图查询失败：索引被占用' }) });
check('a graph error is surfaced', graphFailed.text.includes('图查询失败'), graphFailed.text.slice(-500));

const graphLoading = render(I.CoverageView, { report, ...viewProps, graph: graphState({ projection: null, loading: true }) });
check('an empty graph says it is still reading', graphLoading.text.includes('读取中'), graphLoading.text.slice(-500));

// The state that was actually observed: a client that reloaded ahead of the host. A 404
// used to leave `projection: null` with no error, so the card sat on 读取中… forever and
// read as a hang. It must name the cause instead.
const graphRouteMissing = render(I.CoverageView, {
  report,
  ...viewProps,
  graph: graphState({ projection: null, routeState: 'missing' }),
});
check(
  'a host without the graph route says to restart DSH',
  graphRouteMissing.text.includes('重启 DSH') && graphRouteMissing.text.includes('宿主未挂载图路由'),
  graphRouteMissing.text.slice(-600),
);
check(
  'a missing route does not pretend to still be loading',
  !graphRouteMissing.text.includes('正在读取图'),
  graphRouteMissing.text.slice(-600),
);

// A host without the route leaves the state undefined; the card must simply not appear
// rather than showing an empty frame in every profile that has not restarted yet.
const noGraph = render(I.CoverageView, { report, ...viewProps });
check('a host without the graph route renders no graph card', !noGraph.text.includes('社区总览'));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
