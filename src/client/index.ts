/**
 * dsh-gitnexus-plus — browser half.
 *
 * Plain CommonJS on purpose. The in-tree client preset (`packages/client/tsdown.client.ts`)
 * is unpublished, so an out-of-tree plugin must reproduce its output format with
 * its own toolchain — and the honest minimum here is no toolchain at all: this
 * module's only imports are platform baseline modules, so it can be wrapped into
 * the loader's factory verbatim by `scripts/build-client.mjs`, with no bundler and
 * no node_modules in the loop.
 *
 * UI COMES FROM THE SHARED PRIMITIVES PACKAGE
 * -------------------------------------------
 * An earlier revision hand-rolled every control with inline styles, on the
 * reasoning that `@deepseek-ai/dsh-client-ui-primitives` ships no JS in the
 * installed runtime and its exports therefore could not be verified. That
 * reasoning was wrong twice over. The package's own README states the rule —
 * "plugins cannot import another plugin's components, so this package is the one
 * place controls can be shared; reuse them" — and the installed plugin
 * `dsh-context` declares it as a peer dependency, which is exactly how a plugin is
 * meant to get a native look.
 *
 * Every prop used below was read off a real call site in an installed plugin
 * bundle rather than inferred from prose, because a wrong prop name fails
 * silently: React renders the component with its defaults and nothing throws.
 *
 *   Button        variant: "ghost" | "outline" | "primary" | "toolbar"
 *   StateDot      state: "done" | "warning" | "error" | "idle" | "ongoing"
 *   Tag           tone: "neutral" | "solid" | "outline" | "info"
 *   PathLabel     path
 *   FileTypeIcon  path | kind (from classifyFileType) , size, className
 *   Tooltip       label, side, delayMs, portal — wraps a single child
 *
 * WHAT THE PANEL SHOWS, AND WHY
 * -----------------------------
 * GitNexus prints skipped files once, to stderr, and never exposes them again. The
 * panel keeps that visible: the bar answers "how much of this repository does the
 * index actually represent?", the warning block says what was dropped, and the
 * file list says whether what was dropped is source or build output.
 */

// Namespace imports, not `require` and not default imports. `tsconfig.client.json`
// runs with `esModuleInterop: false`, under which `import * as React from 'react'`
// compiles to a bare `const React = require("react")` — exactly the form the loader
// factory provides, with no `__importStar` helper riding along into every page load.
// It is also the only form that gives `React.ReactNode` and `React.CSSProperties`
// as usable type namespaces.
import * as React from 'react';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';

const {
  Button,
  FileTypeIcon,
  PathLabel,
  SegmentedControl,
  StateDot,
  Tag,
  Tooltip,
  IconRefreshOutlineRegular,
  classifyFileType,
} = primitives;

const h = React.createElement;

/** Must match the `id` in the loader factory written by scripts/build-client.mjs. */
const PLUGIN_ID = 'dsh-gitnexus-plus';

/** The sidebar-right tab type this plugin contributes. */
const TAB_KIND = 'gitnexus';

// ---------------------------------------------------------------------------
// The report, as this half reads it
// ---------------------------------------------------------------------------
//
// Declared locally rather than imported from `../gitnexus/coverage.js`. The two
// halves ship as separate artifacts — this one is compiled to CommonJS and wrapped
// into a `window.__ModuleLoader__` factory whose `require` only resolves platform
// modules — so a relative import of a host module would not resolve at runtime and
// would break the single-module constraint the loader requires.
//
// Every field is optional and read defensively, because that is how the panel
// already behaves: it renders against a partial report, a report from an older
// index that never recorded a field, and a failed fetch. Making these required
// would delete the guards rather than check them.

/** One entry of the report's warnings list. */
interface ClientWarning {
  level: string;
  code: string;
  message: string;
}

/**
 * The file/coverage counts the header summarises.
 *
 * Every field is required: the host builds this block unconditionally for a report
 * that has an index. Only the outer member is optional, because the panel also
 * renders a partial `{ repo: { indexed: false } }` for a project that has none.
 */
interface ClientTotals {
  scanned: number;
  selected: number;
  indexedInGraph: number;
  large: number;
  largeBytes: number;
  suppressedDeclarations: number;
}

/** The effective size cap and where it came from. Built unconditionally too. */
interface ClientCap {
  text: string;
  source: string;
  maxText: string;
}

/** What the graph holds. */
interface ClientGraph {
  nodes: number;
  edges: number;
  communities: number;
  processes: number;
  embeddings: number;
  edgesPerNode: number;
}

/** One query surface's availability. */
interface ClientCapability {
  status?: string;
  skipReason?: string;
  provider?: string;
}

/** Freshness of the index against HEAD. */
interface ClientStaleness {
  state?: string;
  indexedCommit?: string | null;
  headCommit?: string | null;
  branch?: string | null;
  /** Null when git could not be asked — not the same as a clean tree. */
  dirtyCount?: number | null;
  aheadBehind?: { behind?: number; ahead?: number } | null;
  gitAvailable?: boolean;
}

/** Resolver confidence: untyped receiver sites, by member name. */
interface ClientGraphQuality {
  totalSites?: number;
  counts?: Record<string, unknown>;
}

/** Analysis configuration that forces a rebuild when it changes. */
interface ClientProvenance {
  schemaFingerprint?: string | null;
  contentRetention?: string | null;
  ftsProfile?: string | null;
  crossLanguageProperties?: number;
  runnerCliVersion?: string | null;
}

/** One oversized file the size cap dropped. */
interface ClientLargeFile {
  path: string;
  size: number;
  sizeText: string;
  shareOfScanned?: number;
  shareOfLanguage?: number;
  language?: { key: string; label: string; color: string } | null;
  minified?: { binary: boolean; suspect: boolean; avgLineLength: number } | null;
  generatedHint?: boolean;
}

/** The language breakdown with the oversized files held out of it. */
interface ClientLanguages {
  rows: LanguageRowLike[];
  totalBytes: number;
  totalFiles: number;
  largeExcluded?: LanguageRowLike[];
}

/** One touched file from the activity window. */
interface ClientActivityFile {
  path: string;
  changes: number;
  insertions: number;
  deletions: number;
  lastChange: string;
  verdict: string;
}

/** Recent git activity, crossed with the index. */
interface ClientActivity {
  window?: { sinceDays?: number; truncated?: boolean };
  totals?: {
    commits?: number;
    authors?: number;
    bots?: number;
    files?: number;
    insertions?: number;
    deletions?: number;
    verdicts?: Record<string, number>;
    indexKnown?: boolean;
  };
  authors?: Array<{ name: string; email?: string; bot?: boolean; commits: number; files?: number }>;
  byChanges?: ClientActivityFile[];
  byRecency?: ClientActivityFile[];
  missingFiles?: ClientActivityFile[];
  branches?: Array<{ name: string; current?: boolean; lastCommitDate?: string | null }>;
  histogram?: { bucketDays: number; buckets: HistogramBucketLike[] } | null;
}

/** Coverage differences between a fresh scan and the index. */
interface ClientIndexInfo {
  uncoveredCount?: number;
  uncoveredSample?: Array<{ path: string; size: number }>;
  staleCount?: number;
  staleSample?: string[];
  dirtyPaths?: string[];
}

/** The subset of the host report this half renders. */
interface ClientReport {
  repo?: {
    path?: string;
    name?: string;
    indexed?: boolean;
    indexedAt?: string | null;
    lastCommit?: string | null;
    branch?: string | null;
    metaFile?: string | null;
    registered?: boolean;
  };
  analyzer?: { gitnexusVersion: string | null; primitives: string };
  cap?: ClientCap;
  totals?: ClientTotals;
  graph?: ClientGraph | null;
  capabilities?: Record<string, ClientCapability>;
  staleness?: ClientStaleness;
  provenance?: ClientProvenance | null;
  graphQuality?: ClientGraphQuality | null;
  warnings?: ClientWarning[];
  languages?: ClientLanguages | null;
  activity?: ClientActivity | null;
  largeFiles?: ClientLargeFile[];
  index?: ClientIndexInfo;
  attribution?: { oversizeShareOfScanned?: number };
}

/** One maintenance command handed to the operator. */
interface ClientMaintenanceCommand {
  mode: string;
  label: string;
  when: string;
  argv: string;
  shell: string;
  destructive: boolean;
  caveat: string | null;
}

/** The maintenance payload that rides along with a report. */
interface ClientMaintenance {
  commands?: ClientMaintenanceCommand[];
  rationale?: string[];
}

/** Which context props the slot actually supplied. */
interface ContextDiagnostic {
  present: string[];
  absent: string[];
}

/** A `StateDot` state, named so helpers and components agree on the union. */
type DotState = 'done' | 'warning' | 'error' | 'idle' | 'ongoing';

/**
 * Empty blocks used to narrow a report past the point where an index is known to
 * exist. Zeros rather than absent fields, so a partially-populated report from an
 * older index still renders numbers instead of `undefined`.
 */
