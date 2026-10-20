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
export interface ClientWarning {
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
export interface ClientTotals {
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
export interface ClientCap {
  text: string;
  source: string;
  maxText: string;
}

/** What the graph holds. */
export interface ClientGraph {
  nodes: number;
  edges: number;
  communities: number;
  processes: number;
  embeddings: number;
  edgesPerNode: number;
}

/** One query surface's availability. */
export interface ClientCapability {
  status?: string;
  skipReason?: string;
  provider?: string;
}

/** Freshness of the index against HEAD. */
export interface ClientStaleness {
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
export interface ClientGraphQuality {
  totalSites?: number;
  counts?: Record<string, unknown>;
}

/** Analysis configuration that forces a rebuild when it changes. */
export interface ClientProvenance {
  schemaFingerprint?: string | null;
  contentRetention?: string | null;
  ftsProfile?: string | null;
  crossLanguageProperties?: number;
  runnerCliVersion?: string | null;
}

/** One oversized file the size cap dropped. */
export interface ClientLargeFile {
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
export interface ClientLanguages {
  rows: LanguageRowLike[];
  totalBytes: number;
  totalFiles: number;
  largeExcluded?: LanguageRowLike[];
  /** `builtin` means GitNexus was unavailable and the extension map filled in. */
  detector?: 'gitnexus' | 'builtin';
}

/** One touched file from the activity window. */
export interface ClientActivityFile {
  path: string;
  changes: number;
  insertions: number;
  deletions: number;
  lastChange: string;
  verdict: string;
}

/** One commit in the activity timeline. */
export interface ClientActivityCommit {
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
export interface ClientActivityCrossRow {
  verdict: string;
  files: number;
  changes: number;
  insertions: number;
  deletions: number;
}

/** One commit touching a selected file. */
export interface ClientFileHistoryCommit {
  sha: string;
  shortSha?: string;
  date: string;
  author: string;
  subject: string;
  insertions: number;
  deletions: number;
}

/** The bounded per-file history returned by the route. */
export interface ClientFileHistory {
  path: string;
  available: boolean;
  days: number;
  commits: number;
  insertions: number;
  deletions: number;
  timeline: ClientFileHistoryCommit[];
  reason?: string | null;
  readAt?: string;
}

/** Changes since the index's recorded baseline. */
export interface ClientActivityBaseline {
  ref?: string | null;
  /** `window` means the index recorded no commit and the window start was used. */
  source?: 'index' | 'window';
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
export interface ClientActivity {
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
  timelineTruncated?: boolean;
}

/** Coverage differences between a fresh scan and the index. */
export interface ClientIndexInfo {
  uncoveredCount?: number;
  uncoveredSample?: Array<{ path: string; size: number }>;
  staleCount?: number;
  staleSample?: string[];
  dirtyPaths?: string[];
}

/** The subset of the host report this half renders. */
export interface ClientReport {
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
export interface ClientMaintenanceCommand {
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
export interface ClientToolchain {
  packageRoot: string | null;
  packageVersion: string | null;
  cli: { present: boolean; source?: string; viaNode?: boolean };
  verdict: 'ready' | 'library-only' | 'absent';
}

/** The maintenance payload that rides along with a report. */
export interface ClientMaintenance {
  commands?: ClientMaintenanceCommand[];
  rationale?: string[];
  /**
   * Absent on hosts that predate `force=1`. The full-rebuild button is gated on it:
   * against such a host the flag is ignored, so the button would run an incremental
   * refresh under a full-rebuild label.
   */
  supportsForce?: boolean;
  /**
   * Absent on hosts that predate `mode=repair-fts`. The repair control is gated on it
   * for the same reason as `supportsForce`: an older route has no such mode, so the
   * button would claim to repair and silently run a plain incremental refresh.
   */
  supportsRepair?: boolean;
}

/**
 * One changed path, as the host's delta engine classified it.
 *
 * `excluded` is a change the index's own policy would skip on refresh too — an
 * oversized file — so it is listed for honesty but never counted as a reason to
 * refresh, and the panel must not present it as one.
 */
export interface ClientDeltaEntry {
  path: string;
  kind: 'modified' | 'added' | 'deleted' | 'excluded';
  reason: string | null;
}

/**
 * The Tier 0 verdict: would re-analysing change the index?
 *
 * `comparable: false` is a real answer, not an error — a project with no index, a
 * legacy manifest without `fileHashes`, or an unusable git history all land here with
 * a `notes` explanation, and the panel then simply does not gate the refresh.
 */
export interface ClientDelta {
  indexed: boolean;
  comparable: boolean;
  basis: 'index' | 'worktree' | null;
  indexedCommit: string | null;
  headCommit: string | null;
  entries: ClientDeltaEntry[];
  counts: {
    checked: number;
    hashed: number;
    unchanged: number;
    modified: number;
    added: number;
    deleted: number;
    excluded: number;
  };
  needsRefresh: boolean;
  truncated: boolean;
  notes: string[];
  durationMs: number;
  readAt: string;
}

/** A drawn node: a community in the overview, a symbol in a drill-down. */
export interface ClientGraphNode {
  id: string;
  kind: string;
  name: string;
  filePath: string | null;
  startLine: number | null;
  /** Community nodes only. */
  symbolCount?: number;
}

export interface ClientGraphEdge {
  source: string;
  target: string;
  type: string;
  weight: number;
}

/**
 * One bounded projection from the host.
 *
 * `truncated` and `total` are part of the payload, not diagnostics: a view that cannot
 * say how much it left out is a view that can be mistaken for the whole graph.
 */
export interface ClientGraphProjection {
  view: 'communities' | 'community';
  scope: string | null;
  nodes: ClientGraphNode[];
  edges: ClientGraphEdge[];
  total: number;
  truncated: boolean;
  budget: { nodes: number; edges: number };
  notes: string[];
  readAt: string;
}

/** What the graph card needs from the panel. */
export interface GraphViewState {
  projection: ClientGraphProjection | null;
  loading: boolean;
  error: string | null;
  /**
   * Whether the host actually serves the graph route.
   *
   * `missing` is a deployment state, not a failure: a client can hot-reload ahead of the
   * host, and the route is then simply not mounted. It has to be distinguishable from
   * "still loading" — the first version collapsed both into `projection === null` and
   * the card sat on 读取中… forever, which reads as a hang rather than as "restart DSH".
   */
  routeState: 'unknown' | 'ready' | 'missing';
  /** The community being drilled into, or null for the overview. */
  scope: string | null;
  onOpenCommunity: (id: string) => void;
  onBack: () => void;
  onReload: () => void;
  onOpenSymbol: (node: ClientGraphNode) => void;
}

/**
 * A refresh the panel started, as the host reports it.
 *
 * `state` is a union rather than a boolean because the interesting outcomes are the
 * ones that are neither success nor failure: `denied` means the sandbox refused and
 * this plugin will not escalate, `unavailable` means the deployment has no shell or no
 * GitNexus — an operator acts on those differently from a crash.
 */
export interface ClientAnalyzeRun {
  state: 'unavailable' | 'running' | 'done' | 'failed' | 'timed-out' | 'cancelled' | 'denied';
  /** Whether this run was the `--force` full rebuild. Older hosts omit it. */
  force?: boolean;
  /** Whether this run repaired the search indexes (`--repair-fts`). Older hosts omit it. */
  repairFts?: boolean;
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
export interface ClientSearchHit {
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
export interface SidebarRightOpenOptions {
  params?: Record<string, unknown>;
}

export interface SidebarRightApi {
  openResource(address: string, options?: SidebarRightOpenOptions): void;
  openResourceIn?(sessionId: string, address: string, options?: SidebarRightOpenOptions): void;
}

export type OpenResource = (address: string, options?: SidebarRightOpenOptions) => void;
export type OpenResourceIn = (
  sessionId: string,
  address: string,
  options?: SidebarRightOpenOptions,
) => void;

/** The search card's state, supplied by `CoveragePanel` and rendered by the view. */
export interface SearchViewState {
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
export interface ClientInstallRun {
  state: 'unavailable' | 'running' | 'done' | 'failed' | 'timed-out' | 'cancelled' | 'denied';
  command: string;
  prefix: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  message: string | null;
  output: string;
}

/** Which context props the slot actually supplied. */
export interface ContextDiagnostic {
  present: string[];
  absent: string[];
}

/** A `StateDot` state, named so helpers and components agree on the union. */
export type DotState = 'done' | 'warning' | 'error' | 'idle' | 'ongoing';

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
export interface SlotProps {
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

/** One language as the client reads it. Mirrors the host report's row. */
export interface LanguageRowLike {
  key: string;
  label: string;
  color: string;
  bytes: number;
  files: number;
}

/** One drawn segment of the stacked bar. */
export interface StackSegment {
  key: string;
  label: string;
  color: string;
  percent: number;
}

export interface HistogramBucketLike {
  label: string;
  commits: number;
  insertions: number;
  deletions: number;
}
