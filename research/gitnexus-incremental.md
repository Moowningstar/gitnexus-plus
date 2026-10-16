# GitNexus Incremental Indexing — Engineering Report

**Subject:** `D:\Project\GitNexus` (GitNexus — code knowledge-graph indexer / CLI / MCP server)
**Audience:** an external tool that wants to *incrementally update* a GitNexus index instead of rebuilding it.
**Method:** direct source reading; every claim carries `file:line` evidence relative to `D:\Project\GitNexus\`.
Tests, in-repo benches and the repo's own guardrail docs are cited as evidence where they pin a contract.

> **Headline:** incremental re-index is real, it is the **default** (there is no `--incremental` flag — you opt *out* with `--force`), and it is **write-side only**. The pipeline always re-parses/rebuilds the *full in-memory graph*; incrementality means (a) skipping tree-sitter dispatch for unchanged file chunks and (b) `DETACH DELETE` + re-`COPY` of only the changed subgraph's DB rows. Two costs (`scopeResolution`, the FTS table rebuilds) dominate even on the incremental path and are **not** incremental.

---

## 1. Is there a real incremental re-index path?

**Yes.** One exported orchestrator, `runFullAnalysis`, decides and executes it.

### 1.1 The entry point (exact signature)

`gitnexus/src/core/run-analyze.ts:1380-1385`

```ts
export async function runFullAnalysis(
  repoPath: string,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
  runnerIdentityAtBootstrap?: AnalyzerRunnerIdentity,
): Promise<AnalyzeResult>
```

- `AnalyzeCallbacks` — `run-analyze.ts:439-442`: `{ onProgress: (phase, percent, message) => void; onLog?: (message: string) => void }`.
- `AnalyzeOptions` — `run-analyze.ts:444-642` (full field list in §8.4).
- `AnalyzeResult` — `run-analyze.ts:766-836`.

There is **no separate `runIncrementalAnalysis`**. `runFullAnalysis` is the only writer entry; the name is historical — it wraps both plans.

### 1.2 The decision, and it is made *post-pipeline*

`run-analyze.ts:3067-3085`:

```ts
const incrementalEligible =
  !options.force &&
  !!existingMeta &&
  !schemaFingerprintMismatch(existingMeta.schemaFingerprint) &&
  currentAnalysisFeatureMismatches.length === 0 &&
  !!existingMeta.fileHashes &&
  Object.keys(existingMeta.fileHashes).length > 0 &&
  repoHasGit &&
  allFilePaths.length > 0;

// Select a full build before any selective mutation when the operator has
// disabled the checkpoint needed to certify an incremental publication.
const isIncremental = incrementalEligible && isManualCheckpointEnabled();
```

Then `run-analyze.ts:3087-3089`:

```ts
const hashDiff = isIncremental
  ? diffFileHashes(newFileHashes, existingMeta!.fileHashes)
  : undefined;
