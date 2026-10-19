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
  /** Present on a scan-only report; older hosts may omit it. */
  scannedBytes?: number;
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
  /** `builtin` means GitNexus was unavailable and the extension map filled in. */
  detector?: 'gitnexus' | 'builtin';
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

/** One commit in the activity timeline. */
interface ClientActivityCommit {
  sha: string;
  shortSha?: string;
  date: string;
  author: string;
  subject: string;
  files: number;
  insertions: number;
  deletions: number;
  verdict: string;
}

/** One activity × index cross-tab row. */
interface ClientActivityCrossRow {
  verdict: string;
  files: number;
  changes: number;
  insertions: number;
  deletions: number;
}

/** Changes since the index's recorded baseline. */
interface ClientActivityBaseline {
  ref?: string | null;
  available?: boolean;
  shortSha?: string | null;
  date?: string | null;
  subject?: string | null;
  author?: string | null;
  commits?: number;
  files?: number;
  insertions?: number;
  deletions?: number;
  changedFiles?: ClientActivityFile[];
  reason?: string | null;
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
  cross?: { rows?: ClientActivityCrossRow[]; totalFiles?: number; totalChanges?: number };
  baseline?: ClientActivityBaseline | null;
  timeline?: ClientActivityCommit[];
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
  toolchain?: ClientToolchain | null;
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

/**
 * Whether GitNexus is present, as the host probed it.
 *
 * The panel offers to install only when the verdict is not `ready`, and it shows the
 * command **first**. "Let me install it for you" is a much larger decision than "here is
 * the command" — a few hundred megabytes and the package's build scripts running on this
 * machine — so it must not be the default an operator reaches for by accident.
 */
interface ClientToolchain {
  packageRoot: string | null;
  packageVersion: string | null;
  cli: { present: boolean; source?: string; viaNode?: boolean };
  verdict: 'ready' | 'library-only' | 'absent';
}

/** The maintenance payload that rides along with a report. */
interface ClientMaintenance {
  commands?: ClientMaintenanceCommand[];
  rationale?: string[];
  /**
   * Absent on hosts that predate `force=1`. The full-rebuild button is gated on it:
   * against such a host the flag is ignored, so the button would run an incremental
   * refresh under a full-rebuild label.
   */
  supportsForce?: boolean;
}

/**
 * A refresh the panel started, as the host reports it.
 *
 * `state` is a union rather than a boolean because the interesting outcomes are the
 * ones that are neither success nor failure: `denied` means the sandbox refused and
 * this plugin will not escalate, `unavailable` means the deployment has no shell or no
 * GitNexus — an operator acts on those differently from a crash.
 */
interface ClientAnalyzeRun {
  state: 'unavailable' | 'running' | 'done' | 'failed' | 'timed-out' | 'cancelled' | 'denied';
  /** Whether this run was the `--force` full rebuild. Older hosts omit it. */
  force?: boolean;
  command: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  message: string | null;
  output: string;
}

/**
 * One keyword hit from the graph search.
 *
 * `kind` is GitNexus's node label (Function, Class, File, …), not a translated
 * category: preserving the index's own vocabulary is what lets a reader compare a
 * hit against `context`/`impact` output.
 */
interface ClientSearchHit {
  kind: string;
  name: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}

/**
 * The slice of the right-sidebar controller this panel uses to open a file.
 *
 * `openResource` is the public navigation method: it claims a `dsh-resource://`
 * address and reveals the column. `openResourceIn` is the session-targeted variant
 * the controller also implements; the panel prefers it so a click lands in the
 * session whose tab it belongs to, not merely the one on screen.
 */
interface SidebarRightOpenOptions {
  params?: Record<string, unknown>;
}

interface SidebarRightApi {
  openResource(address: string, options?: SidebarRightOpenOptions): void;
  openResourceIn?(sessionId: string, address: string, options?: SidebarRightOpenOptions): void;
}

type OpenResource = (address: string, options?: SidebarRightOpenOptions) => void;
type OpenResourceIn = (
  sessionId: string,
  address: string,
  options?: SidebarRightOpenOptions,
) => void;

/** Captured from `ctx.inject(['sidebarRight'])`; null when the profile has no column. */
let openResource: OpenResource | null = null;
let openResourceIn: OpenResourceIn | null = null;

/**
 * Build the platform's file resource address.
 *
 * The address is `dsh-resource://file/session/<session>/<path>`, exactly what the
 * built-in file strip and the chat's file links use. Relative paths resolve through
 * that session's workspace, which is the project this panel is reporting on. The
 * encoding keeps `:` literal so a Windows drive letter survives, and encodes each
 * segment separately so `/` stays a path separator.
 */
function fileResourceAddress(sessionId: string, filePath: string): string {
  const encodeSegment = (segment: string): string =>
    encodeURIComponent(segment).replace(/%3A/gi, ':');
  const normalized = filePath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${normalized
    .split('/')
    .map(encodeSegment)
    .join('/')}`;
}

/** The search card's state, supplied by `CoveragePanel` and rendered by the view. */
interface SearchViewState {
  query: string;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  searching: boolean;
  error: string | null;
  /** `graph` for the index query, `text` for the source fallback. */
  mode: 'graph' | 'text' | null;
  /** `null` until a search has run; `[]` means it ran and found nothing. */
  results: ClientSearchHit[] | null;
  /** Open a hit in the platform's file viewer at its line. */
  onOpen: (hit: ClientSearchHit) => void;
  total: number;
  truncated: boolean;
  warning: string | null;
  copied: string | null;
  onCopy: (hit: ClientSearchHit) => void;
}

/**
 * An install of GitNexus the panel started.
 *
 * The same states as a refresh minus the ones that cannot happen: an install never
 * reports `denied` for a *permission* the operator could grant in the session — a
 * sandbox refusal is reported and not retried, exactly like everywhere else.
 */
interface ClientInstallRun {
  state: 'unavailable' | 'running' | 'done' | 'failed' | 'timed-out' | 'cancelled' | 'denied';
  command: string;
  prefix: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  message: string | null;
  output: string;
}

/**
 * How a run's state reads at a glance.
 *
 * Typed to the primitive's own union rather than `string`, so a state added to
 * `ClientAnalyzeRun` without a mapping here fails to compile instead of rendering a
 * dot the primitive silently falls back on.
 */
function runStateTone(state: ClientAnalyzeRun['state']): primitives.StateDotState {
  switch (state) {
    case 'done':
      return 'done';
    case 'running':
      // The primitive spells this `ongoing`; the host calls it `running`.
      return 'ongoing';
    case 'cancelled':
      return 'idle';
    // Not errors: the sandbox did its job, and the operator's next step is to run the
    // command themselves rather than to investigate a failure.
    case 'denied':
    case 'unavailable':
      return 'warning';
    default:
      return 'error';
  }
}

function runStateLabel(state: ClientAnalyzeRun['state']): string {
  switch (state) {
    case 'unavailable':
      return '无法执行';
    case 'running':
      return '刷新中';
    case 'done':
      return '已完成';
    case 'failed':
      return '失败';
    case 'timed-out':
      return '超时终止';
    case 'cancelled':
      return '已取消';
    case 'denied':
      return '沙箱拒绝';
  }
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
  scannedBytes: 0,
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

/**
 * The cap's provenance, in the panel's language. The host reports stable English
 * keys (`index` / `env` / `default`); showing those raw put an English word in the
 * middle of a Chinese metric row, measured in the real panel as "512.0 KB index".
 */
function capSourceLabel(source: string): string {
  switch (source) {
    case 'index':
      return '索引记录';
    case 'env':
      return '环境变量';
    case 'default':
      return '默认值';
    default:
      return source;
  }
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
      // Says where the action lives, not that one is available nearby. The previous
      // wording — "可直接增量刷新" — sat directly under the panel's refresh button and
      // read as an instruction to press it, while that control only re-reads the
      // report and never touches the index. Pointing at the maintenance commands
      // costs one clause and stops the panel promising something it does not do.
      return {
        state: 'warning',
        text: `behind · 索引落后 ${ahead} 个提交（${indexed} → ${head}）· 重建见下方「维护命令」${dirty}`,
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
 * A single column is the honest layout for a docked sidebar. The previous
 * `auto-fit` grid asked for two columns whenever the pane was wide enough for
 * `2 × 620px + gap`; in a real narrow sidebar it therefore laid the second column —
 * the entire language breakdown — past the visible edge, and the wide Git-activity
 * card lost its third verdict. Tuning the floor only moves which pane width breaks;
 * one column always fits. On a wide pane the card internals still distribute their
 * metrics, so the space is not wasted.
 *
 * `minmax(0, 1fr)` also removes the min-content floor that let the grid widen its
 * own container. A card that needs the full width still says so with
 * `gridColumn: '1 / -1'`, which is harmless in one column and keeps the markup
 * honest if the layout ever changes.
 */
const styles = {
  root: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    // No `alignItems: start`: grid items stretch to the row height by default, so
    // two cards sharing a row end level. With `start` each card took its natural
    // height and the row showed a ragged bottom edge.
    gap: '10px',
    padding: '12px',
    fontSize: '12px',
    lineHeight: 1.5,
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    overflowY: 'auto',
    // A card that overflows must be scrolled to, not painted outside the pane and
    // mistaken for a neighbouring surface.
    overflowX: 'hidden',
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

  // One bucket is not a time series. Drawing it produced a full-width, full-height
  // rectangle that read as a skeleton or a broken chart — measured on this
  // repository, whose entire history fits in one week. The totals directly above
  // already say the same number, so state the bucket instead of drawing it.
  if (buckets.length === 1) {
    const only = buckets[0];
    return h(
      'div',
      { style: { ...MUTED, display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('span', null, `${only.label} 起这一${bucketDays === 7 ? '周' : '天'}`),
      h('span', null, `${only.commits} 次提交`),
      h('span', null, `+${compactNumber(only.insertions)} / -${compactNumber(only.deletions)}`),
    );
  }

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
              // Bars do not grow past a readable width on a wide pane; a two-bucket
              // chart otherwise stretches each bar across half the card.
              maxWidth: '56px',
              // A zero bucket keeps a visible floor so a gap reads as "no commits"
              // rather than as missing data.
              height: `${Math.max(2, (bucket.commits / max) * height)}px`,
              // The host's real token. The first version invented `--dsw-color-accent`,
              // which does not exist, so every bar fell back to `currentColor` and the
              // chart rendered as a grey block in both themes.
              background:
                bucket.commits === 0
                  ? 'currentColor'
                  : 'var(--dsw-alias-brand-primary, currentColor)',
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
      languages.detector === 'builtin'
        ? `按${unit}计的占比；GitNexus 不可用，语言由内置扩展名映射识别（仅作参考）`
        : `按${unit}计的占比；GitNexus 只解析其中一部分语言，其余仅作为文件节点存在`,
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

/** Shared labels/tones for the three activity verdicts. */
function activityVerdict(verdict: string): { label: string; tone: 'solid' | 'outline' | 'neutral'; dot: DotState } {
  if (verdict === 'indexed') return { label: '已索引', tone: 'solid', dot: 'done' };
  if (verdict === 'missing') return { label: '索引缺失', tone: 'outline', dot: 'warning' };
  return { label: '设计排除', tone: 'neutral', dot: 'idle' };
}

/**
 * The three-way verdict with the volume behind it.
 *
 * The old UI had counts only, which made "2 missing" look as urgent as "2 excluded"
 * even when the missing files accounted for 40 commits. This table adds the volume
 * without changing the verdict definition.
 */
function ActivityCrossTable({ cross }: { cross: NonNullable<ClientActivity['cross']> }) {
  const rows = Array.isArray(cross.rows) ? cross.rows : [];
  if (rows.length === 0) return null;
  const cell = { padding: '3px 0', textAlign: 'right' as const };
  return h(
    'div',
    null,
    h(
      'div',
      { style: { ...MUTED, marginBottom: '4px' } },
      `活动 × 索引交叉对比 · ${compactNumber(cross.totalFiles ?? 0)} 文件 / ` +
        `${compactNumber(cross.totalChanges ?? 0)} 次变更`,
    ),
    h(
      'div',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.5fr) repeat(4, minmax(0, 0.65fr))',
          gap: '4px',
          alignItems: 'center',
          fontSize: '10px',
        },
      },
      h('span', { style: MUTED }, '分类'),
      h('span', { style: { ...MUTED, ...cell } }, '文件'),
      h('span', { style: { ...MUTED, ...cell } }, '变更'),
      h('span', { style: { ...MUTED, ...cell } }, '+行'),
      h('span', { style: { ...MUTED, ...cell } }, '−行'),
      rows.map((row) => {
        const verdict = activityVerdict(row.verdict);
        return [
          h(
            'span',
            { key: `${row.verdict}-label`, style: { display: 'flex', alignItems: 'center', gap: '5px' } },
            h(StateDot, { state: verdict.dot }),
            verdict.label,
          ),
          h('span', { key: `${row.verdict}-files`, style: cell }, compactNumber(row.files)),
          h('span', { key: `${row.verdict}-changes`, style: cell }, compactNumber(row.changes)),
          h('span', { key: `${row.verdict}-ins`, style: cell }, `+${compactNumber(row.insertions)}`),
          h('span', { key: `${row.verdict}-del`, style: cell }, `−${compactNumber(row.deletions)}`),
        ];
      }),
    ),
  );
}

/** HEAD against the commit the index was built from. */
function ActivityBaseline({ baseline }: { baseline: ClientActivityBaseline }) {
  const changedFiles = Array.isArray(baseline.changedFiles) ? baseline.changedFiles : [];
  const short = baseline.shortSha ?? baseline.ref?.slice(0, 8) ?? '未知';
  const date = typeof baseline.date === 'string' ? baseline.date.slice(0, 10) : '';
  return h(
    'div',
    null,
    h(
      'div',
      { style: { ...MUTED, marginBottom: '4px' } },
      `索引基线审查 · ${short}${date === '' ? '' : ` · ${date}`}`,
    ),
    baseline.available === false
      ? h(
          'div',
          { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } },
          h(StateDot, { state: 'warning' }),
          h('span', null, baseline.reason ?? '基线提交不可读'),
        )
      : h(
          'div',
          { style: { ...MUTED } },
          (baseline.commits ?? 0) === 0 && (baseline.files ?? 0) === 0
            ? '工作区与索引基线一致，没有新增变更。'
            : `自基线以来 ${compactNumber(baseline.commits ?? 0)} 个提交 · ` +
              `${compactNumber(baseline.files ?? 0)} 个文件 · ` +
              `+${compactNumber(baseline.insertions ?? 0)} / −${compactNumber(baseline.deletions ?? 0)}`,
        ),
    changedFiles.length > 0
      ? h(
          'div',
          { style: { marginTop: '4px' } },
          changedFiles.slice(0, 8).map((file) => h(ActivityFileRow, { key: file.path, file })),
        )
      : null,
  );
}

/** Newest-first commit list with per-commit index verdict. */
function ActivityTimeline({
  timeline,
  indexKnown,
}: {
  timeline: ClientActivityCommit[];
  indexKnown: boolean;
}) {
  if (timeline.length === 0) return null;
  return h(
    'div',
    null,
    h('div', { style: { ...MUTED, marginBottom: '4px' } }, `提交时间线 · 最近 ${timeline.length} 个`),
    timeline.slice(0, 15).map((commit) => {
      const verdict = indexKnown
        ? activityVerdict(commit.verdict)
        : { label: '索引未知', tone: 'neutral' as const, dot: 'idle' as const };
      return h(
        'div',
        {
          key: commit.sha,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            padding: '4px 0',
            borderTop: HAIRLINE,
            minWidth: 0,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
          h(StateDot, { state: verdict.dot }),
          h(
            'span',
            { style: { ...styles.mono, color: 'inherit', whiteSpace: 'nowrap' } },
            commit.shortSha ?? commit.sha.slice(0, 8),
          ),
          h(
            'span',
            {
              style: {
                minWidth: 0,
                flex: '1 1 auto',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
              title: commit.subject,
            },
            commit.subject === '' ? '(无提交说明)' : commit.subject,
          ),
        ),
        h(
          'div',
          {
            style: {
              ...MUTED,
              fontSize: '10px',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '6px',
              marginLeft: '14px',
            },
          },
          h(Tag, { tone: verdict.tone }, verdict.label),
          h('span', { style: { whiteSpace: 'nowrap' } }, commit.date.slice(0, 10)),
          h('span', { style: { whiteSpace: 'nowrap' } }, commit.author),
          h(
            'span',
            { style: { whiteSpace: 'nowrap' } },
            `+${compactNumber(commit.insertions)}/−${compactNumber(commit.deletions)}`,
          ),
          h(
            'span',
            { style: { whiteSpace: 'nowrap' } },
            `${compactNumber(commit.files)} 文件`,
          ),
        ),
      );
    }),
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

    // Three views over the same window: what the index sees, what changed since the
    // index baseline, and the individual commits in order. Old hosts omit these
    // fields; each block disappears rather than rendering a false empty state.
    activity.totals?.indexKnown === false
      ? h(
          'div',
          { style: { ...MUTED } },
          '项目尚未建立索引：无法把活动文件与图谱交叉，也没有索引基线可审查。',
        )
      : activity.cross !== undefined && activity.cross !== null
        ? h(ActivityCrossTable, { cross: activity.cross })
        : null,
    activity.baseline !== undefined && activity.baseline !== null
      ? h(ActivityBaseline, { baseline: activity.baseline })
      : null,
    h(ActivityTimeline, {
      timeline: Array.isArray(activity.timeline) ? activity.timeline : [],
      indexKnown: activity.totals?.indexKnown === true,
    }),

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
/**
 * What the panel says when GitNexus is not on this machine.
 *
 * THE ORDER IS THE DESIGN
 * -----------------------
 * The install command comes first and is copyable, because that is the answer for most
 * operators: they know their network, their registry and their toolchain, and a command
 * they can run is more useful than a download this plugin performs on their behalf. The
 * plugin-install option is second and behind a confirmation, because making a
 * several-hundred-megabyte download the path of least resistance would be the wrong
 * default for a panel whose job is to report, not to act.
 *
 * Nothing renders when the verdict is `ready` — a permanent "GitNexus is fine" banner is
 * noise in a panel whose whole purpose is to surface problems.
 */
function ToolchainNotice({
  toolchain,
  run,
  runError,
  now,
  onInstall,
  onCancelInstall,
}: {
  toolchain: ClientToolchain | null | undefined;
  run: ClientInstallRun | null;
  runError: string | null;
  now: number;
  onInstall: () => void;
  onCancelInstall: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [acknowledged, setAcknowledged] = React.useState(false);

  if (toolchain === undefined || toolchain === null || toolchain.verdict === 'ready') return null;

  const activeRun = run ?? null;
  const installing = activeRun?.state === 'running';
  const at = typeof now === 'number' ? now : Date.now();
  const elapsed =
    activeRun === null ? 0 : Math.max(0, Math.round(((activeRun.finishedAt ?? at) - activeRun.startedAt) / 1000));
  const libraryOnly = toolchain.verdict === 'library-only';
  const command = 'npm install -g gitnexus';

  const copy = (): void => {
    const write =
      typeof primitives.writeClipboard === 'function'
        ? primitives.writeClipboard
        : (text: string) => navigator.clipboard?.writeText(text);
    try {
      const outcome = write(command);
      if (outcome && typeof outcome.then === 'function') outcome.then(() => setCopied(true)).catch(() => setCopied(false));
      else setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return h(
    Section,
    { wide: true, title: libraryOnly ? '缺少 gitnexus 命令' : '本机没有 GitNexus' },
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '4px' } },
      h(
        'div',
        { style: { ...MUTED, display: 'flex', gap: '6px', alignItems: 'flex-start' } },
        h(StateDot, { state: 'warning' }),
        h(
          'span',
          null,
          libraryOnly
            ? '找到了 GitNexus 的库，但没有可执行的 gitnexus 命令（可能只作为依赖安装、未全局链接）。读取不受影响；修复后即可执行增量刷新。'
            : '本插件读取 .gitnexus/gitnexus.json —— 那份文件由 GitNexus 分析仓库产生，包含每个函数定义、符号关系与执行流。没有它就没什么可展示的。',
        ),
      ),

      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('div', { style: { fontWeight: 600 } }, '① 自己安装（推荐）'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h(
            'code',
            {
              style: {
                ...styles.mono,
                flex: '1 1 auto',
                padding: '6px 8px',
                border: HAIRLINE,
                borderRadius: '6px',
                background: SOFT_BG,
                wordBreak: 'break-all',
                userSelect: 'all',
              },
            },
            command,
          ),
          h(Button, { variant: 'ghost', onClick: copy }, copied ? '已复制' : '复制'),
        ),
        h(
          'div',
          { style: MUTED },
          '用你能访问到的源安装即可 —— 本插件不假设任何网络，也不会自行下载。',
        ),
      ),

      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('div', { style: { fontWeight: 600 } }, '② 授权本插件安装'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          installing
            ? h(Button, { variant: 'ghost', onClick: onCancelInstall }, `取消（已进行 ${elapsed}s）`)
            : h(Button, { variant: 'ghost', onClick: () => setConfirming(true) }, '授权并安装'),
          h(
            'span',
            { style: MUTED },
            '装到插件自己的目录，用你已配置的 npm 源，不改全局前缀、不需要管理员权限；' +
              '若当前项目还没有索引，装完会继续初始化一次。',
          ),
        ),
        activeRun === null
          ? null
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '3px', paddingTop: '2px' } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                h(StateDot, { state: runStateTone(activeRun.state) }),
                h('span', { style: { fontWeight: 600 } }, runStateLabel(activeRun.state)),
                h('span', { style: MUTED }, installing ? `已运行 ${elapsed}s` : `${elapsed}s`),
              ),
              activeRun.message === null ? null : h('div', { style: MUTED }, activeRun.message),
              activeRun.output === ''
                ? null
                : h(
                    'pre',
                    { style: { ...styles.mono, margin: 0, whiteSpace: 'pre-wrap', maxHeight: '9em', overflow: 'auto' } },
                    activeRun.output,
                  ),
            ),
        runError === null ? null : h('div', { style: { ...MUTED, color: 'var(--dsw-alias-state-error-primary, inherit)' } }, runError),
      ),

      h(primitives.RiskConfirmation, {
        open: confirming,
        title: '授权本插件安装 GitNexus？',
        description:
          '本插件将执行：\n\nnpm install --prefix <插件数据目录>/gitnexus gitnexus@^1.6.12\n\n' +
          '· 从你已配置的 npm 源下载约 500 MB ~ 1 GB\n' +
          '· 需要几分钟；网络慢或需要本地编译时更久\n' +
          '· 会在本机运行这些包的安装期构建脚本（原生数据库与解析器需要本地编译）\n' +
          '· 安装到插件自己的目录，不改动你的全局 npm 前缀\n' +
          '· 安装成功后，若当前项目尚无索引，会继续运行一次 ' +
          '`gitnexus analyze --index-only`（只写 .gitnexus/，不改源文件）\n\n' +
          '命令走 DSH 的 shell 执行器，沙箱与其它命令一致 —— 本插件不申请扩权。',
        acknowledgeLabel: '我已了解这会下载数百 MB、在本机编译原生模块，并在需要时初始化当前项目',
        cancelLabel: '取消',
        confirmLabel: '授权并开始',
        closeLabel: '关闭',
        acknowledged,
        onAcknowledgedChange: setAcknowledged,
        onCancel: () => {
          setConfirming(false);
          setAcknowledged(false);
        },
        onConfirm: () => {
          setConfirming(false);
          setAcknowledged(false);
          onInstall();
        },
      }),
    ),
  );
}

/**
 * Keyword search over the graph's symbol names and file paths.
 *
 * A native `input` rather than a primitives component: the shared package ships no
 * declarations for an input, and guessing a prop name there fails at mount time in a
 * browser where no test here can see it. The styling is the same theme-agnostic
 * vocabulary the rest of the panel uses — inherited colour, borders from
 * `currentColor`.
 */
function SearchSection({ search }: { search: SearchViewState }) {
  const keyOf = (hit: ClientSearchHit): string =>
    `${hit.kind}:${hit.filePath}:${hit.startLine ?? ''}:${hit.name}`;
  const canSubmit = search.query.trim() !== '' && !search.searching;

  return h(
    Section,
    {
      wide: true,
      title: '关键词搜索',
      meta: h(
        'span',
        { style: { ...MUTED, fontSize: '11px' } },
        search.mode === 'text' ? '源码关键词（回退）' : '符号名 / 文件路径',
      ),
    },
    h(
      'div',
      { style: { display: 'flex', gap: '8px', alignItems: 'center', paddingTop: '4px', flexWrap: 'wrap' } },
      h('input', {
        type: 'search',
        value: search.query,
        placeholder: '搜索符号或文件，例如 analyzeCoverage',
        'aria-label': '关键词搜索',
        spellCheck: false,
        autoComplete: 'off',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => search.onQueryChange(event.target.value),
        onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter' && canSubmit) {
            event.preventDefault();
            search.onSubmit();
          }
        },
        style: {
          flex: '1 1 auto',
          minWidth: 0,
          padding: '5px 8px',
          border: HAIRLINE,
          borderRadius: '6px',
          background: SOFT_BG,
          color: 'inherit',
          font: 'inherit',
        },
      }),
      h(Button, { variant: 'primary', disabled: !canSubmit, onClick: search.onSubmit }, search.searching ? '搜索中…' : '搜索'),
      search.query === '' ? null : h(Button, { variant: 'ghost', onClick: search.onClear }, '清除'),
    ),
    search.error !== null
      ? h(
          'div',
          {
            style: {
              ...MUTED,
              color: 'var(--dsw-alias-state-error-primary, inherit)',
              marginTop: '6px',
            },
          },
          search.error,
        )
      : null,
    h(
      'div',
      { style: { ...MUTED, fontSize: '10px', marginTop: '4px' } },
      search.warning ??
        (search.mode === 'text'
          ? '图查询不可用，已回退到源码关键词搜索。'
          : '按符号名与文件路径匹配；不搜索正文。'),
    ),
    search.results === null
      ? null
      : search.results.length === 0
        ? h('div', { style: { ...MUTED, marginTop: '6px' } }, `没有匹配“${search.query}”的符号或文件。`)
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', marginTop: '6px' } },
            h(
              'div',
              { style: { ...MUTED, fontSize: '10px', paddingBottom: '2px' } },
              (search.mode === 'text'
                ? `找到 ${search.total} 处源码匹配`
                : `找到 ${search.total} 个结果`) +
                `${search.truncated ? '（已截断）' : ''} · 点击结果打开文件`,
            ),
            search.results.map((hit) =>
              h(
                'div',
                {
                  key: keyOf(hit),
                  style: { ...styles.fileRow, borderTop: HAIRLINE, padding: '5px 0' },
                },
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => search.onOpen(hit),
                    title:
                      hit.startLine === null
                        ? `打开 ${hit.filePath}`
                        : `打开 ${hit.filePath}:${hit.startLine}`,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      flex: '1 1 auto',
                      minWidth: 0,
                      padding: 0,
                      border: 0,
                      background: 'none',
                      color: 'inherit',
                      font: 'inherit',
                      textAlign: 'left',
                      cursor: 'pointer',
                    },
                  },
                  h(Tag, { tone: 'neutral' }, hit.kind),
                  h(
                    'span',
                    {
                      style: {
                        fontWeight: 600,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                    },
                    hit.name,
                  ),
                  h(
                    'span',
                    {
                      style: {
                        ...MUTED,
                        ...styles.mono,
                        minWidth: 0,
                        flex: '1 1 auto',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                    },
                    h(PathLabel, { path: hit.filePath }),
                    hit.startLine !== null ? `:${hit.startLine}` : '',
                  ),
                ),
                h(
                  Button,
                  { variant: 'ghost', onClick: () => search.onCopy(hit) },
                  search.copied === keyOf(hit) ? '已复制' : '复制',
                ),
              ),
            ),
          ),
  );
}

function MaintenanceSection({
  maintenance,
  projectPath,
  indexed,
  run,
  runError,
  now,
  onStartRun,
  onCancelRun,
}: {
  maintenance: ClientMaintenance;
  projectPath: string | null;
  indexed: boolean;
  run: ClientAnalyzeRun | null;
  runError: string | null;
  now: number;
  onStartRun: (force?: boolean) => void;
  onCancelRun: () => void;
}) {
  // `projectPath` is part of the prop set for the header, which builds the commands
  // from it; the body does not read it.
  void projectPath;
  const [copied, setCopied] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState<'init' | 'full' | null>(null);
  // `RiskConfirmation`'s checkbox is controlled, so the tick has to live here. Without
  // this the box renders but never moves, which is how it looked the first time.
  const [acknowledged, setAcknowledged] = React.useState(false);
  const commands = Array.isArray(maintenance?.commands) ? maintenance.commands : [];
  if (commands.length === 0) return null;

  // The incremental command is the normal action on both states: it initialises a
  // missing index and refreshes a present one. The full rebuild is an escape hatch
  // for a hung refresh, never "what applies" — marking it applicable on every
  // indexed repository recommended the destructive path by default.
  const applicable = 'init';
  const fullConfirm = confirming === 'full';
  const confirmCommand = commands.find((c) => c.mode === (fullConfirm ? 'full' : 'init'));
  // `supportsForce` is also the host-generation marker: the same 0.1.2 release
  // added the adaptive FTS decision and the project-local GITNEXUS_HOME. An older
  // host's runner does not include either fix, so a refresh can fail on the FTS
  // install or the registry write. Refuse to start it and say why, rather than
  // leaving a button that is known to be wrong on this host.
  const hostCurrent = maintenance.supportsForce === true;
  // Normalised rather than trusted. The declared type says `ClientAnalyzeRun | null`,
  // but a React element built without the prop arrives as `undefined` — which is
  // exactly what happened the first time this component was rendered by a caller that
  // predated the prop. `run === null` alone crashed on it.
  const activeRun = run ?? null;
  const running = activeRun?.state === 'running';
  const at = typeof now === 'number' ? now : Date.now();
  const elapsed =
    activeRun === null ? 0 : Math.max(0, Math.round(((activeRun.finishedAt ?? at) - activeRun.startedAt) / 1000));

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
    // The old line said "复制后到会话执行". That stopped being the whole story once the
    // plugin could start the run itself, so the sentence says which parts it runs and
    // which it only hands over.
    h(
      'div',
      { style: MUTED },
      hostCurrent
        ? '两条命令都可由本插件执行（走 DSH 的 shell 执行器，沙箱与其它命令一致，本插件不申请扩权）。' +
            '全量重建只应在增量刷新卡死或结果反常时使用。'
        : '当前宿主是旧版本（不包含 FTS 自适应与注册表重定向修复）；重启 DSH 后再执行维护。命令仍可复制。',
    ),

    // The run sits above the commands rather than under one of them: the host holds a
    // single run per repository, and nesting it would imply the two variants have
    // separate ones.
    activeRun === null
      ? null
      : h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              padding: '6px 8px',
              border: HAIRLINE,
              borderRadius: '6px',
              background: SOFT_BG,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h(StateDot, { state: runStateTone(activeRun.state) }),
            h('span', { style: { fontWeight: 600 } }, runStateLabel(activeRun.state)),
            activeRun.force === true ? h(Tag, { tone: 'outline' }, '全量') : null,
            h('span', { style: MUTED }, activeRun.state === 'running' ? `已运行 ${elapsed}s` : `${elapsed}s`),
            h('span', { style: { flex: 1 } }),
            running
              ? h(Button, { variant: 'ghost', onClick: onCancelRun }, '取消')
              // Wrapped, not passed directly: once `onStartRun` takes a `force`
              // argument, React's click event would arrive as that argument and every
              // "run again" would become a full rebuild. Repeating the last mode is
              // also the honest reading of "run again" after a force rebuild.
              : h(
                  Button,
                  { variant: 'ghost', disabled: !hostCurrent, onClick: () => onStartRun(activeRun.force === true) },
                  '再次执行',
                ),
          ),
          activeRun.message === null ? null : h('div', { style: MUTED }, activeRun.message),
          // The output is the evidence. A run that reports success with a warning in
          // its log is a different outcome from one that does not, and hiding the text
          // would leave the panel's own verdict as the only thing to check.
          activeRun.output === ''
            ? null
            : h(
                'pre',
                {
                  style: {
                    ...styles.mono,
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    maxHeight: '9em',
                    overflow: 'auto',
                  },
                },
                activeRun.output,
              ),
        ),

    runError === null
      ? null
      : h('div', { style: { ...MUTED, color: 'var(--dsw-alias-state-error-primary, inherit)' } }, runError),

    commands.map((command) => {
      // The host's wording is written for the no-index state ("初始化索引", "该项目还没有
      // … 索引时使用"). Reusing it on an indexed project told the operator to initialise
      // an index that already existed. Only the label and the "when" line are stateful;
      // the command itself is identical.
      const shown =
        command.mode === 'init' && indexed
          ? {
              ...command,
              label: '增量刷新',
              when: '索引落后或有文件改动时使用；未变更文件的解析产物会复用。',
            }
          : command;
      return h(
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
          h('span', { style: { fontWeight: 600 } }, shown.label),
          command.mode === applicable ? h(Tag, { tone: 'solid' }, '当前适用') : null,
          command.destructive ? h(Tag, { tone: 'outline' }, '破坏性') : null,
          h('span', { style: { flex: 1 } }),
          // Both commands are executable now, each behind its own confirmation. The
          // force button exists because the host route implements `--force`; a button
          // labelled "全量重建" that quietly ran an incremental refresh would be the
          // exact failure the earlier revision refused to ship.
          command.mode === 'init'
            ? h(
                Button,
                { variant: 'ghost', disabled: running || !hostCurrent, onClick: () => setConfirming('init') },
                running ? '运行中' : hostCurrent ? '执行增量刷新' : '执行增量刷新（需重启）',
              )
            : hostCurrent
              ? h(
                  Button,
                  { variant: 'ghost', disabled: running, onClick: () => setConfirming('full') },
                  running ? '运行中' : '全量重建',
                )
              : h(
                  Button,
                  {
                    variant: 'ghost',
                    disabled: true,
                    title: '当前宿主版本尚未支持 force=1；重启 DSH 后再试，或复制命令执行',
                  },
                  '全量重建（需重启）',
                ),
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
          h('div', { style: MUTED }, shown.when),
          command.caveat !== null && command.caveat !== undefined
            ? h('div', { style: MUTED }, command.caveat)
            : null,
      );
    }),
    Array.isArray(maintenance?.rationale) && maintenance.rationale.length > 0
        ? h(
            'div',
            { style: { ...MUTED, display: 'flex', flexDirection: 'column', gap: '2px' } },
            maintenance.rationale.map((note, index) => h('div', { key: index }, `· ${note}`)),
          )
        : null,

    // The confirmation. Everything the operator needs before a process touches their
    // working tree goes in `description`, because that is the prop the modal renders:
    // an earlier revision passed this as children and the dialog opened with an empty
    // body and two unlabelled buttons.
    //
    // One dialog, two modes. The full rebuild gets its own title, wording and
    // acknowledgement because it is a different risk: it discards the graph and FTS
    // and can take minutes, while the incremental path reuses unchanged files.
    h(primitives.RiskConfirmation, {
      open: confirming !== null,
      title: fullConfirm ? '执行全量重建？' : '执行增量刷新？',
      description: fullConfirm
        ? '将执行强制全量重建：\n\n' +
          (confirmCommand?.shell ?? 'gitnexus analyze --index-only --force') +
          '\n\n' +
          '这会重建图与 FTS；未变更文件的解析产物仍会复用。' +
          '但耗时以分钟计，索引很大时更久（上限 10 分钟，可随时取消）。' +
          '重建期间索引可能短暂不可用。' +
          '只写入 .gitnexus/，不改动源文件，也不会重写 AGENTS.md / CLAUDE.md。' +
          '命令由 DSH 的 shell 执行器运行，沙箱与其它命令一致 —— 本插件不申请扩权。'
        : '将在项目目录下运行：\n\n' +
          (confirmCommand?.shell ?? 'gitnexus analyze --index-only') +
          '\n\n' +
          '只写入 .gitnexus/，不改动任何源文件，也不会重写 AGENTS.md / CLAUDE.md。' +
          '耗时取决于改动量：无改动时约 7 秒，改动几个文件时实测可到 3 分钟，' +
          '大仓库的初始化或刷新可能更久（上限 10 分钟，可随时取消）。' +
          '命令由 DSH 的 shell 执行器运行，沙箱与其它命令一致 —— 本插件不申请扩权。',
      acknowledgeLabel: fullConfirm
        ? '我了解这会重建图与 FTS、耗时数分钟，并可能让索引短暂不可用'
        : '我了解这会运行一个进程并写入 .gitnexus/',
      cancelLabel: '取消',
      confirmLabel: fullConfirm ? '开始重建' : '执行',
      closeLabel: '关闭',
      // The checkbox is controlled, so it needs state of its own, and it is reset on
      // close: the acknowledgement is per-action rather than remembered.
      acknowledged,
      onAcknowledgedChange: setAcknowledged,
      onCancel: () => {
        setConfirming(null);
        setAcknowledged(false);
      },
      onConfirm: () => {
        const force = confirming === 'full';
        setConfirming(null);
        setAcknowledged(false);
        onStartRun(force);
      },
    }),
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
  /** Numeric progress from the host, or null before the first event/for an old host. */
  progress?: LoadingProgress | null;
  error: string | null;
  /** When the report was read from the host, ISO. */
  readAt: string | null;
  /** The refresh run, or null when nothing has been started in this host. */
  run: ClientAnalyzeRun | null;
  runError: string | null;
  /** Advances once a second while a run is in flight, so elapsed time moves. */
  now: number;
  onRefresh: () => void;
  onStartRun: (force?: boolean) => void;
  onCancelRun: () => void;
  /** The GitNexus install, when the operator authorised one. */
  installRun: ClientInstallRun | null;
  installError: string | null;
  onInstall: () => void;
  onCancelInstall: () => void;
  /**
   * Keyword search state. Optional so a view rendered without a search surface —
   * the no-index state, or a test fixture that only exercises the cards — stays a
   * pure function of what it is given.
   */
  search?: SearchViewState;
}

/**
 * An indeterminate progress bar for the one request the panel makes.
 *
 * The host returns a single coverage JSON body; it has no byte/phase progress to
 * report. A native `<progress>` without `value` is the honest shape: it animates
 * while the request is pending and does not pretend to know a percentage. The
 * label is also the accessible value, so a screen reader gets the state, not just
 * a spinning rectangle.
 */
/** Real progress reported by the host while a read is in flight. */
interface LoadingProgress {
  /** 0–100, based on completed phases and real scan/probe counters. */
  percent: number;
  /** The phase or file counter the host is currently in. */
  label: string;
}

/** The final NDJSON object from the streaming coverage route. */
interface StreamReportPayload {
  report: ClientReport;
  maintenance: ClientMaintenance | null;
  readAt: string | null;
}

function LoadingBar({ label, percent }: { label: string; percent?: number | null }) {
  const value =
    percent === null || percent === undefined
      ? undefined
      : Math.max(0, Math.min(100, Math.round(percent)));
  const text = value === undefined ? label : `${label} · ${value}%`;
  return h(
    'div',
    {
      style: {
        gridColumn: '1 / -1',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },
    },
    h('progress', {
      value,
      max: 100,
      'aria-label': label,
      'aria-valuetext': text,
      'aria-valuenow': value,
      style: {
        width: '100%',
        height: '4px',
        border: 0,
        borderRadius: '999px',
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, 0.16))',
        accentColor: 'var(--dsw-alias-brand-primary, #4f8cff)',
        color: 'var(--dsw-alias-brand-primary, #4f8cff)',
      },
    }),
    h('div', { style: { ...MUTED, fontSize: '10px' } }, text),
  );
}

function CoverageView({
  report,
  maintenance,
  projectPath,
  context,
  busy,
  progress,
  error,
  readAt,
  run,
  runError,
  now,
  onRefresh,
  onStartRun,
  onCancelRun,
  installRun,
  installError,
  onInstall,
  onCancelInstall,
  search,
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
    // The label states the scope. "刷新" alone next to a staleness warning reads as
    // "rebuild the index", which this control has never done and — by design, since
    // the plugin spawns nothing — cannot do.
    h(
      Button,
      {
        variant: 'ghost',
        onClick: onRefresh,
        disabled: busy,
        title: '重新读取报告（不会重建索引；重建见下方「维护命令」）',
        'aria-label': '重新读取报告',
      },
      h(IconRefreshOutlineRegular, { size: 14 }),
    ),
  );

  // A report already on screen stays readable while a manual refresh runs; the bar
  // rides above it. Before the first report exists, the bar is the whole body.
  // `percent` is null when the host does not stream (old host, or a cached read):
  // the native progress element is then indeterminate, not a made-up number.
  const progressBar =
    report === null || busy
      ? h(LoadingBar, {
          label: progress?.label ?? (report === null ? '正在读取索引…' : '正在刷新索引…'),
          percent: progress?.percent ?? null,
        })
      : null;

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
            h(MaintenanceSection, { maintenance, projectPath, indexed: false, run, runError, now, onStartRun, onCancelRun }),
          ),
    );
  }

  if (report === null) {
    return h('div', { style: styles.root }, header, progressBar);
  }

  // Defaults are resolved before the no-index branch: a scan-only report still has
  // totals, a cap and languages even though it has no graph. Building them only for
  // an indexed report is what made "no index" mean "nothing to show".
  const totals = report.totals ?? ZERO_TOTALS;
  const cap = report.cap ?? ZERO_CAP;
  const analyzer = report.analyzer ?? ZERO_ANALYZER;
  const largeFiles = report.largeFiles ?? [];
  const languages = report.languages ?? null;

  const { notable, context: contextWarnings } = splitWarnings(report.warnings);
  const ratio = coverageRatio(report);

  // No index yet. This is the state the initialize command exists for, but it is
  // also a state in which the working tree is still readable: file counts, bytes,
  // the cap and the language split do not need GitNexus. The panel used to show
  // only "没有索引" and a command, which made an otherwise healthy repository look
  // empty. The scan is the "at least something to look at" floor.
  if (report.repo?.indexed !== true) {
    return h(
      'div',
      { style: styles.root },
      h('div', { style: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '6px' } }, header),
      progressBar,
      h(ToolchainNotice, {
        toolchain: report.toolchain,
        run: installRun,
        runError: installError,
        now,
        onInstall,
        onCancelInstall,
      }),
      h(
        'div',
        { style: { gridColumn: '1 / -1', display: 'flex', gap: '8px', alignItems: 'flex-start' } },
        h(StateDot, { state: 'idle' }),
        h(
          'span',
          null,
          '该项目还没有 GitNexus 索引。下面是工作区扫描结果；初始化后可看到图谱、查询能力与 Git 活动对账。',
        ),
      ),
      h(
        Section,
        { wide: true, title: '扫描概览 · 尚未索引' },
        h(MetricGrid, {
          items: [
            { label: '扫描文件', value: compactNumber(totals.scanned) },
            { label: '选中文件', value: compactNumber(totals.selected) },
            { label: '扫描字节', value: fileSize(totals.scannedBytes ?? 0) },
            { label: '大小上限', value: cap.text, hint: capSourceLabel(cap.source) },
          ],
        }),
        h(
          'div',
          { style: { ...MUTED, marginTop: '6px' } },
          '这里的数字来自工作区，不是索引；索引里有什么，只有建立后才能回答。',
        ),
      ),
      languages !== null && languages.rows.length > 0 ? h(LanguageSection, { languages }) : null,
      maintenance === null || maintenance === undefined
        ? null
        : h(
            Section,
            {
              wide: true,
              title: '初始化索引',
              meta: h(
                'span',
                { style: { ...MUTED, fontSize: '11px' } },
                maintenance.supportsForce === true
                  ? '均可直接执行，也可复制到会话（沙箱与提权由 DSH 处理）'
                  : '重启 DSH 后可执行；当前仅可复制（沙箱与提权由 DSH 处理）',
              ),
            },
            h(MaintenanceSection, { maintenance, projectPath, indexed, run, runError, now, onStartRun, onCancelRun }),
          ),
    );
  }

  return h(
    'div',
    { style: styles.root },
    // The header and the two status lines span everything: they describe the whole
    // panel, so giving them a column would make them look like one card's heading.
    h('div', { style: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '6px' } }, header),
    progressBar,

    // Immediately after the header, before any index content. If GitNexus is missing,
    // that single fact explains everything the panel is about to show or fail to show,
    // so it belongs above the numbers rather than beside them.
    h(ToolchainNotice, {
      toolchain: report.toolchain,
      run: installRun,
      runError: installError,
      now,
      onInstall,
      onCancelInstall,
    }),

    h(
      'div',
      { style: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '3px' } },
      h(
        'div',
        { style: MUTED },
        `${report.repo.indexedAt ?? '未知时间'} · ${report.repo.branch ?? 'unknown'}@${String(report.repo.lastCommit ?? '').slice(0, 8)}` +
          ` · manifest ${report.repo.metaFile ?? '?'} · GitNexus ${analyzer.gitnexusVersion}` +
          // The read time is the only thing on screen a refresh can change when the
          // repository has not moved, so without it the control reads as broken.
          (readAt === null ? '' : ` · 读取于 ${String(readAt).slice(11, 19)}Z`),
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

    // Search sits above the report cards: it is the action a reader reaches for
    // before reading, not an annotation on the numbers below it.
    search === undefined ? null : h(SearchSection, { search }),

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
              tone:
                ratio >= 0.9
                  ? 'var(--dsw-alias-state-success-primary, #3fb950)'
                  : 'var(--dsw-alias-state-warn-primary, #d9a441)',
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
                  { label: '大小上限', value: cap.text, hint: capSourceLabel(cap.source) },
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
            report.capabilities?.fts?.status === 'available'
              ? null
              : h(
                  'div',
                  { style: { ...MUTED, marginTop: '4px', fontSize: '10px' } },
                  '顶部「关键词搜索」会先查图；图查询不可用时回退到源码关键词。',
                ),
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
              `${maintenance.commands?.length ?? 0} 条 · ` +
                (maintenance.supportsForce === true
                  ? '均可直接执行，也可复制到会话'
                  : '重启 DSH 后可执行；当前仅可复制') +
                '（沙箱与提权由 DSH 处理）',
            ),
          },
          h(MaintenanceSection, { maintenance, projectPath, indexed, run, runError, now, onStartRun, onCancelRun }),
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
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : null;
  const [report, setReport] = React.useState<ClientReport | null>(null);
  const [maintenance, setMaintenance] = React.useState<ClientMaintenance | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState<LoadingProgress | null>(null);
  const [reloadToken, setReloadToken] = React.useState(0);
  // When the report on screen was read. Without it a refresh of an unchanged
  // repository produces a byte-identical panel, so the control looks inert even
  // when it did precisely what it was asked to do.
  const [readAt, setReadAt] = React.useState<string | null>(null);
  // Only a manual refresh bypasses the host's cache; the initial load does not.
  const wantsFresh = reloadToken > 0;

  // Keyword search. Its own state because it is an on-demand action, not part of
  // the report the panel loads: an idle panel makes no search requests at all.
  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<ClientSearchHit[] | null>(null);
  const [searchMode, setSearchMode] = React.useState<'graph' | 'text' | null>(null);
  const [searchTotal, setSearchTotal] = React.useState(0);
  const [searchTruncated, setSearchTruncated] = React.useState(false);
  const [searchWarning, setSearchWarning] = React.useState<string | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);
  const [searchCopied, setSearchCopied] = React.useState<string | null>(null);
  // Monotonic request id: a slower earlier search must not overwrite a newer one.
  const searchSeq = React.useRef(0);

  // The refresh run, and the tick that makes its elapsed time advance. `run` is null
  // until something is started in this host's lifetime — a state the card renders as
  // "not run yet" rather than as a failure.
  const [run, setRun] = React.useState<ClientAnalyzeRun | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const running = run?.state === 'running';

  /**
   * Poll while a run is in flight.
   *
   * Deliberately not an always-on interval: a panel left open on an idle project should
   * make no requests at all, and the host keeps one run per repository, so a missed
   * poll costs nothing but a second.
   */
  React.useEffect(() => {
    if (projectPath === null || !running) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(routeUrl(`/api/gitnexus/analyze?repo=${encodeURIComponent(projectPath)}`));
        const body = await res.json().catch(() => null);
        if (cancelled || !body?.ok) return;
        const next: ClientAnalyzeRun | null = body.run ?? null;
        setRun(next);
        // A finished run changed the index, so the report on screen is now a reading of
        // the previous one. This is the whole reason the run was started.
        if (next !== null && next.state !== 'running') setReloadToken((n) => n + 1);
      } catch {
        /* a dropped poll is not worth surfacing; the next one reports the state */
      }
    };
    const id = setInterval(() => {
      setTick((n) => n + 1);
      void poll();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectPath, running]);

  const startRun = React.useCallback(async (force = false): Promise<void> => {
    if (projectPath === null) return;
    setRunError(null);
    try {
      const suffix = force ? '&force=1' : '';
      const res = await fetch(
        routeUrl(`/api/gitnexus/analyze?repo=${encodeURIComponent(projectPath)}${suffix}`),
        { method: 'POST' },
      );
      const body = await res.json().catch(() => null);
      if (!body?.ok) throw new Error(body?.message ?? `请求失败 (${res.status})`);
      setRun(body.run ?? null);
      setTick(0);
    } catch (cause) {
      setRunError(String((cause as Error)?.message ?? cause));
    }
  }, [projectPath]);

  const cancelRun = React.useCallback(async (): Promise<void> => {
    if (projectPath === null) return;
    try {
      const res = await fetch(routeUrl(`/api/gitnexus/analyze?repo=${encodeURIComponent(projectPath)}`), {
        method: 'DELETE',
      });
      const body = await res.json().catch(() => null);
      if (body?.ok) setRun(body.run ?? null);
    } catch (cause) {
      setRunError(String((cause as Error)?.message ?? cause));
    }
  }, [projectPath]);

  /**
   * Run one keyword search.
   *
   * No request on mount and no request per keystroke: a graph query is cheap but not
   * free, and the operator's typing is not a search intent until Enter or the button.
   * `searchSeq` makes an older in-flight response a no-op, which is the difference
   * between "the last search wins" and a result list that flickers backwards.
   */
  const runSearch = React.useCallback(async (): Promise<void> => {
    if (projectPath === null) return;
    const query = searchQuery.trim();
    if (query === '') {
      setSearchResults(null);
      setSearchError(null);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    setSearchError(null);
    setSearchCopied(null);
    try {
      const res = await fetch(
        routeUrl(
          `/api/gitnexus/search?repo=${encodeURIComponent(projectPath)}` +
            `&q=${encodeURIComponent(query)}&limit=20`,
        ),
      );
      const body = await res.json().catch(() => null);
      if (seq !== searchSeq.current) return;
      if (!body?.ok) {
        // A 404 without the route's own code means the host predates the search
        // route, not that the project is wrong: the panel's own project path is a
        // project root by construction.
        if (res.status === 404 && body?.code !== 'not-a-project') {
          throw new Error('当前宿主没有搜索路由；重启 DSH 后再试。');
        }
        throw new Error(
          typeof body?.message === 'string' ? body.message : `请求失败 (${res.status})`,
        );
      }
      const results: ClientSearchHit[] = Array.isArray(body.results)
        ? (body.results as ClientSearchHit[]).filter(
            (hit): hit is ClientSearchHit =>
              hit !== null &&
              typeof hit === 'object' &&
              typeof hit.kind === 'string' &&
              typeof hit.name === 'string' &&
              typeof hit.filePath === 'string',
          )
        : [];
      setSearchResults(results);
      setSearchMode(body.mode === 'text' ? 'text' : body.mode === 'graph' ? 'graph' : null);
      setSearchTotal(typeof body.total === 'number' ? body.total : results.length);
      setSearchTruncated(body.truncated === true);
      setSearchWarning(typeof body.warning === 'string' ? body.warning : null);
    } catch (cause) {
      if (seq !== searchSeq.current) return;
      setSearchResults(null);
      setSearchError(String((cause as Error)?.message ?? cause));
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, [projectPath, searchQuery]);

  const clearSearch = React.useCallback((): void => {
    searchSeq.current += 1;
    setSearchQuery('');
    setSearchResults(null);
    setSearchMode(null);
    setSearchTotal(0);
    setSearchTruncated(false);
    setSearchWarning(null);
    setSearchError(null);
    setSearching(false);
    setSearchCopied(null);
  }, []);

  const copySearchHit = React.useCallback((hit: ClientSearchHit): void => {
    const text = `${hit.filePath}${hit.startLine !== null ? `:${hit.startLine}` : ''}`;
    const key = `${hit.kind}:${hit.filePath}:${hit.startLine ?? ''}:${hit.name}`;
    const write =
      typeof primitives.writeClipboard === 'function'
        ? primitives.writeClipboard
        : (value: string) => navigator.clipboard?.writeText(value);
    try {
      const outcome = write(text);
      if (outcome && typeof outcome.then === 'function') {
        outcome
          .then(() => {
            setSearchCopied(key);
            setTimeout(() => setSearchCopied(null), 1500);
          })
          .catch(() => setSearchCopied(null));
      } else {
        setSearchCopied(key);
        setTimeout(() => setSearchCopied(null), 1500);
      }
    } catch {
      setSearchCopied(null);
    }
  }, []);

  /**
   * Open a hit in the platform's file viewer at its line.
   *
   * The resource address is the same `dsh-resource://file/session/...` the built-in
   * file strip uses; `params.line` is what the chat's file links pass. If the
   * deployment has no right-sidebar controller (a headless profile, or a host older
   * than the service), opening is impossible — copy the `path:line` instead of
   * silently doing nothing, and say why.
   */
  const openSearchHit = React.useCallback(
    (hit: ClientSearchHit): void => {
      setSearchError(null);
      if (sessionId === null) {
        setSearchError('未能定位当前会话，已复制路径。');
        copySearchHit(hit);
        return;
      }
      const address = fileResourceAddress(sessionId, hit.filePath);
      const options =
        hit.startLine === null
          ? undefined
          : { params: { line: hit.startLine } };
      try {
        if (openResourceIn !== null) {
          openResourceIn(sessionId, address, options);
          return;
        }
        if (openResource !== null) {
          openResource(address, options);
          return;
        }
      } catch {
        /* fall through to the copy path */
      }
      setSearchError('当前宿主没有可用的文件打开能力，已复制路径。');
      copySearchHit(hit);
    },
    [sessionId, copySearchHit],
  );

  // A different project means the previous hits are another repository's symbols.
  React.useEffect(() => {
    clearSearch();
  }, [projectPath, clearSearch]);

  // The GitNexus install. Its own state because it is not tied to a repository: the
  // install target is one directory per machine, and the operator may have several
  // projects open across a session.
  const [installRun, setInstallRun] = React.useState<ClientInstallRun | null>(null);
  const [installError, setInstallError] = React.useState<string | null>(null);
  const installing = installRun?.state === 'running';
  // Only an install the operator authorised *in this panel* may chain into an
  // analyze. A successful install from an earlier session is still visible in the
  // host's run state, and starting a write from that would be acting on consent the
  // operator gave for a different action.
  const autoInitArmed = React.useRef(false);
  const autoInitDone = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!installing) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(routeUrl('/api/gitnexus/install'));
        const body = await res.json().catch(() => null);
        if (cancelled || !body?.ok) return;
        const next: ClientInstallRun | null = body.run ?? null;
        setInstallRun(next);
        // A finished install changes what this machine can do, so re-read the report:
        // the toolchain verdict is computed per read, so this is what clears the notice.
        if (next !== null && next.state !== 'running') setReloadToken((n) => n + 1);
      } catch {
        /* a dropped poll is not worth surfacing */
      }
    };
    const id = setInterval(() => {
      setTick((n) => n + 1);
      void poll();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [installing]);

  const startInstall = React.useCallback(async (): Promise<void> => {
    setInstallError(null);
    autoInitArmed.current = true;
    try {
      const res = await fetch(routeUrl('/api/gitnexus/install'), { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!body?.ok) throw new Error(body?.message ?? `请求失败 (${res.status})`);
      setInstallRun(body.run ?? null);
      setTick(0);
    } catch (cause) {
      autoInitArmed.current = false;
      setInstallError(String((cause as Error)?.message ?? cause));
    }
  }, []);

  const cancelInstall = React.useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(routeUrl('/api/gitnexus/install'), { method: 'DELETE' });
      const body = await res.json().catch(() => null);
      if (body?.ok) setInstallRun(body.run ?? null);
    } catch (cause) {
      setInstallError(String((cause as Error)?.message ?? cause));
    }
  }, []);

  /**
   * Install → initialize, in one authorised step.
   *
   * The install is machine-wide; the index is per-project. Chaining them is the
   * difference between "you now have a CLI" and "you can see the index", which is
   * what the operator asked for. Three conditions keep it honest: the install must
   * have finished successfully, the project must still have no index (otherwise
   * this would silently refresh an index nobody asked to refresh), and the operator
   * must have started *this* install from this panel.
   *
   * The key includes the install's start time, so a retry after a cancellation is a
   * new run and may chain again, while the poll ticks of one run cannot start two
   * analyses.
   */
  React.useEffect(() => {
    if (!autoInitArmed.current) return;
    if (installRun?.state !== 'done') return;
    // Wait for a report rather than treating "not loaded" as "not indexed".
    if (report === null || projectPath === null || report.repo?.indexed === true) return;
    const key = `${projectPath}:${installRun.startedAt}`;
    if (autoInitDone.current === key) return;
    autoInitDone.current = key;
    autoInitArmed.current = false;
    void startRun(false);
  }, [installRun, projectPath, report, startRun]);

  React.useEffect(() => {
    if (projectPath === null) return undefined;
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    setProgress({ percent: 0, label: '连接索引服务…' });
    const query =
      `/api/gitnexus/coverage?repo=${encodeURIComponent(projectPath)}` +
      (wantsFresh ? '&refresh=1' : '') +
      '&stream=1';

    const load = async (): Promise<void> => {
      try {
        const res = await fetch(routeUrl(query), { signal: controller.signal });
        const contentType = res.headers.get('content-type') ?? '';
        if (contentType.includes('application/x-ndjson') && res.body !== null) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          const reports: StreamReportPayload[] = [];
          let buffer = '';
          const consume = (line: string): void => {
            if (line.trim() === '' || controller.signal.aborted) return;
            let message: Record<string, unknown>;
            try {
              message = JSON.parse(line) as Record<string, unknown>;
            } catch {
              return;
            }
            if (message.type === 'progress') {
              const raw = typeof message.percent === 'number' ? message.percent : 0;
              const percent = Math.max(0, Math.min(100, Math.round(raw)));
              const label = typeof message.label === 'string' ? message.label : '读取索引…';
              setProgress({ percent, label });
              return;
            }
            if (message.type === 'report') {
              reports.push(message as unknown as StreamReportPayload);
              return;
            }
            if (message.type === 'error') {
              throw new Error(
                typeof message.message === 'string' ? message.message : '读取索引失败。',
              );
            }
          };

          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              consume(line);
              newline = buffer.indexOf('\n');
            }
          }
          buffer += decoder.decode();
          if (buffer.trim() !== '') consume(buffer);

          const payload = reports[0];
          if (payload === undefined) throw new Error('读取中断：没有收到完整报告。');
          if (controller.signal.aborted) return;
          setReport(payload.report);
          setMaintenance(payload.maintenance ?? null);
          setReadAt(
            typeof payload.readAt === 'string' ? payload.readAt : new Date().toISOString(),
          );
          return;
        }

        // An older host ignores `stream=1` and answers plain JSON. Drop the numeric
        // channel and let the native progress element go indeterminate rather than
        // leaving a frozen 0%.
        setProgress(null);
        const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          code?: string;
          message?: string;
          report?: ClientReport;
          maintenance?: ClientMaintenance | null;
          readAt?: string;
        } | null;
        // `not-indexed` is a state the panel renders, not a failure: the whole
        // point of leading with the initialize command is that reaching it is
        // expected on a project that has never been analysed.
        if (res.status === 404 && body?.code === 'not-indexed') {
          setReport({ repo: { indexed: false, path: projectPath } });
          setMaintenance(null);
          setReadAt(body?.readAt ?? new Date().toISOString());
          return;
        }
        if (!body?.ok || body.report === undefined) {
          throw new Error(body?.message ?? `请求失败 (${res.status})`);
        }
        setReport(body.report);
        setMaintenance(body.maintenance ?? null);
        setReadAt(typeof body.readAt === 'string' ? body.readAt : new Date().toISOString());
      } catch (cause) {
        if (controller.signal.aborted) return;
        const error = cause as { name?: string; message?: string };
        if (error?.name === 'AbortError') return;
        setError(String(error?.message ?? cause));
      } finally {
        if (!controller.signal.aborted) {
          setBusy(false);
          setProgress(null);
        }
      }
    };

    void load();
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
    progress,
    error,
    readAt,
    run,
    runError,
    // `tick` is read here rather than inside the card, so elapsed seconds re-render
    // even when the host reports nothing new — a run with no output for a minute
    // otherwise looks frozen.
    now: Date.now() + tick * 0,
    onRefresh: () => setReloadToken((n) => n + 1),
    onStartRun: (force?: boolean) => void startRun(force),
    onCancelRun: () => void cancelRun(),
    installRun,
    installError,
    onInstall: () => void startInstall(),
    onCancelInstall: () => void cancelInstall(),
    search: {
      query: searchQuery,
      onQueryChange: (value: string) => {
        // Invalidate an in-flight search for the previous text: otherwise its
        // response can land after the edit and repopulate a list that no longer
        // matches the box. The sequence bump also makes its `finally` a no-op, so
        // the spinner is cleared here.
        searchSeq.current += 1;
        setSearching(false);
        setSearchQuery(value);
        setSearchError(null);
        setSearchResults(null);
        setSearchMode(null);
      },
      onSubmit: () => void runSearch(),
      onClear: clearSearch,
      searching,
      error: searchError,
      mode: searchMode,
      results: searchResults,
      total: searchTotal,
      truncated: searchTruncated,
      warning: searchWarning,
      copied: searchCopied,
      onOpen: openSearchHit,
      onCopy: copySearchHit,
    },
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
  inject(deps: readonly string[], callback: (svcCtx: InjectedServices) => void): void;
}

/** Services this plugin optionally reaches for; absent ones are a normal profile shape. */
interface InjectedServices {
  sidebarRightTabs?: SidebarRightTabs;
  sidebarRight?: SidebarRightApi;
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
      const tabs = svcCtx.sidebarRightTabs;
      if (tabs === undefined) return;
      ctx.effect(
        () =>
          tabs.register({
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

  // The navigation controller the chat and the file strip already use. Optional:
  // a profile without a right column simply leaves the module-level openers null,
  // and a search-result click falls back to copying `path:line`.
  safe('sidebarRight', () => {
    ctx.inject(['sidebarRight'], (svcCtx) => {
      const service = svcCtx.sidebarRight;
      if (service === undefined || typeof service.openResource !== 'function') return;
      openResource = (address, options) => service.openResource(address, options);
      if (typeof service.openResourceIn === 'function') {
        openResourceIn = (sessionId, address, options) => service.openResourceIn?.(sessionId, address, options);
      }
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
    fileResourceAddress,
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