const ZERO_TOTALS: ClientTotals = {
  scanned: 0,
  selected: 0,
  indexedInGraph: 0,
  large: 0,
  largeBytes: 0,
  suppressedDeclarations: 0,
};
const ZERO_CAP: ClientCap = { text: '—', source: 'default', maxText: '—' };
const ZERO_ANALYZER: { gitnexusVersion: string | null; primitives: string } = {
  gitnexusVersion: null,
  primitives: 'unknown',
};

/**
 * What the slot supplies to this panel.
 *
 * Every member is optional and every hook is probed with `typeof … === 'function'`
 * before it is called, because which standard props arrive depends on which sibling
 * packages the host has mounted. `useSessions` is the one that actually carries a
 * session's `cwd` — read off `dsh-client-ui-sidebar-files`, whose body sits in this
 * same slot and needs the same answer. An earlier revision guessed at
 * `useWorkspaces` and rendered "未解析到工作区": a hook that exists is not the same
 * as the hook that carries the value.
 */
interface SlotProps {
  /** Set when a caller opened the tab for a specific project. */
  params?: { repo?: string };
  sessionId?: string;
  /** Snapshot selector over sessions; `byId[sessionId].cwd` is the project path. */
  useSessions?: <T>(selector: (snapshot: { byId?: Record<string, { cwd?: string }> }) => T) => T;
  /** Snapshot selector over the workspace list, matched by `sessionIds`. */
  useWorkspaces?: <T>(
    selector: (snapshot: { workspaces?: Array<{ sessionIds?: string[]; cwd?: string }> }) => T,
  ) => T;
  useTabInfo?: () => unknown;
}


// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Resolve one of this plugin's host routes against the PAGE's own base.
 *
 * Two failures are avoided here. A leading slash pins a URL to the origin root,
 * which walks out of any reverse-proxy directory prefix. And resolving against
 * `location.host` breaks on the desktop shell, whose page origin is `dsh-app://app`
 * — a hostname that never completes a DNS lookup.
 *
 * @param {string} path
 * @returns {string}
 */
function routeUrl(path: string): string {
  const raw =
    typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : '';
  const placeholder = 'http://dsh.invalid/';
  const url = new URL(raw === '' ? placeholder : raw, placeholder);
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return new URL(path.replace(/^\/+/, ''), url.href).href;
}

// ---------------------------------------------------------------------------
// Pure view-model helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Fall back to local formatting unless the primitives package exposes its own.
 * `fileSizeText` was present in the export surface of installed bundles but never
 * observed at a call site, so it is used opportunistically rather than assumed.
 * @param {number} bytes
 */
function fileSize(bytes: number): string {
  if (typeof primitives.fileSizeText === 'function') return primitives.fileSizeText(bytes);
  return formatBytes(bytes);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Percentage of a whole, as a number in [0, 100].
 * @param {number} part
 * @param {number} whole
 */
function percent(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return (part / whole) * 100;
}

function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0.0';
}

/** One language as the client reads it. Mirrors the host report's row. */
interface LanguageRowLike {
  key: string;
  label: string;
  color: string;
  bytes: number;
  files: number;
}

/** One drawn segment of the stacked bar. */
interface StackSegment {
  key: string;
  label: string;
  color: string;
  percent: number;
}

/**
 * Turn language rows into stack segments whose widths sum to exactly 100.
 *
 * Rounding each share independently leaves a visible gap or overflow in a stacked
 * bar, so the largest segment absorbs the residual. The metric is a parameter
 * because "what is this repository written in" has two defensible answers — bytes
 * for weight of code, files for breadth of surface — and they disagree often enough
 * that showing only one invites the wrong conclusion.
 */
function stackSegments(
  rows: LanguageRowLike[],
  totalBytes: number,
  totalFiles: number,
  metric: 'bytes' | 'files' = 'bytes',
): StackSegment[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const whole = metric === 'files' ? totalFiles : totalBytes;
  const valueOf = (row: LanguageRowLike): number => (metric === 'files' ? row.files : row.bytes);

  const shares = rows.map((row) => ({
    key: row.key,
    label: row.label,
    color: row.color,
    percent: percent(valueOf(row), whole),
  }));
  const sum = shares.reduce((acc, s) => acc + s.percent, 0);
  if (sum > 0 && Math.abs(sum - 100) > 0.005) {
    let biggest = 0;
    for (let i = 1; i < shares.length; i += 1) {
      if (shares[i].percent > shares[biggest].percent) biggest = i;
    }
    shares[biggest].percent += 100 - sum;
  }
  return shares;
}

/**
 * Split the report's warnings by severity.
 *
 * Warnings arrive as structured records rather than prose so that a caller (the
 * model, via the tool) can act on `code`. The panel only renders them, but keeps
 * the split: `warn` is what the reader must not miss, `info` is context.
 *
 * @param {Array<{level:string,code:string,message:string}>} warnings
 */
function splitWarnings(warnings: ClientWarning[] | undefined): { notable: ClientWarning[]; context: ClientWarning[] } {
  const list = Array.isArray(warnings) ? warnings : [];
  return {
    notable: list.filter((w) => w.level === 'warn'),
    context: list.filter((w) => w.level !== 'warn'),
  };
}

/**
 * Derive the header's one-line summary from a report.
 * @param {any} report
 * @returns {string}
 */
function summaryLine(report: ClientReport | null): string {
  if (report === null || typeof report !== 'object') return '';
  // Optional-chained per read rather than `report.totals ?? {}`: an empty object
  // literal would erase the field types and every read below would be `unknown`.
  const totals = report.totals;
  const parts = [
    `扫描 ${totals?.scanned ?? 0}`,
    `选中 ${totals?.selected ?? 0}`,
    `图内 ${totals?.indexedInGraph ?? 0}`,
  ];
  const large = totals?.large ?? 0;
  if (large > 0) parts.push(`跳过 ${large}`);
  const suppressed = totals?.suppressedDeclarations ?? 0;
  if (suppressed > 0) parts.push(`声明抑制 ${suppressed}`);
  return parts.join('  ·  ');
}

/**
 * Fraction of scanned files the index covers, in [0, 1], or `null` when there is
 * nothing to divide by — so the UI can omit rather than print a fabricated 0/100.
 * @param {any} report
 * @returns {number | null}
 */
function coverageRatio(report: ClientReport | null): number | null {
  const scanned = report?.totals?.scanned;
  const indexed = report?.totals?.indexedInGraph;
  // Explicit `typeof` guards rather than `Number.isFinite` alone: `isFinite` takes
  // `unknown` and does not narrow, so the division below would still be typed
  // against a possibly-absent value.
  if (typeof scanned !== 'number' || typeof indexed !== 'number') return null;
  if (!Number.isFinite(scanned) || !Number.isFinite(indexed) || scanned <= 0) return null;
  return Math.max(0, Math.min(1, indexed / scanned));
}

/**
 * Index health as a `StateDot` state.
 *
 * `error` is reserved for an index that is absent or badly behind; `warning` for
 * one that is usable but has dropped files worth knowing about.
 * @param {any} report
 * @returns {'done' | 'warning' | 'error' | 'idle'}
 */
function healthState(report: ClientReport | null): DotState {
  if (report === null || report?.repo?.indexed !== true) return 'error';
  const ratio = coverageRatio(report);
  const skipped = report?.totals?.large ?? 0;
  if (skipped > 0) return 'warning';
  if (ratio !== null && ratio < 0.9) return 'warning';
  return 'done';
}

/**
 * Staleness as a dot state plus a sentence.
 *
 * `diverged` is deliberately not folded into `behind`: when HEAD has moved off the
 * indexed commit, the distance between them does not measure how much of the index
 * is wrong, so the UI must not imply a count it cannot give. Measured on a real
 * repository, the panel had been showing the indexed commit as though it were
 * current while HEAD was already one commit ahead on a different line.
 *
 * @param {any} staleness
 * @returns {{ state: 'done' | 'warning' | 'error' | 'idle', text: string }}
 */
function stalenessView(staleness: ClientStaleness | undefined): { state: DotState; text: string } {
  if (!staleness || staleness.gitAvailable !== true) {
    return { state: 'idle', text: 'git 不可用，无法判断新鲜度' };
  }
  const short = (sha: string | null | undefined): string => (typeof sha === 'string' && sha !== '' ? sha.slice(0, 8) : '?');
  const head = short(staleness.headCommit);
  const indexed = short(staleness.indexedCommit);
  const dirtyCount = typeof staleness.dirtyCount === 'number' ? staleness.dirtyCount : 0;
  const dirty = dirtyCount > 0 ? `，工作区 ${dirtyCount} 处未提交改动` : '';

  switch (staleness.state) {
    case 'current':
      return { state: 'done', text: `current · HEAD ${head} 与索引一致${dirty}` };
    case 'behind': {
      const ahead = staleness.aheadBehind?.ahead ?? 0;
      return {
        state: 'warning',
        text: `behind · 索引落后 ${ahead} 个提交（${indexed} → ${head}），可直接增量刷新${dirty}`,
      };
    }
    case 'diverged': {
      // Diverged means the *indexed* commit holds work HEAD no longer reaches —
      // not merely that HEAD is ahead. The distinction decides whether an
      // incremental refresh is enough or a rebuild is required, so the wording
      // must not blur it.
      const indexedSide = staleness.aheadBehind?.behind ?? 0;
      return {
        state: 'warning',
        text:
          `diverged · HEAD ${head} 已偏离索引提交 ${indexed}（索引侧另有 ${indexedSide} 个提交不在 HEAD 上）` +
          `${dirty}`,
      };
    }
    default:
      return { state: 'idle', text: `unknown · 无法比对 ${indexed} 与 ${head}${dirty}` };
  }
}