```

and `run-analyze.ts:3126`: `const isFullRebuild = !(isIncremental && hashDiff);`

The comment at `run-analyze.ts:3061-3066` states why it is post-pipeline: there is "no separate pre-pipeline prediction to desync from". Consequence for an external driver: **eligibility cannot be predicted from `gitnexus.json` alone** — it also depends on live options (`force`), the CJK/pdg/schema stamps, and whether the pipeline produced any `File` nodes.

### 1.3 The confirmed "already up to date" fast path

`run-analyze.ts:2490-2498`:

```ts
if (
  existingMeta &&
  !existingMeta.embeddingCheckpoint &&
  !options.force &&
  existingMeta.lastCommit === currentCommit &&
  !ftsModeChanged &&
  !processDetectionMismatch
) {
```

returns `alreadyUpToDate: true` at `run-analyze.ts:2684-2702`. Note the test is `lastCommit === currentCommit` — a **commit-equality** gate, not a content gate. An uncommitted working-tree edit at the same commit does **not** take the fast path, but does take the incremental path (the file-hash diff catches it).

### 1.4 Exact flags — there is no `--incremental`

`gitnexus/src/cli/index.ts:74-79` (the `analyze` command):

```ts
.command('analyze [path]')
.description('Index a repository (full analysis)')
.option('--watch', 'Keep the index current with serialized incremental refreshes')
.option('--debounce <ms>', 'Watch quiet period before refreshing (default: 300 milliseconds)')
.option('-f, --force', 'Force graph and FTS rebuild; unchanged parser output may be reused')
.option('--no-parse-cache', 'Re-parse every source file instead of replaying cached parser output')
```

So the operator-facing vocabulary is:
- **default** → incremental DB writeback when eligible;
- `--force` → rebuild graph + FTS (parser output still reused from the content-addressed cache) — reason key `user-force` (`run-analyze.ts:1530`);
- `--no-parse-cache` → also bypass parser reuse — reason key `parse-cache-bypass` (`run-analyze.ts:1539-1540`);
- `--repair-fts` → FTS-only, skips pipeline re-analysis entirely (`AnalyzeOptions.repairFts`, `run-analyze.ts:467`).

`GUARDRAILS.md:34` states the policy in prose: *"Runs incrementally by default — the pipeline parses every file every run (cross-file resolution requires it), but tree-sitter dispatch is skipped for unchanged file chunks via the content-addressed cache, and only changed-file rows (plus their importers, transitively) are rewritten in LadybugDB."*

### 1.5 The four ways to trigger an incremental run

| # | Trigger | Call site |
|---|---|---|
| 1 | `gitnexus analyze [path]` | `cli/analyze.ts:1619` → `runFullAnalysis(repoPath, runOptions, runCallbacks, ...)`; options literal `cli/analyze.ts:1541-1600`, incl. `force: options.force` (1546), `useParseCache: options.parseCache !== false` (1548), `skipNativeCloseOnExit: true` (1599) |
| 2 | `gitnexus analyze --watch` | `cli/analyze-watch.ts:422` `watchCommandWithRunnerIdentity` → `analyze-watch.ts:525-536` `runFullAnalysis(repoPath, analyzeOptions, …)` per debounce batch |
| 3 | `gitnexus auto-sync start` | `cli/auto-sync.ts:14` → `core/auto-sync/starter.ts:74` `startAutoSyncWatch` → `core/auto-sync/runner.ts:114` `runAutoSyncOnce` → `runner.ts:249-265` `deps.runAnalysis(targetDir, {branch, skipAgentsMd:true, skipSkills:true, preserveExistingPdg?, atomicIncremental:true, …rcEmbeddings}, timeoutMs, signal, …)` → `analysis-worker-launch.ts:226` `child.send({type:'start', repoPath, options})` into a forked `server/analyze-worker.{ts,js}` |
| 4 | `POST /api/analyze` | `server/api.ts:1849-1853` (`createRouteLimiter({limit:10})`, `requireTrustedOrigin`); body keys `{url?, path?, force?, embeddings?, dropEmbeddings?, springActuatorPath?, asyncApiSpecPath?, token?, branch?}` (`api.ts:1855-1865`); job polling `GET /api/analyze/:jobId` (`api.ts:2064`), SSE `GET /api/analyze/:jobId/progress` (`api.ts:2076`), cancel `DELETE /api/analyze/:jobId` (`api.ts:2079`) |

There is **no MCP tool that triggers an analyze**. The tool inventory (`mcp/tools.ts:116-1061`) is `list_repos, query, cypher, context, detect_changes, check, rename, impact, explain, pdg_query, route_map, tool_map, shape_check, api_impact, group_list, group_sync, trace, read_file, grep` — all readers.

### 1.6 Watch mode is the only caller that requests failure-preserving staging

`cli/analyze-watch.ts:208`: `atomicIncremental: process.platform !== 'win32'`. This is the option documented at `run-analyze.ts:635-641`: *"Stage an incremental write in a copy of the live index before publishing it… Currently supported on POSIX."*

---

## 2. What is the reuse unit?

There are **five** distinct reuse mechanisms. Only two of them survive across runs; the rest are run-scoped.

### 2.1 (DB-write gate) Per-file content hash map — the thing that actually makes the write incremental

- Stored as `RepoMeta.fileHashes?: Record<string, string>` — `storage/repo-meta.ts:377-383` (*"SHA-256 of every file's content at the time of the last successful indexing run. Map keys are repo-relative paths."*).
- Producers: `computeFileHash(absPath): Promise<string|null>` (`storage/file-hash.ts:30-37`) and `computeFileHashes(repoPath, relPaths): Promise<Map<string,string>>` (`file-hash.ts:43-49`, batched 100 at a time, `file-hash.ts:58`).
- Diff: `diffFileHashes(current, stored): FileHashDiff` — `file-hash.ts:93-118`, returning

```ts
export interface FileHashDiff {          // file-hash.ts:76-85
  changed: string[];   // content hash differs
  added: string[];     // in scan, not in stored map
  deleted: string[];   // in stored map, not in scan
  toWrite: string[];   // changed ∪ added, sorted
}
```

- Recorded coverage policy: `RepoMeta.indexCoverage = { maxFileSizeBytes, dirtyPaths? }` — `repo-meta.ts:392-395`.

### 2.2 (parse reuse) Chunk-level content-addressed **parse cache** — `gitnexus/src/storage/parse-cache.ts`

Granularity is explicitly **not per-file** (`parse-cache.ts:9-21`):

> *"Granularity: chunk-level. Files are assigned to a stable `(language, hash(path) mod 128)` bucket, then packed to a 2 MiB (or operator) byte budget inside that bucket. Membership does not depend on worker count. The cache key is `sha256(joined(filePath:contentHash for each file in the chunk, sorted))`."*

- Constants: `PARSE_CACHE_BUCKET_COUNT = 128` (`parse-cache.ts:905`); `PARSE_CACHE_VERSION = \`${SCHEMA_BUMP}+${GITNEXUS_PKG_VERSION}\`` (`parse-cache.ts:896`) with `const SCHEMA_BUMP = 142;` (`parse-cache.ts:872`) and `GITNEXUS_PKG_VERSION` read from `gitnexus/package.json` at module load (`parse-cache.ts:873-895`).
- Bucket id: `parseCacheBucketId(filePath) = sha256(path) mod 128` (`parse-cache.ts:908-909`).
- Packing: `packParseCacheChunks(files, byteBudget): string[][]` (`parse-cache.ts:919-948`).
- Key: `computeChunkHash(entries: Array<{filePath, contentHash}>, pdg: boolean|PdgCacheKey = false): string` (`parse-cache.ts:1059-1105`). Non-pdg path is `sha256` of sorted `filePath:contentHash` lines; pdg path prefixes a namespace token `pdg:6;maxFn=${opts.maxFunctionLines ?? 'def'}` (`parse-cache.ts:1103`) — the pgd namespace version is separate from `SCHEMA_BUMP` by design (`parse-cache.ts:1098-1100`).
- Runtime view: `interface ParseCache { version; entries: Map<string, ParseWorkerResult[]>; usedKeys: Set<string>; staleKeys?: Set<string>; storagePath?; onDiskKeys?: Set<string> }` (`parse-cache.ts:994-1025`).
- Load/save: `loadParseCache(storagePath): Promise<ParseCache>` (`parse-cache.ts:1326`), `saveParseCache(storagePath, cache): Promise<string[]>` (`parse-cache.ts:1342`), `pruneCache(cache, usedHashes): number` (`parse-cache.ts:1409`), `emptyParseCache(storagePath?)` (`parse-cache.ts:1428`).
- Version rejection is a hard gate: `data.version !== PARSE_CACHE_VERSION` → empty cache (`parse-cache.ts:1272`, `1296`).
- **`--force` still reuses this cache.** `run-analyze.ts:2882-2894` and the log at `run-analyze.ts:3007-3014`; `parse-cache.ts:22`: *"`--force` still reuses content-addressed shards (it only rebuilds graph/FTS)."*

### 2.3 (parse reuse, durable) `ParsedFile` store — `gitnexus/src/storage/parsedfile-store.ts`

Two directories with different lifetimes:

| Store | Dirname constant | Lifetime |
|---|---|---|
| run-scoped | `STORE_DIRNAME = 'parsedfile-store'` (`parsedfile-store.ts:73`) | *"cleared at the start of each parse and after scope-resolution consumes it, so it never lingers"* (`parsedfile-store.ts:28-31`) |
| **durable / content-addressed** | `DURABLE_DIRNAME = 'parsedfile-cache'` + `DURABLE_INDEX_FILENAME = 'index.json'` (`parsedfile-store.ts:74-75`) | *"mirrors the parse cache's lifecycle (persists across runs, pruned by `usedKeys`, version-tied via `PARSE_CACHE_VERSION`)"* (`parsedfile-store.ts:41-48`) |

Key = **the same chunk hash** as the parse cache. Version gate: `!isRecord(idx) || idx.version !== expectedVersion` (`parsedfile-store.ts:747-752`), published by `mergeStagedDurableParsedFileStore(liveStoragePath, stagedStoragePath, version, keepKeys)` (`parsedfile-store.ts:859-865`), called from `run-analyze.ts:5550-5555` with `PARSE_CACHE_VERSION`.

Why it matters: on a warm chunk hit no worker runs, and the cached `ParseWorkerResult` carries no `ParsedFile`s — so without this store, scope-resolution would re-extract on the main thread (the #1983 OOM). See `parsedfile-store.ts:33-49`.

### 2.4 (DB row reuse) Subgraph extraction

`gitnexus/src/core/incremental/subgraph-extract.ts`:

```ts
export const extractChangedSubgraph = (            // :145-149
  fullGraph: KnowledgeGraph,
  toWriteSet: ReadonlySet<string>,
  options?: { includeDerivedGraphWide?: boolean },
): KnowledgeGraph

export const computeEffectiveWriteSet = (          // :194-197
  fullGraph: KnowledgeGraph,
  toWriteSet: ReadonlySet<string>,
): Set<string>
```

Inclusion rule (`:155-174`): node included iff `toWriteSet.has(node.properties.filePath)` **or** the node is graph-wide (`Community`, `Process`, `Destination`, Spring AOP evidence, Spring auto-config synthetic classes — `:82-87`). Relationship included iff either endpoint is writable **or** the relationship is graph-wide (`TAINT_PATH`, `CALL_SUMMARY`, `INJECTS`, `ADVISED_BY`, Spring auto-config `DECLARES` — `:122-130`).

`computeEffectiveWriteSet` expands by one hop along any file-owned edge crossing the writable boundary (`:200-209`) — this exists because a barrel/re-export change can re-target a `CALLS` edge between two *byte-identical* files (`:32-49`).

### 2.5 (derived-layer reuse) Communities / Processes — only on an **empty** diff

`gitnexus/src/core/incremental/derived-writeback.ts:43-45`:

```ts
export const shouldPreservePersistedDerivedGraph = (
  diff: Pick<FileHashDiff, 'deleted' | 'added' | 'changed'>,
): boolean => diff.deleted.length === 0 && diff.added.length === 0 && diff.changed.length === 0;
```

Docstring `:32-42`: *"Deletions disqualify it… Added or content-changed files also disqualify it… File-deletion-only was too weak a proof."* Consumed at `run-analyze.ts:3103-3112` together with `!processDetectionMismatch`.

Also in this module: `ftsTablesAmong(tables)` (`:23-29`), `incrementalFtsTablesFromGraph(graph, fileSet)` (`:56-67`), `nodeTablesForIncrementalDelete(allNodeTables, rebuildingFtsTables)` (`:77-83`) — the FTS index narrowing described at `run-analyze.ts:4004-4034`.

### 2.6 NOT a reuse unit: the scope index store

`gitnexus/src/storage/scope-index-store.ts:25` — *"Default-off: only constructed when `GITNEXUS_DISK_SCOPE_INDEX` is set."* `STORE_DIRNAME = 'scope-index-store'` (`:36`), `getScopeIndexStoreDir(storagePath)` (`:46-47`), and `persistScopeShards` **calls `clearScopeIndexStore(storagePath)` first** (`:81`, clearing at `:60-61`). It is a debug memory-offload facility, **not** an incremental artifact.

### 2.7 Reuse-unit summary

| Unit | Key | Cross-run? | Gates |
|---|---|---|---|
| File hash map | repo-relative path → sha256(content) | yes | nothing; it *is* the gate |
| Parse cache chunk | `sha256(sorted filePath:contentHash)` (+pdg ns) | yes | `PARSE_CACHE_VERSION`, 128 buckets, 2 MiB budget |
| Durable ParsedFile | same chunk hash | yes | `PARSE_CACHE_VERSION`, pruned to `saveParseCache` survivors |
| Run-scoped ParsedFile | same chunk hash | **no** | cleared per run |
| DB rows | file path (node `filePath` property) | yes | `diffFileHashes` → effective write set |
| Community/Process rows | — | only if diff is empty | `shouldPreservePersistedDerivedGraph` |
| scope-index-store | shard index | **no** | cleared per persist |

---

## 3. What forces a full rebuild (escalation)?

### 3.1 The reason vocabulary

`gitnexus/src/core/rebuild-reasons.ts:17-37` — the canonical, closed list:

```ts
export const REBUILD_REASON_KEYS = [
  'user-force', 'skills', 'parse-cache-bypass', 'drop-embeddings',
  'interrupted-rebuild', 'private-graph-unavailable', 'shared-store-missing-graph',
  'content-retention', 'pdg-mode', 'schema-fingerprint', 'graph-write-collapse',
  'analysis-features', 'spring-vendor-prefixes', 'runner-identity', 'cjk-segmentation',
  'embedding-dims', 'spring-actuator', 'asyncapi', 'escalated-full-write',
] as const;
```

`RebuildReason { key, text, forcing?: false }` (`:41-46`) — `forcing: false` marks a reason that is *announced but does not force* (only `escalated-full-write` today). `RebuildReasonCollector` (`:89-209`) owns `forced` (`:132-137`), `formatSummary()` (`:151-158`), `formatFollowUp()` (`:164-169`), `toStored()` (`:176-184`), `recordInterruptedRebuild(stored, dirtyDetails?)` (`:115-129`).

The collected key list is returned as `AnalyzeResult.rebuildReasons: RebuildReasonKey[]` (`run-analyze.ts:786`, populated at `:1932`, `:2696`, `:5574`). **Caveat for a driver:** a repo-wide grep shows *no reader* of `rebuildReasons` anywhere in `gitnexus/src` — it is produced but not consumed, and it is **not** on the analyze-worker IPC allowlist (§8.5).

### 3.2 Forcing gates, with sites

| Reason key | Trigger predicate | Site |
|---|---|---|
| `user-force` | `options.force` | `run-analyze.ts:1530` |
| `skills` | `options.skills` (needs fresh `pipelineResult`) | `:1533-1537` |
| `parse-cache-bypass` | `options.useParseCache === false` | `:1539-1543` |
| `private-graph-unavailable` | shared-store graph cannot be materialized | `:1619-1621` |
| `content-retention` | `contentRetentionMismatch(existingMeta, contentRetention)` | `:1695-1697`, `:2170-2178` |
| `drop-embeddings` | `--drop-embeddings` with an `embeddingCheckpoint` | `:1989-1991` |
| `pdg-mode` | `pdgModeMismatch(existingMeta.pdg, options)` (`:1205`) | `:2152-2165` |
| `schema-fingerprint` | `schemaFingerprintMismatch(existingMeta.schemaFingerprint)` (`core/lbug/schema.ts:846`) | `:2207-2220` |
| `graph-write-collapse` | `existingMeta.graphWriteCollapsed` set | `:2237-2246` |
| `analysis-features` | pre-pipeline `findAnalysisFeatureMismatches(...)` (`:2268-2275`) and post-pipeline re-check (`:3040-3052`) |
| `spring-vendor-prefixes` | `existingMeta.springVendorPrefixes !== springVendorPrefixesKey()` | `:2279-2290` |
| `runner-identity` | `!analyzerRunnerIdentitiesEqual(existingMeta.runnerIdentity, runnerIdentity)` (`core/analyzer-identity.ts:2842`) | `:2296-2307` |
| `cjk-segmentation` | `cjkSegmentationModeMismatch(...)` | `:2309-2320` |
| `embedding-dims` | `EMBEDDING_DIMS` vs recorded width | `:2354-2356` |
| `spring-actuator` | Actuator enrichment requested *or* being disabled | `:2390-2408` |
| `asyncapi` | AsyncAPI doc reading requested *or* being disabled | `:2432-2441` |
| `shared-store-missing-graph` | slot records a commit but the graph file is absent | `:2475-2482` |
| `interrupted-rebuild` | `meta.incrementalInProgress` set (crash recovery) | `RebuildReasonCollector.recordInterruptedRebuild`, `rebuild-reasons.ts:115-129`; dirty flag shape `RepoMeta.incrementalInProgress` at `repo-meta.ts:437-478` |
| `escalated-full-write` | see §3.3 — **non-forcing** | `:3880-3890` |

`addGateReason` (`:2138-2140`) suppresses gate reasons when the prior meta is a crashed *first build* claim (`priorIsFirstBuildClaim`, `:2134-2137`).

### 3.3 The escalation valve (write-plan change, not a rebuild)

`gitnexus/src/core/incremental/escalation-gate.ts`:

```ts
export const INCREMENTAL_MAX_WRITE_FRACTION = 0.5;   // :23
export const INCREMENTAL_ESCALATION_MIN_FILES = 50;  // :29

export const shouldEscalateIncrementalWrite = (      // :50-56
  deleteCount: number,
  effectiveWriteCount: number,
  totalFiles: number,
): boolean =>
  deleteCount >= INCREMENTAL_ESCALATION_MIN_FILES &&
  effectiveWriteCount / Math.max(1, totalFiles) > INCREMENTAL_MAX_WRITE_FRACTION;
```

Called at `run-analyze.ts:3740-3744`. On escalation the run switches to "wipe + bulk COPY of the already-built graph" (`:3960-3978`) and emits the non-forcing reason (`:3880-3890`). The docstring at `:41-48` documents a **known population mismatch**: the numerator can include now-deleted paths, so the fraction can exceed 1 — it errs toward escalation, which is the safe direction.

**Second escalation cause:** a blocked LadybugDB extension. `ensureEmbeddingRowDmlSafe(indexCatalogRows)` and `ensureFtsRowDmlSafe(indexCatalogRows, {skipFts})` (`:3679-3682`); if either fails, `extensionForcedRebuild = true` and the same wipe-and-COPY plan runs (`:3745+`). Cause text at `:3796-3835`. This is documented operator-facing at `GUARDRAILS.md:34`.

The `escalated-full-write` path also **re-derives the held-back derived layers** before wiping (`run-analyze.ts:3747-3754`).

### 3.4 Disqualifiers that are *not* "reasons"

These silently block incremental without contributing a rebuild reason:

- `isManualCheckpointEnabled() === false` → `isIncremental = false` (`run-analyze.ts:3082-3085`); predicate at `core/lbug/wal-checkpoint-driver.ts:278-283`, env `GITNEXUS_WAL_MANUAL_CHECKPOINT` (`0|false|off|no` disables). Log: *"Manual WAL checkpoints are disabled; switching to a full DB write before mutation."*
- `repoHasGit === false` → never incremental (`run-analyze.ts:3077`); CLI warns at `cli/analyze.ts:1001`: *"no .git directory found — commit-tracking and incremental updates disabled."*
- No `fileHashes` / empty file list (`run-analyze.ts:3075-3078`).

### 3.5 The dirty-flag contract (crash safety)

The metadata is stamped **before any destructive mutation**, on both branches:

- incremental: `run-analyze.ts:3208-3225` (`phase: 'pre-write'`);
- full rebuild: `run-analyze.ts:3249-3261` (`phase: 'full-rebuild'`, `toWriteCount: 0` sentinel).

The stamp is refreshed through the writeback via `saveIncrementalDirtyState(phase, extra)` (`run-analyze.ts:3448-3470`), carrying `importerExpansion`, `shadowSeedCount`, `effectiveWriteCount`, `deleteCount`, `droppedImporterChunks`, and the stored rebuild reasons. Any crash between stamp and successful meta write ⇒ next run collects `interrupted-rebuild` and forces a full rebuild.

---

## 4. What is NOT incremental

This is the critical section for a driver. **The in-memory graph is rebuilt in full every run.** `parse-cache.ts:3-5`:

> *"The pipeline always parses every file (correctness invariant: cross-file resolution and downstream phases need full graph data)."*

and `bench/analyze-phase-breakdown.md:233-238`:

> *"A one-file edit re-emits all 163,094 edges to write a 3,980-node subgraph. Every pass above runs over all 2121 TypeScript files because the pipeline rebuilds the full in-memory graph every run and only the DB write is incremental."*

### 4.1 Per-subsystem verdict

| Subsystem | Incremental? | Evidence |
|---|---|---|
| **scopeResolution** | **NO** — full graph, always | `pipeline.ts:343` registers `scopeResolutionPhase` unconditionally; `bench/analyze-phase-breakdown.md:76` = ~13.9s, **44%** of a one-file-edit run. `:216-238`: `emit` alone is 7.2s and *"The win is not running them."* |
| **parse (tree-sitter dispatch)** | **YES** at chunk level | `parse-cache.ts`; `bench/analyze-phase-breakdown.md:79` parse ≈2.8s / 9%; `:186-187` *"2121/2121 pre-extracted hits on the TypeScript pass. Nothing here re-parses."* |
| **FTS indexes** | **PARTIAL** — narrowed to touched tables, but each touched table is rebuilt whole | `run-analyze.ts:4003-4043` (`nodeTablesWithRowsForFiles` probe + `ftsTablesAmong` + `incrementalFtsTablesFromGraph` + `missingSearchFTSIndexTables`), `dropSearchFTSIndexes(indexCatalogRows, ftsIndexes, incrementalFtsTablesRebuildTables)`. `bench/analyze-phase-breakdown.md:99-119`: **8 of 20** indexes, 7.5s, `File.file_fts` = 3541ms alone. Table list: `core/search/fts-schema.ts:28-59` (`FTS_INDEXES`, 20+ definitions incl. `route_fts`) |
| **DB graph write** | **YES** — subgraph only | `run-analyze.ts:3387+`, `extractChangedSubgraph`, `deleteNodesForFiles(filesToDelete, …)` at `:4055-4061`; `bench:78` = 3.6s / 11% |
| **Communities (Leiden)** | **NO** unless diff is empty | `derived-writeback.ts:43-45`; `run-analyze.ts:3103-3112`; `deleteAllCommunitiesAndProcesses()` at `:4072`. Phase skipped pre-pipeline only as a *bet*: `skipDerivedGraphPhases` (`:2923-2930`) |
| **Processes / flows** | **NO** unless diff is empty | same as above; `processesPhase` at `pipeline.ts:363-365`; also re-run on `processDetectionMismatch` (`run-analyze.ts:3108`) |
| **MRO** | **NO** — runs on every non-`skipGraphPhases` run | `pipeline.ts:357` `mroPhase` `enabledWhen: (o) => !o.skipGraphPhases`; `mro-processor.ts` (34 KB) |
| **DI (INJECTS)** | **NO** — delete-all + full re-extract | `run-analyze.ts:4074-4086` `deleteAllInjects()`; graph-wide rel rule `subgraph-extract.ts:104-115` |
| **Spring AOP (ADVISED_BY)** | **NO** | `run-analyze.ts:4087-4091` `deleteAllAdvisedBy()` + `deleteSpringAopEvidenceNodes()`; graph-wide rule `subgraph-extract.ts:126-129` |
| **Destinations (async messaging)** | **NO** | `run-analyze.ts:4092-4103` `deleteAllDestinations()`; graph-wide node rule `subgraph-extract.ts:61-87` |
| **Spring auto-configuration** | **NO** | `run-analyze.ts:4104-4112` (`deleteSpringAutoConfigurationDeclarations`, `deleteSpringAutoConfigurationSyntheticClasses`) |
| **TAINT_PATH / CALL_SUMMARY** | **NO** (pdg only) | `run-analyze.ts:4113-4119`; graph-wide rel rule `subgraph-extract.ts:122-125` |
| **Embeddings** | **PARTIAL** — Phase 4 only when requested; cached rows restored per-file | Phase 4 gate `run-analyze.ts:4687` (`shouldGenerateEmbeddings`); Phase 3.5 restore at `:4361-4394` — *"Runs on BOTH the full-rebuild path and the incremental path"*, and `:4369-4370` explicitly notes that gating the restore on `!isIncremental` *"silently lost changed-file embeddings"* |
| **Group / bridge DB** | **NO** — rebuilt from scratch | `core/group/bridge-db.ts:265` `path.join(groupDir, 'bridge.lbug')`, replacement at `:1126-1140` (+ `bridge.lbug.bak`); `core/group/bridge-schema.ts:10`: *"`group sync` that rebuilds `bridge.lbug` from scratch"*; dir `~/.gitnexus/groups` (`core/group/storage.ts:15`) |
| **Wiki** | **NO** — separate command, LLM-generated | `cli/wiki.ts` is its own command (`cli/index.ts:408-443`); its only up-to-date check is `result.mode === 'up-to-date'` at `cli/wiki.ts:710` |
| **scope-index-store** | **NO** — cleared per run | `scope-index-store.ts:60-61`, `:81` |
| **AGENTS.md / CLAUDE.md / skills** | n/a — regenerated by analyze, skipped by watch | `AnalyzeOptions.skipAgentsMd`/`skipSkills` (`run-analyze.ts:489-494`); `skipAgentsMd: true, skipSkills: true, noStats: true` in watch (`analyze-watch.ts:205-207`) |

### 4.2 Consequence

An external driver should expect an incremental update of a one-file change on a mid-size repo (2 200 parseable files, 51 k nodes / 163 k edges — the repo's own corpus) to cost **~30s, not milliseconds** — and to be dominated by work that is *not* proportional to the change.

---

## 5. Watch mode

**CLI command:** `gitnexus analyze --watch [path] [--debounce <ms>]` — `cli/index.ts:77-78`. `--debounce` without `--watch` is rejected in a `preAction` hook: `cli/index.ts:237-240` (`--debounce requires --watch`, exit 1).

(`gitnexus watch [action]` is a *different*, deliberately-ambiguous command that only prints guidance — `cli/index.ts:57-63`, dispatching to `cli/watch.ts:watchAmbiguousCommand`.)

**Advancing the pointer:** `cli/analyze.ts:956-957` — `const { watchCommandWithRunnerIdentity } = await import('./analyze-watch.js'); await watchCommandWithRunnerIdentity(runnerIdentityAtBootstrap, inputPath, options);`

### 5.1 The watcher

`cli/analyze-watch.ts:326-340`:

```ts
const created: FSWatcher = watch(repoPath, {
  ignoreInitial: true,
  atomic: true,
  followSymlinks: false,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
  ignored: (candidate, stats) => { … },
});
```

- Only three chokidar events are consumed — `analyze-watch.ts:343-349`:

```ts
created.on('all', (event, changedPath) => {
  if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
  …
  queue.enqueue(relative);
});
```

- `.gitnexus/**` is excluded at both layers (`isAnalyzerOwnedWatchPath`, `:67-70`; used at `:334` and `:346`) so the analyzer cannot watch its own output.
- `.gitignore`, `.gitnexusignore`, `.gitnexusrc` are **not** ignored (`:335-337`) and are **priority paths** (`:322`): batching one reloads the ignore predicate and/or re-resolves the analyze config, then **re-arms the watcher** (`:378-400`). Re-arming is a deliberate replace-and-await-`ready` dance, not `add()` — the reason is documented at `:369-377` (an unignored file is still unregistered when `add()` returns, and `ignoreInitial` suppresses its `add`).
- Watcher errors with `EACCES|ENOENT|ENOTDIR|EPERM` (`TRANSIENT_WATCH_ERROR_CODES`, `:39`) re-arm and enqueue one full catch-up refresh (`:357-360`); anything else is fatal (`:362`).

### 5.2 Debounce and coalescing

`cli/watch-queue.ts` — `class WatchRefreshQueue` (`:16-184`):

- Constructor `(refresh: WatchRefresh, onError: WatchRefreshError, debounceMs: number, options: WatchRefreshQueueOptions = {})` (`:28-35`); `WatchRefresh = (paths: readonly string[]) => Promise<void>` (`:1`).
- Options actually used by watch (`analyze-watch.ts:318-323`):

```ts
{
  maxWaitMs: Math.max(2_000, debounceMs * 10),
  maxPendingPaths: 1_000,
  holdEventsUntilInitialRefresh: true,
  isPriorityPath: (filePath) => isIgnoreControlPath(filePath) || isConfigControlPath(filePath),
}
```

- Default debounce: `const DEFAULT_DEBOUNCE_MS = 300;` (`analyze-watch.ts:36`).
- **Never overlapping:** `enqueue` only schedules when `this.active === undefined` (`:41`), and `drain` returns early if `this.active !== undefined` (`:120`). Refresh work is held in `this.active` (`:139`).
- **Coalescing:** `pending` is a `Set<string>` (`:17`); a duplicate is a no-op (`:47-48`).
- **Overflow → whole-repo refresh:** past `maxPendingPaths`, `overflowed = true` (`:52`) and the next batch's path list is prefixed with `WATCH_FULL_REFRESH_PATH` (`:122`), which is `'*'` (`:4`). A priority path may evict a non-priority pending path to stay in the set (`:53-61`).
- **Retry with exponential backoff:** on a rejected refresh, the paths are re-enqueued and `retryDelayMs = min(30_000, max(250, debounceMs) * 2**(failures-1))` (`:152-161`); a new event cannot pull the retry earlier (`:107-112`).
- **Initial refresh:** `runInitial()` (`:66-76`) runs the first refresh with events still queueing (`holdEventsUntilInitialRefresh`), and `waitForIdle()` (`:78-81`) is the drain barrier.
- `close()` (`:83-97`) clears timer/pending and consumes a pending rejection once.

### 5.3 What a refresh actually re-runs

`analyze-watch.ts:525-536`: `runFullAnalysis(repoPath, analyzeOptions, {onProgress: () => {}, onLog: GITNEXUS_VERBOSE==='1' ? … : undefined}, runnerIdentityAtBootstrap)`.

The option set is built by `resolveWatchOptions(repoPath, cli, baseline, reportIgnoredConfig)` (`analyze-watch.ts:102-210`), which returns only (`:193-209`):

```ts
{
  pdg, skipFts, branch, registryName: merged.name, allowDuplicateName,
  workerPoolSize, maxProcesses, maxProcessBranching, maxProcessTraceDepth,
  maxEntryPointCandidates, fetchWrappers,
  skipAgentsMd: true, skipSkills: true, noStats: true,
  atomicIncremental: process.platform !== 'win32',
}
```

`force` is absent → watch always requests the incremental path (still subject to all §3 gates).

**Flags rejected under `--watch`** (`analyze-watch.ts:110-144`): `--force`, `--no-parse-cache`, `--repair-fts`, `--embeddings`, `--drop-embeddings`, `--skills`, `--default-branch`, `--skip-agents-md`, `--skip-skills`, `--no-stats`, `--self-commit`, `--index-only`, `--skip-git`, `--spring-actuator`, `--asyncapi-spec`, `walCheckpointThreshold`, `embeddingThreads`, `embeddingBatchSize`, `embeddingSubBatchSize`, `embeddingDevice`, `embeddingBaseUrl`, `embeddingModel`, `--embedding-auth-token`, `--embedding-dims` — error text: `` `analyze --watch does not support ${…}` `` (`:141-143`).

**Fatal vs retryable** — `shouldStopAfterWatchRefreshFailure(error, paths)` (`analyze-watch.ts:261-273`): fatal if `isIndexLockGuardTimeout(error)` **or** (paths non-empty and not a `WatchControlReloadError` and `analyzeFailureMayHaveMutatedLiveIndex(error)`).

**Reported per refresh** — `refreshSummary(result, observedPaths, durationMs, lastSuccessfulRefreshAt)` (`analyze-watch.ts:212-232`):

```
Refresh complete: N changed, M re-parsed, K affected dependent(s), <ms>ms, <mode>; last success <iso>
```

where mode = `result.incrementalStats?.writeMode ?? (alreadyUpToDate ? 'no-op' : 'full')`.

---

## 6. Concurrency / locking

### 6.1 The index lock

`gitnexus/src/storage/index-lock.ts` — a cross-process single-writer lock scoped to the **resolved index slot directory** (`run-analyze.ts:1411-1412`: `acquireIndexLock(writeTarget.metaDir, acquireOpts)`).

```ts
export const acquireIndexLock = async (       // index-lock.ts:905-908
  lockDir: string,
  opts: AcquireOptions = {},
): Promise<IndexLockHandle>
```

- `IndexLockHandle { record: LockRecord; lockFree?: true; release(): void }` (`:110-134`).
- `requireExclusiveIndexLock(handle, message)` (`:190-192`) throws if `lockFree` — writers must fail closed. Called at `run-analyze.ts:1415-1418`.
- **Two backends** (`selectBackend()`, `:890-894`; override `GITNEXUS_INDEX_LOCK_BACKEND=socket|file`):
  1. **socket** (default on Windows + Linux) — Windows named pipe `\\.\pipe\gitnexus-idx-<sha256(realpath)[0:32]>`, Linux abstract socket `\0gitnexus-idx-…` (`socketLockName`, `:776-785`). Kernel-owned: `EADDRINUSE` *is* a live holder, and the binding dies with the process for any exit cause. *"no stale detection, no reclaim, and no takeover race"* (`:803-810`).
  2. **file** (macOS/BSD, or socket-unavailable) — `LOCK_FILENAME = 'analyze.lock'` (`:67`) plus a sibling `analyze.lock.guard` (`:69`), created `O_EXCL` (`openSync(guardPath, 'wx')`, `:549`).
- Lock record (`:99-108`): `{v:1, pid, hostname, startTime: string|null, token, invocationId, acquiredAt}`.
- **Stale recovery** (file backend only): `isStale(holder)` (`:290-296`) = same-host AND (`!isProcessAlive(pid)` OR Linux `/proc/<pid>/stat` field-22 start-time differs ⇒ pid reused). *"A live holder is never stolen on age alone… a foreign-host holder is never stale."* Malformed/partial lock file is reclaimed only after `malformedGraceMs(pollMs) = max(1000, pollMs*2)` (`:91`, `:619-627`).
- **Guard is non-stealable**: `GUARD_TIMEOUT_MS = 30_000` (`:84`); orphan guard ⇒ `IndexLockTimeoutError` with `guardPath` set, requiring quiesced manual recovery (RUNBOOK.md) — `:315-348`, `:184-187` `isIndexLockGuardTimeout`.
- **Wait ceiling**: `DEFAULT_TIMEOUT_MS = 600_000` (`:82`), env `GITNEXUS_INDEX_LOCK_TIMEOUT_MS` (≤0 ⇒ unbounded) — `resolveTimeoutMs` (`:485-499`). Poll `DEFAULT_POLL_MS = 250` jittered (`:72`, `:474-478`); wait diagnostics every 15 s (`:74`).
- **Orphan sweep on acquire**: `sweepStagingArtifacts(lockDir, log)` (`:443-467`) deletes `lbug.new*` / `lbug.staging.*` files not referenced by an embedding-recovery checkpoint; called from `acquireIndexLock` (`:924`) unless `opts.sweep === false`.
- **Read-only tolerance**: `LOCK_UNWRITABLE_CODES = {EROFS, EACCES, EPERM}` (`:401`) ⇒ a `lockFree` no-op handle, but only when neither lock nor guard exists (`deniedCreateHandle`, `:415-432`).

### 6.2 Single-flight coalescing

`run-analyze.ts:1419-1457`: after acquiring, the write target is **re-resolved under the lock** (git HEAD/branch may have moved while waiting); if the slot moved, the lock is released and re-acquired, bounded by `MAX_RELOCK = 3` (`:1431`). After that, the run re-checks freshness, so a run whose work the holder already did returns `alreadyUpToDate` (`run-analyze.ts:1366-1373`).

### 6.3 Atomic publication

- Full rebuild / escalated write (POSIX): build into `<lbugPath>.staging.<randomUUID()>` (`:3197`) and rename at the end; `useAtomicSwap = (isFullRebuild || atomicIncremental) && (posixSwap || windowsSwapOk)` (`:3187`). Windows swap is opt-in via `GITNEXUS_ATOMIC_WINDOWS_SWAP=1` (`:3139-3142`).
- Incremental staging (watch/auto-sync): `atomicIncrementalEligible = isIncremental && !!hashDiff && platform !== 'win32'` (`:3152`); requested by the caller or `GITNEXUS_ATOMIC_INCREMENTAL=1`; **off-switch `GITNEXUS_ATOMIC_INCREMENTAL=0` wins over the caller** (`:3151-3170`). Staging is taken only when the live index has no orphan WAL/shadow sidecars (`:3176-3180`).
- Escalation discovered late upgrades to staging if the index catalog was readable (`:3951-3959`).

### 6.4 Other locks

- **auto-sync watch mutex**: `~/.gitnexus/watch/watch.mutex` — `getAutoSyncMutexPath` (`core/auto-sync/state.ts:29-31`), taken via `acquireFileLock` (`state.ts:44`) from `storage/file-lock.ts:37` `acquireFileLock`, `FileLockBusyError` at `:27`. Owner/pid/status files: `watch.pid`, `watch.owner.json`, `watch.status.json` (`core/auto-sync/starter.ts:64-72`).
- **Registry writes**: `REGISTRY_LOCK_TIMEOUT_MS = 5_000` (`storage/repo-manager.ts:595`).
- **Group sync**: `core/group/group-lock.ts` (replaces `contracts.json` + `bridge.lbug` atomically).
- **Shared store**: `withStoreLock(store, scope, fn)` (`storage/shared-store-lifecycle.ts:41`); cache save runs under `'cache'` scope (`run-analyze.ts:5558-5560`).

### 6.5 Can an external process safely drive an update?

**Yes, with three rules:**

1. **Call `runFullAnalysis` in-process, or fork the analyze worker, or shell out to `gitnexus analyze`.** All three acquire the index lock themselves (`run-analyze.ts:1412`) and fail closed if they cannot (`:1415-1418`). Do **not** implement your own variant that writes `lbug` directly — the lock is not advisory at the DB layer, and `deleteNodesForFiles` + FTS index lifecycle assume exclusive DB ownership (`run-analyze.ts:4062-4067`).
2. **Never write `<slot>/gitnexus.json` / `meta.json` / `lbug` by hand.** The dirty flag (`incrementalInProgress`) and the `fileHashes` map are the coherence contract; a hand-edited meta makes the next run either force-rebuild (safe) or trust a wrong baseline (unsafe).
3. **Handle the two lock failure modes**: `IndexLockTimeoutError` (`:163-182`) with `guardPath` set ⇒ quiesced manual recovery, do not retry in a loop; IPC `ErrorMessage.code === 'index-lock-timeout'` with `retryable: false` for the guard case (`server/analyze-worker-protocol.ts:57-75`).

**Cross-host caveat:** the socket backend's mutual-exclusion domain is *not* uniform — Windows pipes are machine-wide, but Linux abstract sockets are **network-namespace scoped**, so two containers sharing a bind-mounted index dir do **not** collide. The module says so explicitly and names the remedy: `GITNEXUS_INDEX_LOCK_BACKEND=file` (`index-lock.ts:875-889`).

---

## 7. Index artifacts on disk

### 7.1 Name constants

`gitnexus/src/storage/storage-constants.ts:2-6`:

```ts
export const GITNEXUS_DIR = '.gitnexus';
export const INDEX_METADATA_FILE = 'gitnexus.json';
export const LEGACY_METADATA_FILE = 'meta.json';
export const LBUG_DIRECTORY = 'lbug';
```

### 7.2 Observed layout (this checkout, real measurement)

`D:\Project\GitNexus\.gitnexus\`:

```
d----- parse-cache
d----- parsedfile-cache
-a---- .gitignore          2 B
-a---- gitnexus.json       411 075 B     <- index metadata (large: contains fileHashes)
-a---- meta.json           411 075 B     <- legacy mirror, byte-identical
-a---- lbug                463 843 328 B <- LadybugDB database, ONE FILE (not a directory)
-a---- run.cjs             19 564 B      <- generated helper runner (ai-context.ts:639-650)
```

Note `lbug` is a **file**, despite the constant being named `LBUG_DIRECTORY`; `resolveGraphPath` returns `path.join(storagePath, 'lbug')` (`storage/shared-store.ts:264-283`).

### 7.3 Full layout produced by code

```
<repo>/.gitnexus/                                  <- flat / "workspace" slot
├── gitnexus.json                                  repo-manager.ts:248  (INDEX_METADATA_FILE)
├── meta.json                                      repo-manager.ts:224-226, 306-308 (dual-written mirror)
├── lbug                                           shared-store.ts:265  (single-file LadybugDB)
├── lbug.wal  /  lbug.shadow                       index-lock.ts:440 (LIVE sidecars, never swept)
├── lbug.wal.checkpoint/                           run-analyze.ts:3942 (checkpoint dir)
├── lbug.wal.dirty-recovery / lbug.shadow.dirty-recovery   GUARDRAILS.md:40 (crash forensics park)
├── lbug.staging.<uuid>[.wal]                      run-analyze.ts:3197, 3954  (atomic swap staging)
├── parse-cache/                                   parse-cache.ts:951
│   ├── index.json                                 parse-cache.ts:973 ({version, keys: string[]})
│   └── <64-hex chunkhash>.v8                      parse-cache.ts:1142-1143 (immutable V8 envelope)
├── parse-cache.json                               parse-cache.ts:950 (LEGACY single-file format)
├── parsedfile-cache/                              parsedfile-store.ts:74 (DURABLE, content-addressed)
│   ├── index.json                                 parsedfile-store.ts:75 ({version, entries})
│   └── <chunkHash>/…v8                            parsedfile-store.ts:629, 707
├── parsedfile-store/                              parsedfile-store.ts:73 (RUN-SCOPED, cleared per run)
├── parse-rebuild.<mkdtemp>/                       parse-cache.ts:958-971 (staging for --no-parse-cache)
├── scope-index-store/s<n>.json                    scope-index-store.ts:36, 46-47 (opt-in debug)
├── graph-csv/                                     run-analyze.ts:2987-2989 (TEMPORARY, streamed emit only)
├── analyze.lock                                   index-lock.ts:67  (file backend)
├── analyze.lock.guard                             index-lock.ts:69
├── store.json                                     shared-store.ts:35 (SHARED_STORE_POINTER)
├── run.cjs                                        cli/ai-context.ts:639-650
├── .gitignore                                     storage-resolver.ts:29
└── branches/                                      branch-index.ts:35 (BRANCHES_DIR)
    └── <slug>/                                    branch-index.ts:46-50
        ├── gitnexus.json                          repo-manager.ts:242-248
        └── lbug

~/.gitnexus/                                       global-dir.ts:5 (getGlobalDir)
├── registry.json                                  storage-resolver.ts:158
├── watch_config.yml                               auto-sync/config.ts:10
├── watch/                                         auto-sync/state.ts:25-27
│   ├── watch.mutex                                auto-sync/state.ts:29-31
│   ├── watch.pid  watch.owner.json  watch.status.json   auto-sync/starter.ts:64-72
│   ├── auto-sync-state.json                       auto-sync/state.ts:33-35
│   └── project_commit_info.txt                    auto-sync/state.ts:37-39 (YAML-ish text)
├── groups/                                        group/storage.ts:15
│   └── <group>/ bridge.lbug, contracts.json       group/bridge-db.ts:265
└── stores/<storeKey>/                             shared-store.ts:30 (STORES_DIR)
    ├── checkouts/<slot>/…
    └── commits/<commit>-<featureKey>/lbug         shared-store.ts:194-215, 277-282
```

Branch slug rule — `branch-index.ts:46-50`: `sanitizeRepoName(rawRef) + '-' + sha256(rawRef).slice(0,8)` (so `feature/x` and `feature_x` cannot collide).

Shared-store pointer rule — `shared-store.ts:290-323`: `<checkout>/.gitnexus/store.json` holds `{checkoutSlot, storeKey}`; both are re-validated against the store's own metadata before use ("a copied or hand-edited pointer cannot redirect reads to another index").

### 7.4 Formats

| Artifact | Format | Writer |
|---|---|---|
| `gitnexus.json`, `meta.json` | JSON (`RepoMeta`) | `saveMeta` (`repo-manager.ts:306+`) |
| `parse-cache/index.json`, `parsedfile-cache/index.json` | JSON `{version, keys|entries}` | `saveParseCache` (`parse-cache.ts:1342`), `pruneAndSaveDurableParsedFileStore` (`parsedfile-store.ts:784-846`) |
| `parse-cache/<hash>.v8`, `parsedfile-cache/<hash>/**.v8` | **V8 serialization envelope** (`node:v8`), never JSON | `writeV8CacheFile` (`storage/v8-sidecar.ts:344`), `writeV8CacheFileSync` (`:360`), loaded by `tryLoadV8Cache` (`:281`), inspected by `inspectV8Cache` (`:241`); `V8_CACHE_FORMAT = 5` (`:23`) |
| `lbug`, `bridge.lbug` | **LadybugDB native single-file DB** | `loadGraphToLbug` (`run-analyze.ts:3966`) |
| `graph-csv/` | CSV (streamed emit sink) | `GraphEmitSink(graph, graphEmitCsvDir)` (`pipeline.ts:401`) |
| `project_commit_info.txt` | line-oriented text (`remote:`, `local_path:`, `branch:`, `code_commit:`, …) | `writeProjectCommitInfo` (`auto-sync/state.ts:133-161`) |
| `watch_config.yml` | YAML (`js-yaml`) | `parseAutoSyncConfig` (`auto-sync/config.ts:181`) |
| `run.cjs` | JS helper | `cli/ai-context.ts:639-650` copies it from a template |

### 7.5 What a visualizer can read **directly**

**Short answer: the metadata, not the graph.**

- ✅ **`gitnexus.json`** is plain JSON and gives `stats {files,nodes,edges,communities,processes,embeddings}` (`repo-meta.ts:171-178`), `lastCommit`, `indexedAt`, `branch`, `capabilities`, and the complete `fileHashes` map (411 KB in this repo — do not parse it on a hot path).
- ✅ **`~/.gitnexus/registry.json`** is a JSON array of `RegistryEntry` — the discovery surface (§8.1).
- ❌ **There is no persisted JSON/CSV export of the graph.** `graph-csv/` exists **only** during a full rebuild with `streamGraphEmit` active; it is resolved on demand (`run-analyze.ts:2987-2989`) and is a write sink, not an artifact.
- ✅ To read the graph, a visualizer must either (a) open `lbug` with LadybugDB (`@ladybugdb/core` — the module's own convention, e.g. `mcp/core/lbug-adapter.ts`), or (b) call the HTTP API: `GET /api/graph` (`server/api.ts:1398`), `POST /api/query` (`:1480`), `POST /api/search` (`:1485`), `GET /api/processes` (`:1775`), `GET /api/clusters` (`:1811`).

**Single-file DB migration:** a single open handle is enough; the WAL sidecar must be replayed on open (the code treats `lbug.wal`/`lbug.shadow` as load-bearing: `index-lock.ts:440`, and the atomic-incremental path refuses to stage when they are present, `run-analyze.ts:3171-3180`).

---

## 8. Machine-readable surface for an external driver

### 8.1 `registry.json`

Path: `path.join(getGlobalDir(), 'registry.json')` — `storage/storage-resolver.ts:158`. Read via `readRegistry(): Promise<RegistryEntry[]>` (`repo-manager.ts:791`), `readRegistryStrict()` (`:812`), `readRegistryStrictIfPresent()` (`:820`).

```ts
export interface RegistryEntry {          // storage/repo-manager.ts:173-199
  name: string;
  path: string;
  storagePath: string;
  indexedAt: string;
  lastCommit: string;
  remoteUrl?: string;                     // mirrored from meta at register time
  stats?: RepoMeta['stats'];
  branch?: string;                        // branch owning the flat index (#2106)
  branches?: BranchSummary[];             // non-primary branch indexes
  shareOptOut?: true;                     // left sharing via `analyze --no-share`
}

export interface BranchSummary {          // storage/branch-index.ts:26-32
  branch: string;
  indexedAt: string;
  lastCommit: string;
  stats?: RepoMeta['stats'];
}
```

### 8.2 On-disk repo metadata (`gitnexus.json`) — the driver-relevant subset

Full interface: `storage/repo-meta.ts:111-663`. Loaded by `loadMeta(metaDir): Promise<RepoMeta | null>` (`repo-meta.ts:718-733`; falls back to `meta.json` only when `gitnexus.json` is *provably absent*; a parse error returns `null` on purpose).

Fields an external driver should read:

| Field | Line | Meaning |
|---|---|---|
| `repoPath`, `storagePath?`, `graphPath?` | `:112-120` | ownership + which graph this slot reads |
| `lastCommit`, `indexedAt` | `:121-122` | the indexed point (tested by the fast path, `run-analyze.ts:2495`) |
| `fileHashes?: Record<string,string>` | `:377-383` | **the incremental baseline** |
| `indexCoverage?: {maxFileSizeBytes, dirtyPaths?}` | `:392-395` | coverage policy used when `fileHashes` was recorded |
| `schemaFingerprint?` | `:246-269` | DDL digest; **absent ≡ mismatch** ⇒ forced rebuild |
| `analysisFeatures?: Record<string,number>` | `:275` | per-feature version stamps |
| `runnerIdentity?: AnalyzerRunnerIdentity` | `:68-97`, `:162` | analyzer provenance (schema v4); mismatch ⇒ forced rebuild |
| `capabilities?: {graph, fts, vectorSearch}` | `:194-244` | incl. `fts.skipReason` and `fts.writePlan` |
| `stats?` | `:171-178` | `{files,nodes,edges,communities,processes,embeddings}` |
| `pdg?`, `cjkSegmentation?`, `embeddingDims?`, `contentRetention?` | `:572-646`, `:290`, `:318`, `:124` | mode stamps that force rebuilds on change |
| `processDetection?` | `:655-662` | Community/Process budget stamp |
| `incrementalInProgress?` | `:437-478` | **crash dirty flag** — `{startedAt, updatedAt?, toWriteCount, phase?, writePlan?, checkpointSucceeded?, directWriteCount?, importerExpansion?, effectiveWriteCount?, deleteCount?, shadowSeedCount?, droppedImporterChunks?, reasons?: StoredRebuildReason[]}`. Non-null ⇒ the next run is a forced rebuild. |
| `embeddingCheckpoint?` | `:490-538` | embedding resume marker; non-null blocks the fast path |
| `graphWriteCollapsed?` | `:422-427` | forces a repairing rebuild |
| `branch?`, `cacheKeys?` | `:547`, `:555` | branch label; per-branch live parse-cache chunk keys (shared-cache pruning) |
| `unresolvedReceiverMembers?`, `scopeExtractionFailures?`, `scopeExtractionReceipt?`, `undecidedInterfaceSatisfaction?`, `nameFallbackEdges?`, `crossLanguageProperties?` | `:336-421` | answer-quality hedges (`epistemic` downgrades) |

### 8.3 Staleness payload (one shape on every surface)

`core/staleness-status.ts:104-117`:

```ts
export interface StalenessPayload {
  status: StalenessStatus;                 // 'current' | 'behind' | 'diverged' | 'unknown'
  branch?: string;                         // ref-carrying form only
  lastCommit?: string;
  indexedAt?: string;
  measuredAgainst?: 'HEAD';
  commitsBehind?: number;
  hint?: string;
}
```

Builder: `stalenessPayload(info, opts: { includeUnknown?: boolean; ref?: IndexedRef }): StalenessPayload | undefined` (`:129-156`). Semantics of each status are pinned at `:11-51` — crucially, `isStale`/`commitsBehind` keep historical **fail-open** values (`false`/`0`) on every `unknown`, so **read `status`, not `isStale`**.

Probe: `checkStaleness(repoPath, lastCommit)` (`core/git-staleness.ts:120-139`) and `checkStalenessAsync` (`:146-179`) — `git rev-list --left-right --count <lastCommit>...HEAD`, 5 s timeout (`:24`).

Emission sites:
- HTTP list: `projectRepoListEntry` (`server/repo-projection.ts:53-76`) — `staleness` absent when current, present otherwise (incl. `unknown` via `includeUnknown`).
- HTTP detail: `projectRepoDetail` (`:83-99`).
- MCP `list_repos` and the hot read tools (`query`/`context`/`impact`/`cypher`) — ref-carrying form; note text at `mcp/tools.ts:104-105`.

### 8.4 `analyze --json`? No — but `status --json` and `check --json` exist

`analyze` has **no `--json` flag** (`cli/index.ts:74-234`). Its structured surface is the returned `AnalyzeResult` (in-process) or the IPC projection (worker).

`gitnexus status --json` — flag at `cli/index.ts:342`, emitter at `cli/status.ts:379-405`:

```jsonc
{
  "schemaVersion": 1,
  "repository": "<repo path>",
  "branch": "<checked-out branch|null>",
  "workspaceIndexBranch": "<string|null>",
  "index": {
    "indexedAt": "<iso>",
    "commit": "<sha>",
    "capabilities": { /* RepoMeta.capabilities, when present */ },
    "runnerIdentity": { /* schema-v4 receipt | null */ },
    "runnerIdentityStatus": "current" | "stale-or-unknown",
    "incompleteReasons": [ /* IndexIncompleteReason[] */ ]
  },
  "current": { "commit": "<sha>", "runnerIdentity": { } },
  "contentDrift": { /* see below */ },
  "sharedStore": { "key": "…", "graph": "shared"|"private", "commit": "<sha>", "privateClone": "copy-on-write"|"copy"|null } | null,
  "legacyLocalIndex": { "path": "…", "bytes": 123 } | null,
  "status": "up-to-date" | "stale"
}
```

`contentDrift` descriptor — `cli/status.ts:58-71`: `{status: 'not-checked'}` | `{status:'current', coveredFiles:number}` | `{status:'unmeasurable', reason}` | `{status:'drifted', changed?, added?, deleted?}` (built from `detectIndexContentDrift(repoPath, fileHashes, coverage)` — `core/index-content-drift.ts:82-170`, three-way verdict at `:46-49`).

`incompleteReasons` vocabulary — `core/index-freshness.ts:5-12`:
`'incremental-in-progress' | 'embedding-checkpoint-pending' | 'embedding-count-unverified' | 'graph-write-collapsed' | 'scope-extraction-unverified' | 'scope-extraction-failed'`.

`gitnexus check --cycles --json` — flag at `cli/index.ts:559-560`, emits the raw tool payload via `output(result)` = `JSON.stringify(data, null, 2)` (`cli/tool.ts:56`, `:398-399`). Shape includes `status: 'clean'|'cycles_found'`, `cycles: [{files: string[]}]`, `enumeration`, `componentCount` (`cli/tool.ts:400-428`).

`gitnexus list` has **no `--json`** (`cli/index.ts:334-337`; `cli/list.ts` is prose-only) — use `registry.json` or `GET /api/repos`.

### 8.5 Analyze-result IPC projection (what a forked worker returns)

`server/analyze-worker-ipc.ts:53-64`:

```ts
export type AnalyzeResultIpc = Pick<
  AnalyzeResult,
  | 'repoName' | 'repoPath' | 'stats' | 'alreadyUpToDate'
  | 'ftsRepairedOnly' | 'ftsSkipped' | 'graphWriteCollapsed'
  | 'isPrimaryBranch' | 'storagePath'