/**
 * Capability rows for the query surfaces, in a fixed order so the panel does not
 * reshuffle between repositories.
 *
 * A capability whose provider reports `unavailable` still gets a row: "no keyword
 * search" is information, and hiding it is how a reader concludes the graph can do
 * something it cannot.
 *
 * @param {any} capabilities
 * @returns {Array<{ key: string, label: string, ok: boolean, provider: string, note: string }>}
 */
const CAPABILITY_KEYS = ['graph', 'fts', 'vectorSearch'] as const;
type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

function capabilityRows(capabilities: Record<string, ClientCapability> | undefined): Array<{ key: string; label: string; ok: boolean; provider: string; note: string }> {
  const caps = capabilities ?? {};
  // Keyed by the same literal union the loop walks, so the lookup is checked rather
  // than an index-signature read that would silently yield `undefined`.
  const labels: Record<CapabilityKey, string> = {
    graph: '图查询',
    fts: '关键词搜索',
    vectorSearch: '语义搜索',
  };
  return CAPABILITY_KEYS.map((key) => {
    const entry: ClientCapability = caps[key] ?? {};
    const ok = entry.status === 'available';
    return {
      key,
      label: labels[key],
      ok,
      provider: typeof entry.provider === 'string' ? entry.provider : 'unknown',
      note: ok ? '' : String(entry.skipReason ?? entry.status ?? 'unavailable'),
    };
  });
}

/**
 * Summarise the resolver's untyped receiver sites.
 *
 * GitNexus publishes this so `impact` and `context` can report `exact` versus
 * `lower-bound`; the panel surfaces it because it is the honest caveat on every
 * other number here.
 */
function graphQualitySummary(graphQuality: ClientGraphQuality | null | undefined): { total: number; names: Array<{ name: string; count: number }> } | null {
  const counts = graphQuality?.counts;
  if (counts === null || counts === undefined || typeof counts !== 'object') return null;
  const names = Object.entries(counts)
    // Narrow to numbers here rather than at the `.sort` below: the counts come from
    // an external manifest, so a non-numeric entry is possible and would otherwise
    // reach the comparator as `unknown`.
    .filter((pair): pair is [string, number] => typeof pair[1] === 'number' && Number.isFinite(pair[1]))
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const total =
    typeof graphQuality?.totalSites === 'number' && Number.isFinite(graphQuality.totalSites)
      ? graphQuality.totalSites
      : names.reduce((sum, entry) => sum + entry.count, 0);
  return { total, names };
}

/**
 * Compact a count for a dense row: 26788 → "26.8k", 2366932 → "2.4M".
 *
 * One decimal is kept all the way up, matching how the product's own dashboards
 * render counts. Rounding 26 788 to a bare "27k" discards the digits a reader is
 * actually comparing between repositories.
 */
function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const MUTED = { opacity: 0.62 };
const HAIRLINE = '1px solid color-mix(in srgb, currentColor 16%, transparent)';
const SOFT_BG = 'color-mix(in srgb, currentColor 6%, transparent)';

/** Layout only. Appearance belongs to the primitives, which read `--dsw-*` tokens. */
/**
 * Layout.
 *
 * The panel is a CARD GRID, not a vertical stack: the surface it lives in can be
 * narrow (a docked sidebar) or very wide (a maximised pane), and a single column of
 * full-width cards reads as broken at the wide end — every metric row stretches
 * across a metre of empty space.
 *
 * Column count is content-driven rather than media-queried, because an inline-styled
 * plugin has no stylesheet to put a breakpoint in: `auto-fit` with a 620px floor
 * yields two columns once the pane can hold them and one column below that. A
 * card that needs the full width says so with `gridColumn: '1 / -1'`, which is
 * column-count agnostic — unlike `span 2`, which would overflow a single column.
 */
const styles = {
  root: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 620px), 1fr))',
    // No `alignItems: start`: grid items stretch to the row height by default, so
    // two cards sharing a row end level. With `start` each card took its natural
    // height and the row showed a ragged bottom edge.
    gap: '10px',
    padding: '12px',
    fontSize: '12px',
    lineHeight: 1.5,
    overflowY: 'auto',
    height: '100%',
    boxSizing: 'border-box',
  },
  /**
   * A card that takes one grid column.
   *
   * Flex column, not block. A card stretched by the grid has a definite height, and
   * its body needs to grow into that height — which `height: 100%` on the body gets
   * wrong: a percentage height is resolved from the parent, so the body's own
   * content stops contributing to the row's intrinsic height, the row is sized too
   * short, and the body spills past the border. `flex: 1` on the body grows it
   * without breaking the content-based sizing.
   */
  card: {
    border: HAIRLINE,
    borderRadius: '8px',
    padding: '10px',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  /** A card that spans every column. */
  cardWide: {
    border: HAIRLINE,
    borderRadius: '8px',
    padding: '10px',
    minWidth: 0,
    gridColumn: '1 / -1',
    display: 'flex',
    flexDirection: 'column',
  },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  bar: { display: 'flex', height: '10px', borderRadius: '5px', overflow: 'hidden', background: SOFT_BG },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  fileRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0' },
  fileMeta: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 },
};

/**
 * One card: an optional heading row, then the body.
 *
 * Every section goes through this so the span decision is made once per card, next
 * to the content that justified it, rather than as a style literal repeated at each
 * call site.
 *
 * `SectionProps` keeps `title` and `meta` open to a node as well as a string: some
 * cards pass an element (a control, a live status dot) where others pass a label.
 */