>;
```

**Not on the wire:** `incrementalStats` and `rebuildReasons`. They exist only on the in-process `AnalyzeResult` (`run-analyze.ts:828-835` and `:786`). A driver that forks the worker therefore **cannot** learn `writeMode`/`reparsedFiles` from IPC — it must call `runFullAnalysis` in-process, or derive the same facts itself from `gitnexus.json` (`fileHashes` before/after, `incrementalInProgress`).

Worker protocol — `server/analyze-worker-protocol.ts`:

```ts
export interface StartMessage  { type: 'start'; repoPath: string; options: AnalyzeOptions }  // :30-34
export interface CancelMessage { type: 'cancel' }                                            // :37-39
export type ParentMessage = StartMessage | CancelMessage;                                    // :41
export interface ProgressMessage { type: 'progress'; phase: string; percent: number; message: string }  // :43-48
export interface CompleteMessage { type: 'complete'; result: AnalyzeResultIpc }              // :50-55
export interface ErrorMessage {                                                              // :57-75
  type: 'error'; message: string;
  code?: 'index-lock-timeout';
  retryable?: boolean;
}
export type WorkerMessage = ProgressMessage | CompleteMessage | ErrorMessage;                 // :78
```

Spawn shape (auto-sync): `fork(workerPath, [], {execArgv: ['--max-old-space-size=<n>'], stdio: ['ignore','pipe','pipe','ipc']})` — `core/auto-sync/analysis-worker-launch.ts:64-68`, heap sizing `resolveWorkerHeapMb(concurrency)` at `:83-86`.

### 8.6 `AnalyzeResult.incrementalStats` (in-process only) — the honest progress metric

`run-analyze.ts:828-835`:

```ts
incrementalStats?: {
  changedFiles: number;
  reparsedFiles: number;
  affectedDependents: number;
  deletedFiles: number;
  writeMode: 'incremental' | 'full';
};
```

Populated at `run-analyze.ts:3519-3525`; `writeMode` is corrected to `'full'` when the escalation valve fired (`:5580-5585`). **`writeMode: 'full'` does not mean a full pipeline run** — it means the DB write plan escalated; file-level bookkeeping stayed incremental (`escalation-gate.ts:9-10`).

---

## 9. Per-phase cost ordering, and how much incremental helps

### 9.1 The repo's own measurements

`gitnexus/bench/analyze-phase-breakdown.md` — measured 2026-09-06/07 on this repository (`git archive` of HEAD, 5350 paths / 2234 parseable / ~30 MB, 16 workers, local overlay FS).

**Cold full analyze** (`:58-64`):

| | before #3194 | after #3196 |
|---|---:|---:|
| total | 110.3 s | **63.6 s** |
| parse | 74.0 s | 36.0 s |
| scopeResolution | 17.0 s | 16.0 s |
| all other phases | 1.2 s | 1.2 s |

**Re-analyze after a one-file edit — the genuine incremental path** (`:69-81`, total **31.7 s**):

| step | ms | share |
|---|---:|---:|
| scopeResolution | ~13 900 | **44 %** |
| FTS index rebuild (`buildSearchIndexesOrDegrade`) | 7 525 | **24 %** |
| graph write (`loadGraphToLbug`, subgraph) | 3 566 | 11 % |
| parse | ~2 800 | 9 % |
| post-FTS event-loop drain | 845 | 3 % |
| everything else | ~3 000 | 9 % |

**Denominator note:** a *full-rebuild* run of the same corpus is 36–39 s (`:94-95`). So the measured incremental win on a **one-file, 2-importer** edit is ≈ **1.15×** wall-clock — because the pipeline dominates and the pipeline is not incremental.

`scopeResolution` internals on that edit (`:174-184`): ParsedFile store rehydration 4 426 ms (30 %), `emit` 7 161 ms (49 %), `resolve` 966 ms (7 %), `finalize` 552 ms (4 %), `extract` 369 ms (3 %).

### 9.2 Cost ordering for a large repo (synthesised from the above)

1. **`scopeResolution`** — the single largest phase on a full run (16 s) *and* the largest cost on the incremental path (13.9 s / 44 %). Not incremental, by design.
2. **parse** — 36 s cold, ~2.8 s warm (chunk-cache hits). The content-addressed cache is very effective here.
3. **FTS index (re)build** — ~10.2 s full / 7.5 s narrowed; **`File.file_fts` alone is 3 541 ms** because File rows carry whole-file content and Ladybug tokenizes at ~9.8 MB/s (`:118-119`). Documented as a floor: *"Ladybug's FTS is not incremental: an index built before an insert does not see the new row, so a changed row forces a whole-table rebuild"* (`:139-143`).
4. **DB graph write** — ~6.3 s full, 3.6 s incremental-subgraph.
5. Communities / processes / MRO / DI / AOP / destinations — inside "all other phases" ≈ 1.2 s cold on this corpus, but they are **not** proportional to the diff.
6. Embeddings — off by default; if on, a separate multi-second-to-minute pass (`run-analyze.ts:4503` "Phase 4: Embeddings (90–98%)").

### 9.3 Evidence that the incremental machinery works, and its ceiling

Working:
- The DB write is genuinely subgraph-scoped: *"the graph write was a 3 980-node subgraph, not the full 51 288"* (`:90`).
- The FTS narrowing is effective: 8 of 20 indexes on a leaf edit, and the extra 12 indexes cost only ~2.5 s (`:112-116`).
- Parse-cache reuse: 2121/2121 pre-extracted hits on the TypeScript pass (`:186-187`).
- Escalation threshold is a real safety valve rather than a correctness hazard (non-forcing, `rebuild-reasons.ts:44-45`, `escalation-gate.ts:50-56`).

Ceiling (quoted verbatim, `:233-238`):
> *"A one-file edit re-emits all 163 094 edges to write a 3 980-node subgraph. Every pass above runs over all 2121 TypeScript files because the pipeline rebuilds the full in-memory graph every run and only the DB write is incremental. Making `emit` incremental means knowing which files' edges can change when one file's registry contribution changes — which is a design, not a patch."*

### 9.4 Measurement traps (must-know for anyone benchmarking a driver)

`bench/analyze-phase-breakdown.md:13-44` lists three "silently fall back to full work" guards:
1. **Non-git corpus** ⇒ always full rebuild (`:15-22`).
2. **Analyzer binary changed between runs** (`dist` rebuilt/re-copied) ⇒ runner identity mismatch ⇒ always full rebuild (`:24-33`). *"To measure the incremental path, run once to stamp the identity, then edit and run again without touching `dist`."*
3. The escalation gate itself (`:42-44`).

A fourth is implicit: a changed `.gitnexusrc` `pdg`/`embeddings` key, `GITNEXUS_EMBEDDING_DIMS`, `GITNEXUS_FTS_CJK_SEGMENTATION`, or the `--max-processes` family will each force a rebuild (§3.2).

---

## Evidence table

| # | Claim | Evidence |
|---|---|---|
| 1 | Incremental is the default; `--force` is the opt-out | `GUARDRAILS.md:34`; `cli/index.ts:79`; `run-analyze.ts:3068` |
| 2 | No `--incremental` flag exists | `cli/index.ts:74-234` (full flag list) |
| 3 | Entry point + signature | `run-analyze.ts:1380-1385` |
| 4 | Eligibility predicate | `run-analyze.ts:3067-3078` |
| 5 | `isIncremental` also needs manual checkpoints | `run-analyze.ts:3082`; `wal-checkpoint-driver.ts:278-283` |
| 6 | Fast path is commit-equality | `run-analyze.ts:2490-2498`, `:2684-2702` |
| 7 | File-hash diff is the DB-write gate | `storage/file-hash.ts:93-118`; `run-analyze.ts:3087-3089` |
| 8 | Parse cache is chunk-level, 128 buckets, `(language, hash(path) mod 128)` | `parse-cache.ts:9-21`, `:905`, `:908-909`, `:919-948` |
| 9 | Cache version = `SCHEMA_BUMP + pkg version`; `SCHEMA_BUMP = 142` | `parse-cache.ts:872`, `:896` |
| 10 | Chunk key = sha256 of sorted `path:contentHash` (+ pdg ns) | `parse-cache.ts:1059-1105` |
| 11 | `--force` still reuses parse cache | `parse-cache.ts:22`; `run-analyze.ts:3007-3014` |
| 12 | Durable ParsedFile store shares `PARSE_CACHE_VERSION` | `parsedfile-store.ts:41-48`, `:747-752`, `:859-865` |
| 13 | Run-scoped ParsedFile store is cleared per run | `parsedfile-store.ts:28-31`, `:73` |
| 14 | scope-index-store is opt-in debug, cleared per persist | `scope-index-store.ts:25`, `:60-61`, `:81` |
| 15 | Subgraph extraction + 1-hop effective write set | `subgraph-extract.ts:145-177`, `:194-210` |
| 16 | Derived layer reused only on an **empty** diff | `derived-writeback.ts:43-45`; `run-analyze.ts:3103-3112` |
| 17 | Rebuild reason vocabulary (19 keys) | `rebuild-reasons.ts:17-37` |
| 18 | `escalated-full-write` is non-forcing | `rebuild-reasons.ts:44-45`; `run-analyze.ts:3880-3890` |
| 19 | Escalation predicate + thresholds (0.5, ≥50 deleted files) | `escalation-gate.ts:23`, `:29`, `:50-56`; call `run-analyze.ts:3740-3744` |
| 20 | Extension-blocked escalation (VECTOR/FTS) | `run-analyze.ts:3678-3683`, `:3745+` |
| 21 | Dirty flag written before any mutation, both branches | `run-analyze.ts:3208-3225`, `:3249-3261`; shape `repo-meta.ts:437-478` |
| 22 | Pipeline always rebuilds the full in-memory graph | `parse-cache.ts:3-5`; `bench/analyze-phase-breakdown.md:233-238` |
| 23 | scopeResolution is not incremental (44 % of an edit run) | `bench/analyze-phase-breakdown.md:76`, `:216-238`; `pipeline.ts:343` |
| 24 | FTS: narrowed but per-table full rebuild; 24 % of an edit run | `run-analyze.ts:4003-4043`; `bench/analyze-phase-breakdown.md:77`, `:99-119` |
| 25 | Communities/Processes/MRO/DI/AOP/Destinations always re-run | `pipeline.ts:355-365`; `run-analyze.ts:4072-4119` |
| 26 | Group bridge DB rebuilt from scratch | `group/bridge-db.ts:265`, `:1126-1140`; `group/bridge-schema.ts:10` |
| 27 | Watch = chokidar `add|change|unlink`, 300 ms debounce, `*` on overflow | `analyze-watch.ts:327-349`, `:36`, `watch-queue.ts:4`, `:122` |
| 28 | Watch refresh never overlaps; retries with backoff | `watch-queue.ts:41`, `:119-120`, `:159-161` |
| 29 | Watch rejects `--force`, `--embeddings`, etc. | `analyze-watch.ts:110-144` |
| 30 | Index lock: socket (Win/Linux) + file (else), 10 min ceiling | `index-lock.ts:905-929`, `:82`, `:890-894` |
| 31 | Lock is fail-closed for writers | `index-lock.ts:190-192`; `run-analyze.ts:1415-1418` |
| 32 | Single-flight coalescing + re-resolve under lock | `run-analyze.ts:1366-1373`, `:1431-1457` |
| 33 | Atomic staging for incremental (POSIX, caller opt-in) | `run-analyze.ts:3151-3197`, `:3952-3959`; `analyze-watch.ts:208` |
| 34 | Cross-netns Linux socket-lock caveat | `index-lock.ts:875-889` |
| 35 | `lbug` is a single FILE; `gitnexus.json` + `meta.json` mirror | observed listing; `storage-constants.ts:2-6`; `repo-manager.ts:224-226` |
| 36 | No persisted graph JSON/CSV; `graph-csv/` is transient | `run-analyze.ts:2987-2989`; `pipeline.ts:392-402` |
| 37 | registry.json schema | `repo-manager.ts:173-199`; `storage-resolver.ts:158` |
| 38 | `status --json` shape | `cli/status.ts:379-405`; flag `cli/index.ts:342` |
| 39 | Staleness payload + fail-open semantics | `staleness-status.ts:104-117`, `:11-51`; `git-staleness.ts:120-179` |
| 40 | IPC drops `incrementalStats` / `rebuildReasons` | `analyze-worker-ipc.ts:53-64` vs `run-analyze.ts:786`, `:828-835` |
| 41 | HTTP analyze route + job polling + SSE | `server/api.ts:1849-1853`, `:2064`, `:2076`, `:2079` |
| 42 | No MCP analyze tool | `mcp/tools.ts:116-1061` |
| 43 | Auto-sync spawns a forked worker and requests staging | `auto-sync/runner.ts:249-265`; `analysis-worker-launch.ts:88-237` |
| 44 | Auto-sync state/config shapes and paths | `auto-sync/state.ts:8-39`; `auto-sync/config.ts:10`, `:100-131` |
| 45 | Measured phase costs (cold + one-file edit) | `bench/analyze-phase-breakdown.md:58-95` |
| 46 | Three "silently full rebuild" benchmark traps | `bench/analyze-phase-breakdown.md:13-44` |

---

## Driver contract

Everything an external process needs, in call order.

### C1. Discover the index

```
read ~/.gitnexus/registry.json          -> RegistryEntry[]    (storage-resolver.ts:158; repo-manager.ts:791)
  pick entry by `path` (canonicalized) or `name`
  slotDir   = entry.storagePath           // <repo>/.gitnexus  OR an external/shared slot
  metaPath  = slotDir/gitnexus.json       (+ meta.json mirror)
  graphPath = meta.graphPath ?? slotDir/lbug