interface SectionProps {
  title?: React.ReactNode;
  meta?: React.ReactNode;
  wide?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

function Section({ title, meta, wide = false, children, style }: SectionProps) {
  return h(
    'section',
    { style: { ...(wide ? styles.cardWide : styles.card), ...style } },
    title === undefined
      ? null
      : h(
          'div',
          { style: { marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
          typeof title === 'string' ? h('span', { style: MUTED }, title) : title,
          h('span', { style: { flex: 1 } }),
          meta ?? null,
        ),
    children,
  );
}

interface RowProps {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

function Row({ children, style }: RowProps) {
  return h('div', { style: { ...styles.row, ...style } }, children);
}


/**
 * One file's flags, as native tags.
 */
function FileFlags({ file }: { file: ClientLargeFile }) {
  const flags: React.ReactNode[] = [];
  if (file.minified?.binary) {
    flags.push(h(Tag, { key: 'bin', tone: 'neutral' }, '二进制'));
  } else if (file.minified?.suspect) {
    flags.push(h(Tag, { key: 'min', tone: 'info' }, `单行 ~${Math.round(file.minified.avgLineLength)}`));
  }
  if (file.generatedHint) {
    flags.push(h(Tag, { key: 'gen', tone: 'outline' }, '构建产物'));
  }
  if (flags.length === 0) return null;
  return h('span', { style: { display: 'inline-flex', gap: '4px', flexShrink: 0 } }, flags);
}

/**
 * A donut with its value in the middle.
 *
 * SVG rather than a charting dependency: one arc is a `stroke-dasharray` on a
 * circle, and pulling in a chart library for it would add more surface than the
 * whole client half. The value sits in the hole because that is the number the
 * ring is *about* — a ring whose meaning lives only in the stroke width makes the
 * reader estimate what could simply be stated.
 *
 * @param {{ ratio: number, caption: string, tone?: string, size?: number }} props
 */
interface RingProps {
  ratio: number;
  caption: string;
  tone?: string;
  size?: number;
}

function Ring({ ratio, caption, tone = 'currentColor', size = 76 }: RingProps) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * clamped;

  return h(
    'div',
    { style: { position: 'relative', width: `${size}px`, height: `${size}px`, flexShrink: 0 } },
    h(
      'svg',
      { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': caption },
      h('circle', {
        cx: size / 2,
        cy: size / 2,
        r: radius,
        fill: 'none',
        stroke: 'currentColor',
        strokeOpacity: 0.15,
        strokeWidth: stroke,
      }),
      h('circle', {
        cx: size / 2,
        cy: size / 2,
        r: radius,
        fill: 'none',
        stroke: tone,
        strokeWidth: stroke,
        strokeLinecap: 'round',
        strokeDasharray: `${dash} ${circumference - dash}`,
        // Start the arc at twelve o'clock rather than three.
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      }),
    ),
    h(
      'div',
      {
        style: {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1px',
        },
      },
      h('span', { style: { fontSize: '15px', fontWeight: 600, ...styles.mono } }, `${fixed(clamped * 100, 1)}%`),
      h('span', { style: { fontSize: '10px', ...MUTED } }, caption),
    ),
  );
}

/**
 * A two-column metric grid with a coloured dot per row.
 *
 * The dot is `StateDot` where a metric has a state, and a plain swatch where it
 * only has an identity — the distinction keeps a neutral count from reading as a
 * status. Tabular figures and right-aligned values so a column of numbers can be
 * compared without reading each one.
 *
 * @param {{ items: Array<{ label: string, value: string, hint?: string, color?: string, state?: string }> }} props
 */
interface MetricItem {
  label: string;
  value: string;
  hint?: string;
  color?: string;
  /** Present when the metric carries a status; absent when it is only an identity. */
  state?: DotState;
}

function MetricGrid({ items }: { items: MetricItem[] }) {
  return h(
    'div',
    { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '4px 16px' } },
    items.map((item) =>
      h(
        'div',
        { key: item.label, style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
        item.state !== undefined
          ? h(StateDot, { state: item.state })
          : h('span', {
              style: {
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: item.color ?? 'currentColor',
                opacity: item.color === undefined ? 0.4 : 1,
                flexShrink: 0,
              },
            }),
        // Label and value sit ADJACENT. A flex spacer between them was a bug that
        // only showed on a wide pane: the cell stretched and pushed the two ends
        // hundreds of pixels apart, so a row read as two unrelated columns of text
        // rather than one metric.
        h('span', { style: { ...MUTED, whiteSpace: 'nowrap' } }, item.label),
        h('span', { style: { fontWeight: 600, ...styles.mono, whiteSpace: 'nowrap' } }, item.value),
        item.hint !== undefined ? h('span', { style: { ...MUTED, fontSize: '10px' } }, item.hint) : null,
      ),
    ),
  );
}

/**
 * Commit activity over time, as columns.
 *
 * The reference panel's trend chart, reduced to what this data supports: counts per
 * bucket, with the bucket width taken from the data rather than assumed. Bars are
 * stacked insertions-over-deletions in the two directions a chart can honestly show
 * — one column's total height is commits, so line churn rides as a filled fraction
 * rather than a second scale the eye would have to calibrate.
 *
 * @param {{ histogram: { bucketDays: number, buckets: Array<{label:string,commits:number,insertions:number,deletions:number}> }, height?: number }} props
 */
interface HistogramBucketLike {
  label: string;
  commits: number;
  insertions: number;
  deletions: number;
}

interface HistogramProps {
  histogram: { bucketDays: number; buckets: HistogramBucketLike[] };
  height?: number;
}

function Histogram({ histogram, height = 54 }: HistogramProps) {
  const buckets = histogram?.buckets ?? [];
  if (buckets.length === 0) return null;
  const max = Math.max(...buckets.map((b) => b.commits), 1);
  const bucketDays = histogram.bucketDays ?? 1;

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
    h(
      'div',
      {
        style: { display: 'flex', alignItems: 'flex-end', gap: '1px', height: `${height}px` },
        role: 'img',
        'aria-label': `提交活动，每${bucketDays === 7 ? '周' : '天'}一柱`,
      },
      buckets.map((bucket, index) =>
        h(
          Tooltip,
          {
            key: `${bucket.label}-${index}`,
            label: `${bucket.label} · ${bucket.commits} 提交 · +${bucket.insertions}/-${bucket.deletions}`,
            side: 'bottom',
          },
          h('div', {
            style: {
              flex: '1 1 0',
              // A zero bucket keeps a visible floor so a gap reads as "no commits"
              // rather than as missing data.
              height: `${Math.max(2, (bucket.commits / max) * height)}px`,
              background: bucket.commits === 0 ? 'currentColor' : 'var(--dsw-color-accent, currentColor)',
              opacity: bucket.commits === 0 ? 0.16 : 0.75,
              borderRadius: '1px',
              alignSelf: 'flex-end',
            },
          }),
        ),
      ),
    ),
    h(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', fontSize: '10px', ...MUTED } },
      h('span', null, buckets[0]?.label ?? ''),
      h('span', null, `每${bucketDays === 7 ? '周' : '天'} · 峰值 ${max}`),
      h('span', null, buckets[buckets.length - 1]?.label ?? ''),
    ),
  );
}

/**
 * The stacked bar plus its legend.
 *
 * Each segment carries a `Tooltip` rather than a native `title`: the primitives'
 * tooltip is the themed one, and a colour swatch a few pixels wide is otherwise
 * impossible to identify.
 *
 * The legend shows the top rows and folds the tail, because a sidebar has room for
 * roughly one line of chips — and a language at 0.02 % is not something a reader
 * scans for, it is something they look up when they already suspect it.
 *
 * @param {{rows: any[], totalBytes: number, totalFiles?: number, metric?: 'bytes'|'files'}} props
 */
interface LanguageBarProps {
  rows: LanguageRowLike[];
  totalBytes: number;
  totalFiles?: number;
  metric?: 'bytes' | 'files';
}

function LanguageBar({ rows, totalBytes, totalFiles = 0, metric = 'bytes' }: LanguageBarProps) {
  const segments = stackSegments(rows, totalBytes, totalFiles, metric);
  if (segments.length === 0) return null;

  const visible = segments.filter((s) => s.percent >= 0.05);
  const hidden = segments.length - visible.length;

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    h(
      'div',
      { style: styles.bar, role: 'img', 'aria-label': '语言分布' },
      segments.map((segment, index) =>
        h(
          Tooltip,
          { key: `${segment.key}-${index}`, label: `${segment.label} ${fixed(segment.percent, 1)}%`, side: 'bottom' },
          h('div', {
            // A floor keeps a 0.01% language visible; the flex ratio keeps the
            // major segments proportional.
            style: { width: `${Math.max(0.4, segment.percent)}%`, background: segment.color, flexShrink: 0 },
          }),
        ),
      ),
    ),
    h(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px' } },
      visible.map((segment) =>
        h(
          'span',
          { key: segment.key, style: { display: 'inline-flex', gap: '5px', alignItems: 'center' } },
          h('span', {
            style: {
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: segment.color,
              display: 'inline-block',
              flexShrink: 0,
            },
          }),
          h('span', null, segment.label),
          h('span', { style: MUTED }, `${fixed(segment.percent, 1)}%`),
        ),
      ),
      hidden > 0 ? h('span', { style: MUTED }, `…另有 ${hidden} 种`) : null,
    ),
  );
}

/**
 * Language distribution, with the metric switchable.
 *
 * The toggle earns its place because bytes and files disagree in a way that
 * changes the answer: a repository can be 70 % TypeScript by bytes while being
 * mostly Markdown by file count, and either statement alone is misleading. The
 * control is a stateful wrapper so `CoverageView` stays a pure function of its
 * props and can still be rendered against a fixture.
 *
 * @param {{languages: {rows: any[], totalBytes: number, totalFiles: number}}} props
 */
function LanguageSection({ languages }: { languages: ClientLanguages }) {
  const [metric, setMetric] = React.useState<'bytes' | 'files'>('bytes');
  const unit = metric === 'files' ? '文件' : '字节';

  return h(
    Section,
    {
      title: `语言分布 · ${languages.rows.length} 种`,
      meta: h(SegmentedControl, {
        id: 'gitnexus-language-metric',
        label: '语言分布统计口径',
        value: metric,
        // The control's API is string-valued; narrowing here rather than widening the
        // state keeps the union intact downstream, where `stackSegments` switches on
        // it — a widened state would let a typo like `'bytse'` compile.
        onChange: (next) => setMetric(next === 'files' ? 'files' : 'bytes'),
        options: [
          { value: 'bytes', label: '按字节' },
          { value: 'files', label: '按文件' },
        ],
      }),
      // The card stretches to the row height beside the overview card; the footnote
      // below uses `marginTop: auto` to sit at the foot of that height.
    },
    h(LanguageBar, {
      rows: languages.rows,
      totalBytes: languages.totalBytes,
      totalFiles: languages.totalFiles,
      metric,
    }),
    h(
      'div',
      { style: { marginTop: 'auto', paddingTop: '8px', fontSize: '10px', ...MUTED } },
      `按${unit}计的占比；GitNexus 只解析其中一部分语言，其余仅作为文件节点存在`,
    ),
  );
}

/**
 * The files the size cap dropped.
 *
 * `FileTypeIcon` + `PathLabel` replace a hand-rolled row: the icon makes a `.glb`
 * or a `.ts` readable at a glance, and `PathLabel` dims the directories, keeps the
 * filename at full strength, and preserves the tail on overflow — which is what a
 * path needs and what raw truncation destroys.
 * @param {{files: any[]}} props
 */
function LargeFileList({ files }: { files: ClientLargeFile[] }) {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column' } },
    files.map((file) =>
      h(
        'div',
        { key: file.path, style: styles.fileRow },
        h(FileTypeIcon, { path: file.path, size: 16 }),
        h(
          'span',
          { style: { minWidth: 0, flex: '1 1 auto' } },
          h(PathLabel, { path: file.path }),
        ),
        h(
          'span',
          { style: styles.fileMeta },
          h('span', { style: { ...MUTED, whiteSpace: 'nowrap' } }, file.sizeText),
          h(FileFlags, { file }),
          h(
            'span',
            { style: { ...MUTED, whiteSpace: 'nowrap' } },
            `${fixed((file.shareOfLanguage ?? 0) * 100, 0)}% ${file.language?.label ?? ''}`,
          ),
        ),
      ),
    ),
  );
}

/**
 * Which query surfaces are live.
 * @param {{capabilities: any}} props
 */
function CapabilityStrip({ capabilities }: { capabilities: Record<string, ClientCapability> | undefined }) {
  const rows = capabilityRows(capabilities);
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
    rows.map((row) =>
      h(
        'div',
        { key: row.key, style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        h(StateDot, { state: row.ok ? 'done' : 'idle' }),
        h('span', { style: { minWidth: '68px' } }, row.label),
        row.ok
          ? h('span', { style: MUTED }, row.provider)
          : h(Tag, { tone: 'outline' }, row.note),
      ),
    ),
  );
}

/**
 * Resolver confidence and analysis provenance.
 *
 * Body only — the surrounding `Section` card supplies the border and the heading.
 *
 * @param {{quality: any, provenance: any}} props
 */
function ProvenanceBlock({ quality, provenance }: { quality: ClientGraphQuality | null; provenance: ClientProvenance | null }) {
  const summary = graphQualitySummary(quality);

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '4px', flex: '1 1 auto' } },
    summary === null
      ? h('div', { style: MUTED }, '该索引未记录未解析接收者统计（旧版本写入）')
      : h(
          'div',
          null,
          h(
            'div',
            null,
            `未解析接收者 ${compactNumber(summary.total)} 处——存在这些位置时，impact / context 的结果是下界而非精确值`,
          ),
          h(
            'div',
            { style: { ...MUTED, marginTop: '3px' } },
            summary.names
              .slice(0, 6)
              .map((entry) => `${entry.name} ${entry.count}`)
              .join('  ·  '),
          ),
        ),
    provenance === null
      ? null
      : h(
          'div',
          // Pushed to the bottom: this card shares a row with the caveats card and
          // stretches to its height, so anchoring the metrics at the foot turns the
          // leftover space into a gap between two groups rather than a void below.
          { style: { marginTop: 'auto', paddingTop: '8px' } },
          h(MetricGrid, {
            items: [
              { label: 'schema', value: provenance.schemaFingerprint ?? '—' },
              { label: '内容保留', value: provenance.contentRetention ?? '—' },
              { label: 'FTS 配置', value: provenance.ftsProfile ?? '—' },
              { label: '跨语言属性', value: compactNumber(provenance.crossLanguageProperties ?? 0) },
              { label: '分析器', value: provenance.runnerCliVersion ?? '—' },
            ],
          }),
        ),
  );
}

/** Collapsed summary for the provenance card's header. */
function provenanceCollapsed(quality: ClientGraphQuality | null): string {
  const summary = graphQualitySummary(quality);
  return summary === null ? '无未解析接收者记录' : `未解析接收者 ${compactNumber(summary.total)} 处`;
}

/** Collapsed summary for the activity card's header. */
function activityCollapsed(activity: ClientActivity | null | undefined): string {
  const view = activityView(activity);
  if (view === null) return '不可用';
  const missing = view.verdicts.find((v) => v.key === 'missing')?.value ?? 0;
  if (missing > 0) return `${missing} 个活跃文件不在索引中`;
  return `活跃文件均在索引中${view.truncated ? ' · 窗口已截断' : ''}`;
}

/**
 * All activity numbers in one place, so the view stays a layout decision.
 * @param {any} activity
 * @returns {null | { window: string, totals: string, verdicts: Array<{key:string,label:string,value:number,tone:string}> }}
 */
function activityView(activity: ClientActivity | null | undefined): { window: string; totals: string; verdicts: Array<{ key: string; label: string; value: number; tone: DotState }>; truncated: boolean } | null {
  if (activity === null || typeof activity !== 'object') return null;
  const t = activity.totals ?? {};
  const v = t.verdicts ?? { indexed: 0, excluded: 0, missing: 0 };
  return {
    window: `近 ${activity.window?.sinceDays ?? '?'} 天`,
    truncated: activity.window?.truncated === true,
    totals: `${t.commits ?? 0} 提交 · ${t.authors ?? 0} 作者 · ${compactNumber(t.insertions ?? 0)} 增 / ${compactNumber(t.deletions ?? 0)} 删`,
    // Ordered so the actionable verdict is first: "missing" is the only one that
    // means the index is behind. "excluded" next to it, because a reader who sees
    // only "not indexed" will otherwise read it as a defect.
    verdicts: [
      { key: 'indexed', label: '已索引', value: v.indexed, tone: 'done' },
      { key: 'missing', label: '索引缺失', value: v.missing, tone: v.missing > 0 ? 'warning' : 'idle' },
      { key: 'excluded', label: '有意排除', value: v.excluded, tone: 'idle' },
    ],
  };
}

/**
 * One touched file, with its verdict as a tag.
 *
 * The verdict tag is the whole point of the row: a path alone cannot tell a reader
 * whether the graph knows about it.
 * @param {{file: any}} props
 */
function ActivityFileRow({ file }: { file: ClientActivityFile }) {
  const tone = file.verdict === 'indexed' ? 'solid' : file.verdict === 'missing' ? 'outline' : 'neutral';
  const label = file.verdict === 'indexed' ? '已索引' : file.verdict === 'missing' ? '缺失' : '排除';
  return h(
    'div',
    { style: styles.fileRow },
    h(FileTypeIcon, { path: file.path, size: 16 }),
    h('span', { style: { minWidth: 0, flex: '1 1 auto' } }, h(PathLabel, { path: file.path })),
    h(
      'span',
      { style: styles.fileMeta },
      h(Tag, { tone }, label),
      h('span', { style: { ...MUTED, whiteSpace: 'nowrap' } }, `${file.changes}×`),
    ),
  );
}

/**
 * Git activity, crossed with the index.
 *
 * Body only — the card and its disclosure header come from `CollapsibleCard`. The
 * header's collapsed line still carries the number that matters, so a reader who
 * never expands it learns whether recent work is visible to the graph.
 * @param {{activity: any}} props
 */
function GitActivitySection({ activity: rawActivity }: { activity: ClientActivity | null | undefined }) {
  // Narrowed to a local const before use. `activityView` returns null for an absent
  // activity, but TypeScript cannot carry that back to the parameter, so every later
  // read would need its own guard — and a guard per read is how one gets forgotten.
  const activity = rawActivity;
  const view = activityView(activity);
  if (view === null || activity === null || activity === undefined) {
    return h('div', { style: { ...MUTED } }, 'Git 活动不可用');
  }
  const missing = view.verdicts.find((v) => v.key === 'missing')?.value ?? 0;

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '4px' } },
    h('div', { style: MUTED }, view.totals),
    view.truncated
      ? h('div', { style: MUTED }, `活动窗口达到提交上限，更早的改动未统计`)
      : null,

    h(MetricGrid, {
      items: view.verdicts.map((v) => ({ label: v.label, value: compactNumber(v.value), state: v.tone })),
    }),

    // Commit activity over time. Placed above the file lists because "when" is
    // what makes the rest legible: a hot file means something different in a
    // burst week than in a slow one.
    activity.histogram !== undefined && activity.histogram !== null
      ? h(Histogram, { histogram: activity.histogram })
      : null,

      // Missing files come from their own list, not from the display-capped
      // by-changes slice — otherwise the summary can report a count with no rows.
      missing > 0 && Array.isArray(activity.missingFiles) && activity.missingFiles.length > 0
        ? h(
            'div',
            null,
            h('div', { style: { ...MUTED, marginBottom: '4px' } }, '应被索引却缺失'),
            activity.missingFiles
              .slice(0, 8)
              .map((file) => h(ActivityFileRow, { key: file.path, file })),
          )
        : null,

      Array.isArray(activity.byChanges) && activity.byChanges.length > 0
        ? h(
            'div',
            null,
            h('div', { style: { ...MUTED, marginBottom: '4px' } }, '改动最频繁'),
            activity.byChanges
              .filter((f) => f.verdict !== 'excluded')
              .slice(0, 8)
              .map((file) => h(ActivityFileRow, { key: file.path, file })),
          )
        : null,

      Array.isArray(activity.byRecency) && activity.byRecency.length > 0
        ? h(
            'div',
            null,
            h('div', { style: { ...MUTED, marginBottom: '4px' } }, '最近改动'),
            activity.byRecency
              .filter((f) => f.verdict !== 'excluded')
              .slice(0, 5)
              .map((file) => h(ActivityFileRow, { key: file.path, file })),
          )
        : null,

      Array.isArray(activity.authors) && activity.authors.length > 0
        ? h(
            'div',
            null,
            h('div', { style: { ...MUTED, marginBottom: '4px' } }, '提交者'),
            activity.authors.slice(0, 6).map((author) =>
              h(
                'div',
                { key: `${author.name}-${author.email}`, style: styles.fileRow },
                h('span', { style: { minWidth: 0, flex: '1 1 auto' } }, author.name),
                h(
                  'span',
                  { style: styles.fileMeta },
                  author.bot ? h(Tag, { tone: 'neutral' }, 'bot') : null,
                  h('span', { style: { ...MUTED, whiteSpace: 'nowrap' } }, `${author.commits} 提交`),
                  h('span', { style: { ...MUTED, whiteSpace: 'nowrap' } }, `${author.files} 文件`),
                ),
              ),
            ),
          )
        : null,

      Array.isArray(activity.branches) && activity.branches.length > 0
        ? h(
            'div',
            null,
            h('div', { style: { ...MUTED, marginBottom: '4px' } }, `分支 · ${activity.branches.length}`),
            activity.branches.slice(0, 6).map((branch) =>
              h(
                'div',
                { key: branch.name, style: styles.fileRow },
                h('span', { style: { minWidth: 0, flex: '1 1 auto', ...styles.mono } }, branch.name),
                h(
                  'span',
                  { style: styles.fileMeta },
                  branch.current ? h(Tag, { tone: 'solid' }, '当前') : null,
                  h(
                    'span',
                    { style: { ...MUTED, whiteSpace: 'nowrap' } },
                    branch.lastCommitDate ? branch.lastCommitDate.slice(0, 10) : '',
                  ),
                ),
              ),
            ),
          )
        : null,
  );
}