```

### C2. Ask whether an update is needed (cheap, read-only)

```
spawn: gitnexus status --json
  -> { status: 'up-to-date' | 'stale', index.incompleteReasons[], contentDrift, ... }   (cli/status.ts:379-405)
```

or read `gitnexus.json` directly and apply the same tests the code applies:

```
needsUpdate =
     meta.lastCommit !== currentHead                       // run-analyze.ts:2495
  || meta.incrementalInProgress != null                    // repo-meta.ts:437
  || meta.embeddingCheckpoint != null                      // run-analyze.ts:2493
  || meta.graphWriteCollapsed != null                      // run-analyze.ts:2237
  || contentDrift.kind === 'drifted'                        // index-content-drift.ts:82
```

For a *content-level* answer without running anything, call
`detectIndexContentDrift(repoPath, meta.fileHashes, meta.indexCoverage)` →
`{kind:'current', coveredFileCount} | {kind:'drifted', changed, added, deleted} | {kind:'unmeasurable', reason}`
(`core/index-content-drift.ts:82-170`) — this is the same function `status` uses.

### C3. Trigger the update — pick one

**Option A — in-process (recommended: gives you `incrementalStats` and `rebuildReasons`):**

```ts
import { runFullAnalysis } from 'gitnexus/core/run-analyze.js';   // dist path in a published install