/**
 * Resolve the project this panel is about.
 *
 * The panel shows the project the operator is *in*, not a global list of indexed
 * repositories. A registry-driven picker was the first design and it was wrong for
 * the job: it made `~/.gitnexus/registry.json` a hard dependency, so a fresh clone,
 * a second working tree, or an index built with `GITNEXUS_HOME` redirected simply
 * could not be shown — which is exactly when a coverage panel is most useful.
 *
 * The path comes from the session's own `cwd`, selected out of the session snapshot:
 *
 *     useSessions((sessions) => sessions.byId[sessionId]?.cwd)
 *
 * That is the shipped pattern, read off `dsh-client-ui-sidebar-files`, whose body
 * sits in this same slot and needs the same answer. An earlier revision guessed at
 * `useWorkspaces` and the panel rendered "未解析到工作区" — a hook that exists is not
 * the same as the hook that carries this value.
 *
 * @param {{ params?: {repo?: string}, sessionId?: string, useSessions?: Function, useWorkspaces?: Function }} props
 * @returns {string | null}
 */
function useProjectPath(props: SlotProps): string | null {
  // A caller that opened the tab with an explicit repo wins, so `openTab` stays
  // usable for previewing a project other than the session's.
  const explicit = props?.params?.repo;
  const sessionId = props?.sessionId;

  // Hooks must be called unconditionally: a host that supplies neither still needs
  // the calls to happen, so a no-op of the same shape stands in rather than a
  // branch around the hook.
  const selectSession = typeof props?.useSessions === 'function' ? props.useSessions : () => null;
  const fromSession = selectSession((sessions) =>
    typeof sessionId === 'string' ? sessions?.byId?.[sessionId]?.cwd ?? null : null,
  );

  const selectWorkspace = typeof props?.useWorkspaces === 'function' ? props.useWorkspaces : () => null;
  const fromWorkspace = selectWorkspace((snapshot) => {
    const list = snapshot?.workspaces;
    if (!Array.isArray(list) || typeof sessionId !== 'string') return null;
    const mine = list.find((w) => Array.isArray(w?.sessionIds) && w.sessionIds.includes(sessionId));
    return typeof mine?.cwd === 'string' && mine.cwd !== '' ? mine.cwd : null;
  });

  if (typeof explicit === 'string' && explicit !== '') return explicit;
  if (typeof fromSession === 'string' && fromSession !== '') return fromSession;
  return typeof fromWorkspace === 'string' && fromWorkspace !== '' ? fromWorkspace : null;
}

/**
 * Which context props actually arrived.
 *
 * Rendered only when the project could not be resolved. Without it the panel can
 * only say "no project", which is a dead end for whoever has to fix it — with it,
 * one screenshot names the missing input.
 *
 * @param {any} props
 * @returns {string[]}
 */
function contextDiagnostic(props: SlotProps): ContextDiagnostic {
  const present: string[] = [];
  const absent: string[] = [];
  const note = (name: string, ok: boolean): void => {
    (ok ? present : absent).push(name);
  };
  note('sessionId', typeof props?.sessionId === 'string' && props.sessionId !== '');
  note('useSessions', typeof props?.useSessions === 'function');
  note('useWorkspaces', typeof props?.useWorkspaces === 'function');
  note('useTabInfo', typeof props?.useTabInfo === 'function');
  note('params.repo', typeof props?.params?.repo === 'string');
  return { present, absent };
}

/**
 * The maintenance commands, shown verbatim rather than executed.
 *
 * The plugin deliberately does not run these. Spawning `gitnexus analyze` from a
 * plugin bypasses the host's permission system: nothing would ask the operator
 * whether a thirty-minute write against their working tree was intended. Handing
 * over the exact command keeps the decision — and the approval — on the path the
 * product already audits.
 *
 * Which one is *relevant* depends on whether an index exists, so the applicable
 * command is marked. Presenting both with equal weight on an already-indexed
 * project reads as "you may need to initialize this", which is not true.
 *
 * @param {{maintenance: any, projectPath: string | null, indexed: boolean}} props
 */
function MaintenanceSection({ maintenance, projectPath, indexed }: { maintenance: ClientMaintenance; projectPath: string | null; indexed: boolean }) {
  // `projectPath` is part of the prop set for the header, which builds the commands
  // from it; the body does not read it.
  void projectPath;
  const [copied, setCopied] = React.useState<string | null>(null);
  const commands = Array.isArray(maintenance?.commands) ? maintenance.commands : [];
  if (commands.length === 0) return null;

  const applicable = indexed ? 'full' : 'init';

  const copy = (command: ClientMaintenanceCommand): void => {
    const write =
      typeof primitives.writeClipboard === 'function'
        ? primitives.writeClipboard
        : (text: string) => navigator.clipboard?.writeText(text);
    try {
      const outcome = write(command.shell);
      if (outcome && typeof outcome.then === 'function') {
        outcome.then(() => setCopied(command.mode)).catch(() => setCopied(null));
      } else {
        setCopied(command.mode);
      }
    } catch {
      setCopied(null);
    }
  };

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '4px' } },
    h('div', { style: MUTED }, '在会话中执行（沙箱与提权由 DSH 处理）'),
    commands.map((command) =>
      h(
        'div',
        {
          key: command.mode,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '3px',
            // The inapplicable one stays visible — an operator may still want the
            // text — but recedes.
            opacity: command.mode === applicable ? 1 : 0.55,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { fontWeight: 600 } }, command.label),
          command.mode === applicable ? h(Tag, { tone: 'solid' }, '当前适用') : null,
          command.destructive ? h(Tag, { tone: 'outline' }, '破坏性') : null,
          h('span', { style: { flex: 1 } }),
          h(
            Button,
            { variant: 'ghost', onClick: () => copy(command) },
            copied === command.mode ? '已复制' : '复制',
          ),
        ),
        h(
          'code',
          {
            style: {
              ...styles.mono,
              display: 'block',
              padding: '6px 8px',
                border: HAIRLINE,
                borderRadius: '6px',
                background: SOFT_BG,
                wordBreak: 'break-all',
                userSelect: 'all',
              },
            },
            command.shell,
          ),
          h('div', { style: MUTED }, command.when),
          command.caveat !== null && command.caveat !== undefined
            ? h('div', { style: MUTED }, command.caveat)
            : null,
        ),
      ),
      Array.isArray(maintenance?.rationale) && maintenance.rationale.length > 0
        ? h(
            'div',
            { style: { ...MUTED, display: 'flex', flexDirection: 'column', gap: '2px' } },
            maintenance.rationale.map((note, index) => h('div', { key: index }, `· ${note}`)),
          )
        : null,
  );
}

/**
 * The panel body registered into `sidebar.right.pane.tab`.
 *
 * Split in two on purpose. `CoveragePanel` owns fetching and state;
 * `CoverageView` is a pure function of its props. The split is what makes the
 * populated view testable at all: a component that fetches cannot be rendered
 * against a fixture, and the states worth asserting on — a report with skipped
 * files, one without, an error, missing language data — are exactly the ones a
 * fixture supplies.
 *
 * @param {{
 *   report: any,
 *   repos: any[],
 *   repo: string | null,
 *   busy: boolean,
 *   error: string | null,
 *   onSelect: (path: string) => void,
 *   onRefresh: () => void,
 * }} props
 */
interface CoverageViewProps {
  report: ClientReport | null;
  maintenance: ClientMaintenance | null | undefined;
  projectPath: string | null;
  context: ContextDiagnostic | null;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
}

function CoverageView({
  report,
  maintenance,
  projectPath,
  context,
  busy,
  error,
  onRefresh,
}: CoverageViewProps) {
  // Whether an index exists decides which maintenance command is applicable. When
  // the project could not even be identified there is nothing to claim, so it is
  // false rather than assumed.
  const indexed = report?.repo?.indexed === true;
  const header = h(
    Row,
    null,
    report !== null && report.repo?.indexed ? h(StateDot, { state: healthState(report) }) : null,
    h('span', { style: { fontWeight: 600 } }, 'GitNexus 索引'),
    // The project, not a picker. Shown so the reader can confirm which tree the
    // numbers describe — a path is the only unambiguous answer to that.
    projectPath === null
      ? h('span', { style: MUTED }, '未解析到工作区')
      : h(
          'span',
          { style: { minWidth: 0, flex: '1 1 auto' } },
          h(PathLabel, { path: projectPath }),
        ),
    h('span', { style: { flex: 1 } }),
    h(
      Button,
      { variant: 'ghost', onClick: onRefresh, disabled: busy, 'aria-label': '刷新' },
      h(IconRefreshOutlineRegular, { size: 14 }),
    ),
  );

  // "I cannot tell which project this is" and "this project has no index" are
  // different facts, and the first revision conflated them: an unresolved project
  // fell through to the no-index branch and told the operator to initialise an
  // index for a project it had not identified. The diagnostic exists so that state
  // is actionable rather than a dead end.
  if (projectPath === null) {
    return h(
      'div',
      { style: styles.root },
      header,
      h(
        Section,
        { wide: true, style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
        h(StateDot, { state: 'warning' }),
        h('span', null, '未能确定当前项目路径。'),
      ),
      context === null || context === undefined
        ? null
        : h(
            Section,
            { wide: true, title: '面板收到的上下文' },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
              h('div', null, `存在：${context.present.length > 0 ? context.present.join('、') : '（无）'}`),
              h('div', null, `缺失：${context.absent.length > 0 ? context.absent.join('、') : '（无）'}`),
            ),
          ),
    );
  }

  if (error !== null) {
    return h(
      'div',
      { style: styles.root },
      header,
      h(
        Section,
        { wide: true, style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
        h(StateDot, { state: 'error' }),
        h('span', null, error),
      ),
      maintenance === null || maintenance === undefined
        ? null
        : h(
            Section,
            {
              wide: true,
              title: '维护命令',
              meta: h('span', { style: { ...MUTED, fontSize: '11px' } }, '复制后到会话执行（沙箱与提权由 DSH 处理）'),
            },
            h(MaintenanceSection, { maintenance, projectPath, indexed: false }),
          ),
    );
  }

  if (report === null) {
    return h('div', { style: styles.root }, header, h('div', { style: MUTED }, '正在读取索引…'));
  }

  // No index yet. This is the state the initialize command exists for, so the
  // panel leads with the command rather than an error.
  if (report.repo?.indexed !== true) {
    return h(
      'div',
      { style: styles.root },
      header,
      h(
        Section,
        { wide: true, style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
        h(StateDot, { state: 'idle' }),
        h('span', null, '该项目还没有 GitNexus 索引。'),
      ),
      maintenance === null || maintenance === undefined
        ? null
        : h(
            Section,
            {
              wide: true,
              title: '初始化索引',
              meta: h('span', { style: { ...MUTED, fontSize: '11px' } }, '复制后到会话执行（沙箱与提权由 DSH 处理）'),
            },
            h(MaintenanceSection, { maintenance, projectPath, indexed }),
          ),
    );
  }

  // Past this point an index exists, and the host builds these blocks
  // unconditionally for one. Defaulting them once here beats a `?? []` at each of
  // twenty read sites — and a default repeated twenty times is one that will
  // eventually be forgotten at the twenty-first.
  const totals = report.totals ?? ZERO_TOTALS;
  const cap = report.cap ?? ZERO_CAP;
  const analyzer = report.analyzer ?? ZERO_ANALYZER;
  const largeFiles = report.largeFiles ?? [];

  const { notable, context: contextWarnings } = splitWarnings(report.warnings);
  const ratio = coverageRatio(report);
  const languages = report.languages ?? null;

  return h(
    'div',
    { style: styles.root },
    // The header and the two status lines span everything: they describe the whole
    // panel, so giving them a column would make them look like one card's heading.
    h('div', { style: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '6px' } }, header),

    h(
      'div',
      { style: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '3px' } },
      h(
        'div',
        { style: MUTED },
        `${report.repo.indexedAt ?? '未知时间'} · ${report.repo.branch ?? 'unknown'}@${String(report.repo.lastCommit ?? '').slice(0, 8)}` +
          ` · manifest ${report.repo.metaFile ?? '?'} · GitNexus ${analyzer.gitnexusVersion}`,
      ),
      // Freshness against HEAD. The line above states the *indexed* commit, which
      // reads as current unless this one says otherwise.
      report.staleness === undefined
        ? null
        : (() => {
            const s = stalenessView(report.staleness);
            return h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              h(StateDot, { state: s.state }),
              h('span', null, s.text),
            );
          })(),
    ),

    // One card for the whole "what is this index" question — file coverage and
    // graph contents together.
    //
    // They were two cards. Side by side, the ring made the coverage card tall while
    // its three metrics stayed short, so the card carried a band of dead space; and
    // splitting them forced a reader to assemble one answer from two boxes. They are
    // the same fact at two resolutions: what went in, and what came out.
    h(
      Section,
      {
        title: '索引概览',
        meta:
          report.graph === null || report.graph === undefined
            ? null
            : h('span', { style: { ...MUTED, fontSize: '11px' } }, `${fixed(report.graph.edgesPerNode, 2)} 边/符号`),
      },
      h(
        'div',
        { style: { display: 'flex', gap: '16px', alignItems: 'flex-start' } },
        ratio === null
          ? null
          : h(Ring, {
              ratio,
              caption: '覆盖',
              tone: ratio >= 0.9 ? 'var(--dsw-color-success, #3fb950)' : 'var(--dsw-color-warning, #d9a441)',
            }),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '9px', minWidth: 0, flex: '1 1 auto' } },
          h('div', { style: MUTED }, summaryLine(report)),

          // Files in, graph out — the two halves sit side by side so the wide card
          // is used rather than merely filled.
          h(
            'div',
            { style: { display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'flex-start' } },
            h(
              'div',
              { style: { minWidth: '200px', flex: '1 1 auto' } },
              h('div', { style: { ...MUTED, marginBottom: '5px' } }, '文件'),
              h(MetricGrid, {
                items: [
                  { label: '大小上限', value: cap.text, hint: cap.source },
                  { label: '跳过合计', value: fileSize(totals.largeBytes) },
                  { label: '超限文件', value: compactNumber(totals.large) },
                ],
              }),
            ),
            report.graph === null || report.graph === undefined
              ? null
              : h(
                  'div',
                  { style: { minWidth: '240px', flex: '1 1 auto' } },
                  h('div', { style: { ...MUTED, marginBottom: '5px' } }, '图谱'),
                  h(MetricGrid, {
                    items: [
                      { label: '符号', value: compactNumber(report.graph.nodes) },
                      { label: '边', value: compactNumber(report.graph.edges) },
                      { label: '社区', value: compactNumber(report.graph.communities) },
                      { label: '流程', value: compactNumber(report.graph.processes) },
                      { label: '向量', value: compactNumber(report.graph.embeddings) },
                    ],
                  }),
                ),
          ),

          h(
            'div',
            { style: { borderTop: HAIRLINE, paddingTop: '8px' } },
            h('div', { style: { ...MUTED, marginBottom: '5px' } }, '查询能力'),
            h(CapabilityStrip, { capabilities: report.capabilities }),
          ),
        ),
      ),
    ),

    // Shares a row with the overview card: a bar plus its legend is a proportional
    // reading, and pairing it with the coverage figure puts the two "how much of
    // this repository" answers side by side. Order matters — it must directly
    // follow the overview for the grid to place them in the same row.
    languages !== null && languages.rows.length > 0 ? h(LanguageSection, { languages }) : null,

    // Caveats, in one card, sharing a row with the provenance card.
    //
    // `notable` and `contextWarnings` were two cards — one amber, one an untitled
    // list of `·` lines. They are the same thing at two volumes: both say "this
    // index does not line up with the working tree". Splitting them made the reader
    // check two boxes to answer one question, and the untitled one had no heading
    // to say what it was.
    notable.length > 0 || contextWarnings.length > 0
      ? h(
          Section,
          {
            title: `需要注意 · ${notable.length + contextWarnings.length}`,
            style: { display: 'flex', flexDirection: 'column', gap: '8px' },
          },
          notable.map((warning, index) =>
            h(
              'div',
              {
                key: `${warning.code}-${index}`,
                style: {
                  display: 'flex',
                  gap: '7px',
                  alignItems: 'flex-start',
                  padding: '6px 8px',
                  border: '1px solid color-mix(in srgb, #d9a441 45%, transparent)',
                  background: 'color-mix(in srgb, #d9a441 9%, transparent)',
                  borderRadius: '6px',
                },
              },
              h(StateDot, { state: 'warning' }),
              h('span', { style: { minWidth: 0 } }, warning.message),
            ),
          ),
          // The milder ones stay quiet rows: giving every item an amber box would
          // make a stale-index count look as urgent as a truncated activity window.
          contextWarnings.length === 0
            ? null
            : h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    ...MUTED,
                    ...(notable.length > 0 ? { borderTop: HAIRLINE, paddingTop: '8px' } : {}),
                  },
                },
                contextWarnings.map((warning, index) =>
                  h('div', { key: `${warning.code}-${index}` }, `· ${warning.message}`),
                ),
              ),
        )
      : null,

    // Shares the row above. Resolver confidence is what makes the counts above it
    // lower bounds, so it belongs beside the caveats rather than after the charts.
    h(
      Section,
      {
        title: '解析质量与溯源',
        meta: h('span', { style: { ...MUTED, fontSize: '11px' } }, provenanceCollapsed(report.graphQuality ?? null)),
      },
      h(ProvenanceBlock, {
        quality: report.graphQuality ?? null,
        provenance: report.provenance ?? null,
      }),
    ),

    // Wide: file paths must keep their tails.
    largeFiles.length > 0
      ? h(
          Section,
          {
            wide: true,
            title: `被跳过的超大文件 · ${largeFiles.length} 个 · ${fileSize(totals.largeBytes)}`,
          },
          h(LargeFileList, { files: largeFiles.slice(0, 40) }),
          largeFiles.length > 40
            ? h('div', { style: { ...MUTED, marginTop: '6px' } }, `…另有 ${largeFiles.length - 40} 个未显示`)
            : null,
        )
      : null,

    report.activity === undefined || report.activity === null
      ? null
      : h(
          Section,
          {
            wide: true,
            title: `Git 活动 · ${activityView(report.activity)?.window ?? ''}`,
            meta: h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', ...MUTED, fontSize: '11px' } },
              h(StateDot, {
                state:
                  activityView(report.activity)?.verdicts.find((v) => v.key === 'missing')?.tone ?? 'done',
              }),
              activityCollapsed(report.activity),
            ),
          },
          h(GitActivitySection, { activity: report.activity }),
        ),

    // Wide, and always open: the commands are the action this panel offers.
    maintenance === null || maintenance === undefined
      ? null
      : h(
          Section,
          {
            wide: true,
            title: '维护命令',
            meta: h(
              'span',
              { style: { ...MUTED, fontSize: '11px' } },
              `${maintenance.commands?.length ?? 0} 条 · 复制后到会话执行（沙箱与提权由 DSH 处理）`,
            ),
          },
          h(MaintenanceSection, { maintenance, projectPath, indexed }),
        ),
  );
}