const result = await runFullAnalysis(
  repoPath,
  {
    // incremental is the DEFAULT: pass NO `force`
    useParseCache: true,          // run-analyze.ts:465   (--no-parse-cache => false)
    skipFts: false,               // run-analyze.ts:468
    pdg: <meta.pdg !== undefined>,// MUST match the index's stamped mode or you force a rebuild
    branch: <optional pinned branch>,   // run-analyze.ts:568
    skipAgentsMd: true,           // avoid touching the working tree
    skipSkills: true,
    noStats: true,
    atomicIncremental: true,      // POSIX only; failure-preserving staging
    skipNativeCloseOnExit: true,  // only if you process.exit() immediately after
  },
  { onProgress: (phase, pct, msg) => {}, onLog: () => {} },
);

// result.alreadyUpToDate   -> the fast path answered; nothing was written
// result.incrementalStats  -> { changedFiles, reparsedFiles, affectedDependents, deletedFiles, writeMode }
// result.rebuildReasons    -> RebuildReasonKey[]  (informational; nothing internal reads it)
// result.graphWriteCollapsed -> present only on a detected collapse
```

**Option B — fork the analyze worker (isolation, heap cap, cancel support):**

```
fork('<gitnexus>/dist/server/analyze-worker.js', [], {
  execArgv: [`--max-old-space-size=${heapMb}`],
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})
child.send({ type: 'start', repoPath, options })       // analyze-worker-protocol.ts:30-34
child.on('message', m => {                              // :43-78
  m.type === 'progress' -> { phase, percent, message }
  m.type === 'complete' -> { result: AnalyzeResultIpc }
  m.type === 'error'    -> { message, code?: 'index-lock-timeout', retryable? }
})
child.send({ type: 'cancel' })                          // cooperative, at the next JS safe point
```

Reference implementation: `core/auto-sync/analysis-worker-launch.ts:88-237`.

**Option C — CLI (simplest, but stdout is human-oriented):**

```
gitnexus analyze <repoPath>                    # incremental by default
gitnexus analyze <repoPath> --branch <name>    # pinned branch slot
gitnexus analyze <repoPath> --watch --debounce 300   # long-running incremental loop
gitnexus auto-sync start                       # scheduled clone/pull + analyze from ~/.gitnexus/watch_config.yml
```

**Option D — HTTP (`gitnexus serve`):**

```
POST /api/analyze
  { "path": "<absolute local path>", "branch"?: "<name>", "force"?: false }
  -> 202 { jobId, status, tokenIgnored? }