/**
 * Stateful wrapper: resolves the current project, loads its coverage.
 *
 * No repository list and no picker. The panel answers for the project the operator
 * is in; a project with no index is a normal state that leads with the command to
 * create one, not an error.
 *
 * @param {{params?: {repo?: string}, sessionId?: string, useWorkspaces?: Function}} props
 */
function CoveragePanel(props: SlotProps) {
  const projectPath = useProjectPath(props);
  const [report, setReport] = React.useState<ClientReport | null>(null);
  const [maintenance, setMaintenance] = React.useState<ClientMaintenance | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [reloadToken, setReloadToken] = React.useState(0);

  React.useEffect(() => {
    if (projectPath === null) return undefined;
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    fetch(routeUrl(`/api/gitnexus/coverage?repo=${encodeURIComponent(projectPath)}`), {
      signal: controller.signal,
    })
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))
      .then(({ status, body }) => {
        // `not-indexed` is a state the panel renders, not a failure: the whole
        // point of leading with the initialize command is that reaching it is
        // expected on a project that has never been analysed.
        if (status === 404 && body?.code === 'not-indexed') {
          setReport({ repo: { indexed: false, path: projectPath } });
          setMaintenance(null);
          return;
        }
        if (!body?.ok) throw new Error(body?.message ?? `请求失败 (${status})`);
        setReport(body.report);
        setMaintenance(body.maintenance ?? null);
      })
      .catch((cause) => {
        if (cause?.name !== 'AbortError') setError(String(cause?.message ?? cause));
      })
      .finally(() => setBusy(false));
    return () => controller.abort();
  }, [projectPath, reloadToken]);

  const fallbackMaintenance = React.useMemo(
    () => (maintenance === null && projectPath !== null ? { commands: [], rationale: [] } : maintenance),
    [maintenance, projectPath],
  );

  return h(CoverageView, {
    report,
    maintenance: fallbackMaintenance,
    projectPath,
    context: projectPath === null ? contextDiagnostic(props) : null,
    busy,
    error,
    onRefresh: () => setReloadToken((n) => n + 1),
  });
}

/** The tab chip's live title. */
function CoverageTitle() {
  return h('span', null, 'GitNexus');
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Declared, not guessed: the loader hands `apply` a context carrying exactly
 * these, and reading anything else off `ctx` throws.
 *
 * `sidebarRightTabs` is deliberately absent and reached through `ctx.inject`
 * instead — it is an optional capability (a headless or TUI profile has no right
 * sidebar at all), and naming it here would leave this plugin permanently pending
 * on those profiles rather than simply contributing nothing.
 */
const inject = ['slots'];

/**
 * The client-side context this half is applied with.
 *
 * Narrowed to exactly what is used. The real context is the platform's, whose full
 * surface is much larger and is not published with types — declaring only these
 * members keeps the check meaningful instead of `any`.
 */
interface SlotsContext {
  slots: {
    inject(name: string, callback: () => unknown): void;
    register(spec: { name: string; key: string }, component: unknown): unknown;
  };
  effect(callback: () => () => void, label?: string): void;
  inject(deps: readonly string[], callback: (svcCtx: { sidebarRightTabs: SidebarRightTabs }) => void): void;
}

/** The sidebar-right tab registry service. */
interface SidebarRightTabs {
  register(spec: {
    id: string;
    kind: string;
    title: () => string;
    guide: Array<{ id: string; order: number; title: () => string; description: () => string }>;
  }): () => void;
}

function apply(ctx: SlotsContext): void {
  const safe = (tag: string, fn: () => void): void => {
    try {
      fn();
    } catch (cause) {
      // One unknown slot name must not take the rest of the surface down with it.
      console.warn(`[${PLUGIN_ID}] client surface '${tag}' failed:`, cause);
    }
  };

  safe('sidebarRightTabs', () => {
    ctx.inject(['sidebarRightTabs'], (svcCtx) => {
      ctx.effect(
        () =>
          svcCtx.sidebarRightTabs.register({
            id: PLUGIN_ID,
            kind: TAB_KIND,
            title: () => 'GitNexus',
            // The guide page is how a user discovers a contributed page type: it
            // renders one entry box per `guide` entry, and picking one opens this
            // kind. Without it the panel would be reachable only by a caller that
            // already knew the kind name.
            guide: [
              {
                id: `${PLUGIN_ID}:coverage`,
                order: 40,
                title: () => 'GitNexus 索引',
                description: () => '查看索引覆盖：被跳过的超大文件与语言分布',
              },
            ],
          }),
        `${PLUGIN_ID}: tab type`,
      );
    });
  });

  safe('sidebar.right.pane.tab', () => {
    ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PLUGIN_ID }, CoveragePanel),
    );
  });

  safe('sidebar.right.pane.tab.title', () => {
    ctx.slots.inject('sidebar.right.pane.tab.title', () =>
      ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: PLUGIN_ID }, CoverageTitle),
    );
  });
}

module.exports = {
  inject,
  apply,
  __internals: {
    PLUGIN_ID,
    TAB_KIND,
    routeUrl,
    formatBytes,
    fileSize,
    percent,
    stackSegments,
    splitWarnings,
    summaryLine,
    coverageRatio,
    healthState,
    stalenessView,
    capabilityRows,
    graphQualitySummary,
    activityView,
    compactNumber,
    useProjectPath,
    contextDiagnostic,
    CoveragePanel,
    CoverageView,
    CoverageTitle,
    LanguageBar,
    LanguageSection,
    LargeFileList,
    Ring,
    MetricGrid,
    Histogram,
    GitActivitySection,
    ProvenanceBlock,
    MaintenanceSection,
    CapabilityStrip,
    Section,
    classifyFileType,
    IconRefreshOutlineRegular,
  },
};