GET  /api/analyze/{jobId}                -> job view (status, result)
GET  /api/analyze/{jobId}/progress       -> SSE progress frames
DELETE /api/analyze/{jobId}              -> cancel
```

Route: `server/api.ts:1849-1853`; rate limit `createRouteLimiter({limit: 10})`; `requireTrustedOrigin` (loopback / bound host / `GITNEXUS_PUBLIC_ORIGIN`).

### C4. What to pass (and what never to pass casually)

| Option key | Type | Effect on incrementality |
|---|---|---|
| `force` | `boolean` | **kills incremental** (`user-force`) |
| `useParseCache` | `boolean` | `false` ⇒ re-parse everything (`parse-cache-bypass`) |
| `skills` | `boolean` | forces a rebuild (`skills`) |
| `branch` | `string` | routes to `branches/<slug>/`; must equal the checked-out branch (`run-analyze.ts:1322-1327`) |
| `pdg` | `boolean` | any change from the stamp ⇒ rebuild (`pdg-mode`) |
| `pdgMax*` | `number` | recorded resolved; a change ⇒ rebuild |
| `embeddings` / `embeddingsNodeLimit` / `dropEmbeddings` | | `dropEmbeddings` + an `embeddingCheckpoint` ⇒ rebuild |
| `springActuatorPath` / `asyncApiSpecPath` | `string` | requesting **or** dropping either ⇒ rebuild |
| `maxProcesses` / `maxProcessBranching` / `maxProcessTraceDepth` / `maxEntryPointCandidates` | `number` | a change vs `meta.processDetection` re-derives flows (not a full rebuild) |
| `atomicIncremental` | `boolean` | POSIX-only staging; `GITNEXUS_ATOMIC_INCREMENTAL=0` overrides |
| `shareWith` / `noShare` | `string`/`boolean` | shared-store membership |
| env `GITNEXUS_EMBEDDING_DIMS` | | a change ⇒ rebuild (`embedding-dims`) |
| env `GITNEXUS_FTS_CJK_SEGMENTATION` | | a change ⇒ rebuild (`cjk-segmentation`) |
| env `GITNEXUS_WAL_MANUAL_CHECKPOINT` | | `0/false/off/no` ⇒ **never incremental** |
| env `GITNEXUS_INDEX_LOCK_BACKEND` | | `file` needed across Linux netns |
| env `GITNEXUS_INDEX_LOCK_TIMEOUT_MS` | | wait ceiling; ≤0 = unbounded |

### C5. After the run — verify

```
1. read gitnexus.json
   - incrementalInProgress == null            (else the run crashed mid-write)
   - graphWriteCollapsed == null
   - lastCommit == the commit you just indexed
   - stats.nodes / stats.edges are plausible
2. if meta.incrementalInProgress != null -> the NEXT run is forced to full-rebuild; surface that to the operator
3. if result.graphWriteCollapsed on an in-place write -> the index is stamped INCOMPLETE
   (getIndexIncompleteReasons -> 'graph-write-collapsed', index-freshness.ts:5-12); repair with --force
```

### C6. Hard rules

1. **Never edit `gitnexus.json` / `meta.json` / `lbug` yourself.** The dirty flag + `fileHashes` are a two-phase-commit protocol; a hand-written meta is the documented route to "incremental is misbehaving" (`GUARDRAILS.md:37-41`).
2. **Always let `runFullAnalysis` (or the worker/CLI) take the index lock.** It is the only thing serializing writers (`index-lock.ts:1-48`).
3. **Expect the run to be slow anyway.** On a 2 200-file repo a *one-file* incremental edit measured 31.7 s, of which 44 % was scope-resolution and 24 % was FTS — both non-incremental (`bench/analyze-phase-breakdown.md:69-81`).
4. **Do not treat `writeMode: 'full'` as a pipeline rebuild.** It is the DB write plan escalating (size > 50 % of files with ≥ 50 deletions, or a blocked VECTOR/FTS extension); file-level bookkeeping stayed incremental (`escalation-gate.ts:1-16`; `GUARDRAILS.md:34`).
5. **Do not benchmark against a non-git checkout or a rebuilt `dist`** — both silently produce full rebuilds (`bench/analyze-phase-breakdown.md:13-44`).
6. **Read `staleness.status`, not `isStale`** — the latter is intentionally fail-open (`staleness-status.ts:44-49`).
