# GitNexus — Visualization Surface & Read/Query API

Engineering report for an external DSH plugin that wants to (a) visualize an indexed project's
knowledge graph + index status and (b) query it, **without reimplementing GitNexus**.

- **Source of truth:** checkout at `D:\Project\GitNexus` (monorepo: `gitnexus/` CLI+MCP+HTTP server,
  `gitnexus-web/` Vite+React client, `gitnexus-shared/` cross-package types & schema constants).
- **Versions observed:** `gitnexus` package `1.6.12` (`gitnexus/package.json:3`); `gitnexus-web`
  `0.0.0` private (`gitnexus-web/package.json:4`); Node engines `^22.18.0 || >=24.11.0`
  (`gitnexus/package.json` engines) and `^22.12.0 || ^24.0.0 || >=26.0.0` (`gitnexus-web/package.json` engines).
- Every claim below carries a `file:line`. Paths are relative to `D:\Project\GitNexus\` unless absolute.

---

## Route table (compact)

All routes live in `gitnexus/src/server/api.ts` inside `createServer()` (starts `api.ts:987`), except
`/api/mcp` which is mounted from `gitnexus/src/server/mcp-http.ts:44`.

Legend — **Auth**: `none` = no request authentication at all; `origin` = write-route same-origin guard
(`requireTrustedOrigin`, `middleware.ts:181-214`, rejects with 403 `{error, code:'origin_not_allowed'}`);
`bearer` = optional MCP bearer token. **RL** = per-IP rate limit (`createRouteLimiter`,
`validation.ts:151-165`; default 60 req/min/IP, `validation.ts:112`).

| # | Method | Path | Auth | RL | Purpose | Response shape | Evidence |
|---|--------|------|------|----|---------|----------------|----------|
| 1 | GET | `/api/health` | none | — | Docker/orchestrator healthcheck | `{status:"ok"}` | `api.ts:1197-1199` |
| 2 | GET | `/api/heartbeat` | none | — | SSE liveness; `:ok` then `:ping` every 15 s | `text/event-stream` | `api.ts:1204-1219` |
| 3 | GET | `/api/info` | none | — | Server version + launch context | `{version, launchContext:"npx"\|"global"\|"local", nodeVersion, latestVersion?, updateAvailable?}` | `api.ts:1222-1224`; `update-controller.ts:75-99` |
| 4 | GET | `/api/repos` | none | 60 | List all indexed repos (staleness + availability per repo) | `Array<{id,name,path,repoPath,storagePath,indexedAt,lastCommit,stats,contentRetention,sourceAvailable,branch,branches,staleness?}>` | `api.ts:1231-1256`; `repo-projection.ts:53-76` |
| 5 | GET | `/api/repo?repo=` | none | 60 | One repo's detail | `{name,repoPath,storagePath,indexedAt,stats,lastCommit,branch,contentRetention,sourceAvailable,staleness?}` | `api.ts:1263-1287`; `repo-projection.ts:83-99` |
| 6 | DELETE | `/api/repo?repo=` | origin | 60 | Delete index + clone dir + unregister | `{deleted:<name>}` | `api.ts:1293-1395` |
| 7 | GET | `/api/graph?repo=&includeContent=&stream=` | none | — | **Full graph** — JSON, or NDJSON when `stream=true` | JSON `{nodes:[GraphNode],relationships:[GraphRelationship]}`; NDJSON lines `{type:'node'\|'relationship',data}` / `{type:'error',error}` | `api.ts:1398-1477`, `buildGraph` `416-447`, `streamGraphNdjson` `558-605`, record type `192-195` |
| 8 | POST | `/api/query` | none | — | Raw Cypher (read-only DB handle) | `{result: rows[]}`; 403 on writes | `api.ts:1480-1482`, `handleQueryRequest` `908-949` |
| 9 | POST | `/api/search` | none | — | Hybrid / semantic / BM25 search + enrichment | `{results:[...], warning?}` | `api.ts:1485-1662` |
| 10 | GET | `/api/file?repo=&path=&startLine=&endLine=` | none | 60 | Read a checkout file (traversal-guarded) | `{content, startLine?, endLine?, totalLines}` | `api.ts:1666-1679`; `handleFileRequest` `779-864` |
| 11 | GET | `/api/grep?repo=&pattern=&fileFilter=&limit=&caseSensitive=&literal=` | none | 60 | Regex scan of retained files (worker, 5 s budget) | `{results:[{filePath,line,text}], timedOut?}` | `api.ts:1686-1735`; `grep-params.ts:55-100` |
| 12 | GET | `/api/processes?repo=&awaitAnalysis=` | none | 60 | All execution flows | `{processes:[{id,label,heuristicLabel,processType,stepCount}]}` | `api.ts:1775-1785`; `local-backend.ts:10366-10392` |
| 13 | GET | `/api/process?repo=&name=` | none | 60 | One process's step trace | process detail object (404 `{error}` if unknown) | `api.ts:1788-1808`; `local-backend.ts:10462+` |
| 14 | GET | `/api/clusters?repo=&awaitAnalysis=` | none | 60 | Leiden communities (aggregated by `heuristicLabel`, `<5` symbols filtered) | `{clusters:[{id,label,heuristicLabel,cohesion,symbolCount}]}` | `api.ts:1811-1821`; `local-backend.ts:10334-10360`, `4527+` |
| 15 | GET | `/api/cluster?repo=&name=` | none | 60 | One cluster + up to 30 members | `{cluster:{...}, members:[{name,type,filePath}]}` | `api.ts:1824-1844`; `local-backend.ts:10398-10456` |
| 16 | POST | `/api/analyze` | origin | 10 | Start clone/analyze job (`{url?|path?, force?, embeddings?, dropEmbeddings?, springActuatorPath?, asyncApiSpecPath?, token?, branch?}`) | 202 `{jobId,status, tokenIgnored?}` | `api.ts:1849-2046` (`body` destructure `1855-1865`) |
| 17 | POST | `/api/analyze/upload` | origin | 5 | Analyze a multipart browser folder upload | job envelope | `api.ts:2052-2061`; `analyze-upload.ts` |
| 18 | GET | `/api/analyze/:jobId` | none | — | Poll analyze job | `serializeOpsJob(job,'analyze')` | `api.ts:2064-2073`; `ops-snapshot.ts` |
| 19 | GET | `/api/analyze/:jobId/progress` | none | — | **SSE** analyze progress | `id:` + `data:` frames; terminal `event: complete\|failed` | `api.ts:2076`; `sse-progress.ts:77-157` |
| 20 | DELETE | `/api/analyze/:jobId` | origin | — | Cancel analyze job | job view | `api.ts:2079-2094` |
| 21 | POST | `/api/embed` | origin | 20 | Start server-side embedding job | `{jobId,status}` / 409 | `api.ts:2101-2425` |
| 22 | GET | `/api/embed/:jobId` | none | — | Poll embed job | `serializeOpsJob(job,'embed')` | `api.ts:2428-2435` |
| 23 | GET | `/api/embed/:jobId/progress` | none | — | **SSE** embed progress | same relay as #19 | `api.ts:2438`; `sse-progress.ts` |
| 24 | DELETE | `/api/embed/:jobId` | origin | — | Cancel embed job | job view | `api.ts:2441-2455` |
| 25 | GET | `/api/ops` | none | 60 | Realtime in-memory ops snapshot (analyze + embed lanes) | `OpsSnapshot` (see §Index-status shapes) | `api.ts:2469-2471`; `ops-snapshot.ts:50-75` |
| 26 | GET | `/api/ops/stream` | none | 30 | **SSE** push of the same snapshot every 1 s; max 8 concurrent streams | `data: <OpsSnapshot JSON>` | `api.ts:2479-2506` |
| 27 | ALL | `/api/mcp` | none / bearer | — | MCP over StreamableHTTP (JSON-RPC) | JSON-RPC | `mcp-http.ts:37-57`; bearer enabled only when `GITNEXUS_MCP_AUTH_TOKEN` set (`mcp-http.ts:28-35`) |
| 28 | GET | `/*` (static) | none | — | Web UI assets from `staticDir` | files; `.html` → `Cache-Control: no-cache`, else `public, max-age=31536000, immutable` | `api.ts:292-298`, `284-290` |
| 29 | GET | `SPA_FALLBACK_REGEX` | none | 300 | SPA fallback → `index.html` (excludes `/api/*` and paths with a file extension) | `index.html` | `api.ts:213` (regex), `315-317` |
| 30 | GET | `/` (only when no web dist) | none | — | Static landing page listing endpoints | HTML | `api.ts:319-321`, `landingPageHtml` `234-282` |
| 31 | — | error handler | — | — | 4xx passthrough (body-parser style), else 500 `{error:'Internal server error'}` | — | `api.ts:2524-2534` |

Notes:

- **There is no request authentication on `serve`.** `isServeAuthConfigured()` returns `false`
  unconditionally (`middleware.ts:228-230`) and `assertServeAuthForPublicOrigin()` refuses to start
  when `GITNEXUS_PUBLIC_ORIGIN` is set precisely because the server is unauthenticated
  (`middleware.ts:246-257`, called `api.ts:991`). Requests without an `Origin` header (curl, any
  script) pass every guard, including `POST /api/analyze` and `DELETE /api/repo` (`middleware.ts:187-192`).
- **CORS** allowlist: absent origin, `localhost`/`127.0.0.1`/`[::1]` on any port, RFC-1918 hosts on any
  port, `gitnexus.vercel.app` / `gitnexus-web.vercel.app`, and `GITNEXUS_PUBLIC_ORIGIN`
  (`api.ts:154-190`). Chromium Private Network Access header is set pre-CORS (`api.ts:1012-1015`).
- **Repo selection** for every `?repo=` route: query-string `repo` first, else body `repo`
  (`api.ts:623-632`). Path-looking claims resolve by canonical registry path only and fail closed
  (`api.ts:665-693`). Omitting `repo` with >1 indexed repo is a 400 listing the available names
  (`api.ts:696-706`).
- **Hold queue:** if the repo is not yet registered but a `queued|cloning|analyzing` job matches,
  `resolveRepo` parks the connection up to 300 s, then answers **503** with a "taking longer than
  expected" body (`api.ts:1126-1173`, `HOLD_QUEUE_TIMEOUT_SECS` `api.ts:1093`, `respondIfAnalysisPending`
  `896-906`). `?awaitAnalysis=false` opts out on the process/cluster GETs (`api.ts:639-643`).
- **Storage failures** map to a typed envelope: 404 when the slot is missing/empty, 503 otherwise,
  body `{error, code:'index-unavailable', state}` (`api.ts:715-727`).
- `GET /api/graph` never takes a write handle; it opens the DB read-only (`api.ts:1432-1442`), so
  concurrent `analyze` is safe.

---

## Graph schema (compact)

Single DDL source: `gitnexus/src/core/lbug/schema.ts`; the label/type lists are shared with the web
package via `gitnexus-shared/src/lbug/schema-constants.ts`.

### Node labels (36 tables) — `NODE_TABLES`, `schema-constants.ts:11-49`

Every table has `id STRING PRIMARY KEY`. Column sets below are exactly the DDL.

| Label | Columns beyond `id` | Evidence |
|---|---|---|
| `File` | `name, filePath, content` | `schema.ts:27-34` |
| `Folder` | `name, filePath` | `schema.ts:36-42` |
| `Function` | `name, filePath, startLine, endLine, isExported, content, description, convexEndpointFactory` | `schema.ts:44-56` |
| `Class` | `name, filePath, startLine, endLine, isExported, content, description, frameworkAnnotations STRING[]` | `schema.ts:58-70` |
| `Interface` | `name, filePath, startLine, endLine, isExported, content, description` | `schema.ts:96-107` |
| `Method` | `name, filePath, startLine, endLine, isExported, content, description, parameterCount, returnType` | `schema.ts:109-122` |
| `CodeElement` | `name, filePath, startLine, endLine, isExported, content, description` | `schema.ts:124-135` |
| `Community` | `label, heuristicLabel, keywords STRING[], description, enrichedBy, cohesion DOUBLE, symbolCount` | `schema.ts:141-152` |
| `Process` | `label, heuristicLabel, processType, stepCount, communities STRING[], entryPointId, terminalId` | `schema.ts:158-169` |
| `Protocol`, `Category` | `name, filePath, startLine, endLine, content, description` | `schema.ts:72-94` |
| **Generic code elements** — `Struct, Enum, Macro, Typedef, Union, Namespace, Trait, Impl, TypeAlias, Static, Variable, Record, Delegate, Annotation, Constructor, Template, Module` | `name, filePath, startLine, endLine, content, description` (via `CODE_ELEMENT_BASE`) | `schema.ts:177-197`, `210-211`, `243-248` |
| `Const` | same + `convexEndpointFactory` | `schema.ts:198-209` |
| `Property` | same + `declaredType, isDetail BOOLEAN` | `schema.ts:212-242` |
| `Section` (markdown headings) | `name, filePath, startLine, endLine, level, content, description` | `schema.ts:313-324` |
| `Route` | `name, filePath, responseKeys STRING[], errorKeys STRING[], middleware STRING[], method, handlerSymbolId, runtimeConfirmed, runtimeSource, runtimeStatus` | `schema.ts:250-264` |
| `Tool` | `name, filePath, description` | `schema.ts:267-274` |
| `Destination` | `name, filePath, startLine, endLine, address, broker, resolution, configKey, configDefault, description` | `schema.ts:296-310` |
| `BasicBlock` (PDG substrate, inert without `--pdg`) | `filePath, startLine, endLine, text, callees, calleeIds, ownerId` — **no `name`** | `schema.ts:333-344` |
| `CodeEmbedding` (separate vector table, not part of `NODE_TABLES`) | `nodeId, chunkIndex, startLine, endLine, embedding FLOAT[384], contentHash` | `schema.ts:718-728` |

Five `NodeLabel` values have **no node table** — `Project`, `Package`, `Decorator`, `Import`, `Type`
(`gitnexus-shared/src/graph/types.ts:10-67` vs `schema-constants.ts:11-49`); a Cypher query naming one
will fail.

### Relationship table — one table, `CodeRelation`

```
CREATE REL TABLE CodeRelation (
  <461 declared source→target pairs>,
  type STRING, confidence DOUBLE, reason STRING, step INT32, staticGated BOOLEAN
)
```
`schema.ts:684-693`. Direction: the DDL pair `FROM a TO b` means the stored edge is `(a)-[:CodeRelation]->(b)`,
i.e. **source = `a`, target = `b`**, matching `GET /api/graph`'s `sourceId`/`targetId`
(`api.ts:449-451`, `548-556`).

Endpoint pairs are `STRUCTURAL_PAIR_DDL` (hand-listed, `schema.ts:573-634`) plus a generated cross
product (`schema.ts:665-682`) of `SCOPE_BRIDGE_SOURCE_LABELS × SCOPE_BRIDGE_TARGET_LABELS`
(`schema.ts:369`, `385-388`) and `DEFINITION_ANCHOR_LABELS × ATTACHMENT_TARGET_LABELS`
(`schema.ts:410-427`, `510`). Emitting an undeclared pair aborts `analyze` (`schema.ts:647-655`).

### Relation types — `REL_TYPES`, `schema-constants.ts:55-96` (33 values)

| Group | Types | Default traversal (`VALID_RELATION_TYPES`, `local-backend.ts:513-563`) |
|---|---|---|
| Structural containment | `CONTAINS`, `DEFINES` | **excluded** (`security.test.ts:63` asserts `CONTAINS` ∉) |
| Symbols | `CALLS`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `HAS_METHOD`, `HAS_PROPERTY`, `ACCESSES`, `METHOD_OVERRIDES`, `METHOD_IMPLEMENTS`, `USES`, `OVERRIDES` (legacy alias) | included |
| Framework / API | `HANDLES_ROUTE`, `FETCHES`, `HANDLES_TOOL`, `ENTRY_POINT_OF`, `WRAPS`, `INJECTS`, `CONDITIONAL_ON`, `DECLARES`, `ADVISED_BY`, `PUBLISHES_TO`, `CONSUMES_FROM` | valid for explicit `relationTypes` filters; **not** in the default impact relTypes (`local-backend.ts:536-562`) |
| Cluster/flow overlay | `MEMBER_OF`, `STEP_IN_PROCESS` | **excluded** from `VALID_RELATION_TYPES` |
| Vue events | `BINDS_EVENT_HANDLER`, `EMITS_EVENT` | not listed in `VALID_RELATION_TYPES` |
| Alias / legacy | `OVERRIDES` (rows are written as `METHOD_OVERRIDES`) | valid |
| **PDG / taint (opt-in, zero rows on a default index)** | `CFG`, `REACHING_DEF`, `TAINTED`, `SANITIZES`, `TAINT_PATH`, `CDG`, `POST_DOMINATE`, `CALL_SUMMARY` | **excluded**; emitted only by `gitnexus analyze --pdg` (`tools.ts:251`, `ARCHITECTURE.md:536`) |

(The relation-table DDL currently declares **461 source→target pairs** — `schema.ts:560-565` — of
which ~182 are the generated attachment family, `schema.ts:453-459`.)

Concrete exclusions worth flagging to a visualizer:

- `ACCESSES` is **excluded from the default impact traversal** but present in the graph and in
  `context()` results with `reason: 'read'|'write'` (`tools.ts:632`, `tools.ts:328`).
- `CFG` / `REACHING_DEF` / `CDG` / `TAINTED` / `SANITIZES` / `TAINT_PATH` / `POST_DOMINATE` /
  `CALL_SUMMARY` are deliberately kept out of `VALID_RELATION_TYPES` and the web schema
  (`ARCHITECTURE.md:323`, `ARCHITECTURE.md:536`, `test/unit/call-summary-schema-version.test.ts:54-64`).
- `POST_DOMINATE` is debug-only behind `GITNEXUS_PDG_EMIT_POST_DOMINATE`
  (`gitnexus-shared/src/graph/types.ts:259-266`).

### `GET /api/graph` projections per label

`getNodeQuery()` (`api.ts:455-492`) narrows each label to a handful of columns; the generic path is
`id, name, filePath, startLine, endLine` (+ `content` when `includeContent=true`). Special cases:
`BasicBlock` → `id, filePath, startLine, endLine, text` (`api.ts:458-465`); `File` → `id, name, filePath`
(+`content`) (`466-470`); `Community` → `id, label, heuristicLabel, cohesion, symbolCount` (`474-476`);
`Process` → `id, label, heuristicLabel, processType, stepCount, communities, entryPointId, terminalId`
(`477-479`); `Route` → core projection + `runtimeConfirmed/runtimeSource/runtimeStatus` (`480-482`,
`396-398`); `Tool` → `id, name, filePath, description` (`483-485`); `Destination` → `id, name, filePath,
startLine, endLine, address, broker, resolution, configKey, configDefault` (`486-488`). `null`
destination keys are normalized back to absent (`api.ts:531-535`).

Line-number caveat for a visualizer: `startLine`/`endLine` in storage **and** in raw Cypher/HTTP
results are **0-based** tree-sitter rows; the `context`, `query`, `impact`, `group trace`, `explain`
and `pdg_query` MCP tools present them 1-based (`resources.ts:539`).

---

## 1. Full HTTP route table of `gitnexus serve`

See the **Route table** section above — it is the complete list of registrations in
`gitnexus/src/server/api.ts` (grep of `app.(get|post|delete|all|use)(` yields exactly those, plus the
static/SPA mounts). Grouped by area:

- **Health / meta:** `/api/health`, `/api/heartbeat` (SSE), `/api/info`.
- **Repo catalog:** `GET /api/repos`, `GET /api/repo`, `DELETE /api/repo`.
- **Graph read:** `GET /api/graph` (JSON **or** NDJSON stream), `POST /api/query`, `POST /api/search`.
- **Source read:** `GET /api/file`, `GET /api/grep`.
- **Structure overlays:** `GET /api/processes`, `/api/process`, `/api/clusters`, `/api/cluster`.
- **Analyze jobs:** `POST /api/analyze`, `POST /api/analyze/upload`, `GET /api/analyze/:jobId`,
  `GET /api/analyze/:jobId/progress` (SSE), `DELETE /api/analyze/:jobId`.
- **Embed jobs:** `POST /api/embed`, `GET /api/embed/:jobId`, `GET /api/embed/:jobId/progress` (SSE),
  `DELETE /api/embed/:jobId`.
- **Ops/status:** `GET /api/ops`, `GET /api/ops/stream` (SSE, 1 Hz, ≤8 connections).
- **MCP:** `ALL /api/mcp`.
- **Static/assets:** `express.static(staticDir)` for everything under the web-dist root (i.e. `/`,
  `/index.html`, `/assets/*`), the rate-limited SPA fallback, and the built-in landing page when no
  web dist is present.

**Auth summary:** only 8 routes have any guard — the six write routes carry `requireTrustedOrigin`
(`DELETE /api/repo`, `POST /api/analyze`, `POST /api/analyze/upload`, `DELETE /api/analyze/:jobId`,
`POST /api/embed`, `DELETE /api/embed/:jobId`), and `/api/mcp` carries the optional bearer gate.
Everything else is fully open on whatever interface the server is bound to.

**SSE endpoints, exactly:** `/api/heartbeat` (`api.ts:1204`), `/api/analyze/:jobId/progress`
(`api.ts:2076`), `/api/embed/:jobId/progress` (`api.ts:2438`), `/api/ops/stream` (`api.ts:2479`).
The job-progress relays emit `id:`, a `data:` frame of `publicOpsProgress(...)`, `:heartbeat` every
30 s, and a terminal `event: complete|failed` frame carrying
`{repoName, repoId, error?, partial?}` — never a filesystem path (`sse-progress.ts:40-47`, `94-150`).

### Index-status shapes (for a status widget)

`GET /api/ops` → `OpsSnapshot` (`ops-snapshot.ts:50-75`):

```jsonc
{
  "generatedAt": 0, "uptimeMs": 0, "health": "ok",
  "server": { "version": "", "launchContext": "npx|global|local", "nodeVersion": "",
              "latestVersion": "?", "updateAvailable": true },
  "analyze": { "jobs": [OpsJobView], "metrics": OpsLaneMetrics },
  "embed":   { "jobs": [OpsJobView], "metrics": OpsLaneMetrics },
  "totals":  { "jobs": 0, "active": 0, "failed": 0, "complete": 0 }
}
```

`OpsJobView` = `AnalyzeJob` + `{lane:'analyze'|'embed', branch?, retryCount, durationMs, partial?}`
(`ops-snapshot.ts:20-33`; client mirror `gitnexus-web/src/services/backend-client.ts:128-159`).
Job statuses: `queued | cloning | analyzing | loading | complete | failed` (`analyze-job.ts:22-28`).

`GET /api/repos` entry stats: `stats.files|nodes|edges|communities|processes|embeddings`
(`repo-meta.ts:171-178`). `staleness` is absent when current, else
`{status:'behind'|'diverged'|'unknown', commitsBehind?, hint?}` (`repo-projection.ts:27-50`).

---

## 2. Starting the server

**Command and flags** — registered at `gitnexus/src/cli/index.ts:307-312`:

```
gitnexus serve [-p|--port <port>] [--host <host>]
```

- `--port` default string `'4747'` (`index.ts:310`).
- `--host` help text says "default: 127.0.0.1" (`index.ts:311`), but the **actual code default is
  `'localhost'`**: `const host = options?.host ?? 'localhost'` (`cli/serve.ts:33`, with the rationale
  that the OS then picks `127.0.0.1` or `::1`, `serve.ts:30-32`). `createServer`'s own parameter
  default is `'127.0.0.1'` (`api.ts:987`), which only applies when `serve.ts` passes nothing — it never does.
- Effective port parse: `Number(options?.port ?? 4747)` (`serve.ts:29`).
- Bind + banner: `app.listen(port, host, …)` then `GitNexus server running on http://<host>:<port>`
  (`api.ts:2539-2543`).
- Failure modes: WAL corruption, `EADDRINUSE`, generic start failure all log and `process.exit(1)`
  (`serve.ts:37-62`).
- Shutdown on `SIGINT`/`SIGTERM`, closing Express, both job managers, MCP cleanup, LadybugDB and the
  backend (`api.ts:2551-2565`).
- Dev invocation inside the repo: `npm run serve` = `tsx src/cli/index.ts serve` (`gitnexus/package.json`
  scripts).

**What must exist on disk first**

1. At least one **indexed repository** registered in the global registry
   (`~/.gitnexus/registry.json`, relocateable with `GITNEXUS_HOME`). Routes resolve through
   `listRegisteredRepos(...)` (`api.ts:1113`) and return 404 `{error:'Repository not found. Run:
   gitnexus analyze'}` (`api.ts:1267`) when nothing matches.
2. The per-repo index slot must be readable; `STATUS_STORAGE_REQUIREMENTS` gates every resolve
   (`api.ts:1099`, `storage-resolver.ts`) and missing/empty slots map to 404 with
   `code:'index-unavailable'` (`api.ts:715-727`).
3. The web UI is **optional** — `resolveWebDistDir` probes `<pkg>/web` then `gitnexus-web/dist`
   (`api.ts:2514-2516`); with neither present, `/` serves the built-in landing page
   (`api.ts:319-321`) and every `/api/*` route still works.
4. `LocalBackend` is constructed and `init()`ed before listen (`api.ts:1054-1055`); MCP endpoints are
   mounted at the same time (`api.ts:1056`).

**Environment variables that affect the server**

| Var | Effect | Evidence |
|---|---|---|
| `GITNEXUS_PUBLIC_ORIGIN` | Admitted to CORS + write-origin guard. **Setting it refuses startup** while `serve` has no auth | `middleware.ts:69`, `89-135`, `246-257`; `api.ts:991` |
| `GITNEXUS_TRUST_PROXY` | Express `trust proxy`; default `loopback, linklocal, uniquelocal`; `true` rejected | `middleware.ts:295-298`, `324-359` |
| `GITNEXUS_MCP_AUTH_TOKEN` | Enables bearer auth on `/api/mcp` only (installed before the JSON body parser) | `http-transport.ts:174-179`; `mcp-http.ts:28-35` |
| `GITNEXUS_WEB_DIST` | Overrides the web-dist directory (tried first) | `api.ts:219-220` |
| `GITNEXUS_HOME` | Relocates the global registry/index home (used by the e2e harness) | `gitnexus-web/e2e/helpers/public-contract.ts:74` |
| `GITNEXUS_STORAGE_PATH` / `GITNEXUS_STORAGE_ROOT` | Index location | `README.md:636-637` |
| `GITNEXUS_LBUG_BUFFER_POOL_SIZE` | LadybugDB buffer pool per process | `README.md:642` |
| `GITNEXUS_VECTOR_MAX_DISTANCE` | Semantic-search cosine cutoff for `serve`/MCP search | `README.md:620`, `663-673` |
| `GITNEXUS_SKIP_FTS` / `--repair-fts` | Keyword (FTS) index availability | `e2e/helpers/public-contract.ts:88`; `README.md:84` |
| `DEBUG` | Extra debug logging on resolve paths | `api.ts:1142`, `1180` |

CLI canonical form used by the e2e harness:
`tsx src/cli/index.ts serve --port <p> --host 127.0.0.1` (`e2e/helpers/public-contract.ts:51-62`).

---

## 3. MCP tool list, schemas, read-only vs mutating

Registration: `GITNEXUS_TOOLS` array (`gitnexus/src/mcp/tools.ts:114-1106`), served by
`createMCPServer` (`mcp/server.ts:132-247` for list, `250+` for call). Transports:
stdio (`startMCPServer`, `mcp/server.ts:411-436`) and HTTP (`POST /mcp` standalone at
`mcp/http-transport.ts:539`; `ALL /api/mcp` under `serve` at `mcp-http.ts:44`).

19 tools = 17 per-repo + 2 group (`README.md:161`). `additionalProperties:false` is forced on every
schema (`tools.ts:1149`), and an optional `branch` property is injected into the 13 repo-scoped tools
that are not checkout readers (`tools.ts:1139-1163`; `REPO_SCOPED_TOOLS` `1120-1137`;
`CHECKOUT_SOURCE_TOOLS` `1118`).

| # | Tool | Read/mutate | `required` | Input properties (name: type (default, bounds)) | Returns | Evidence |
|---|---|---|---|---|---|---|
| 1 | `list_repos` | read | `[]` | `limit:int (50, 1..200)`, `offset:int (0, ≥0)` | page of repos + `pagination{total,limit,offset,returned,hasMore,nextOffset}` | `tools.ts:116-151` |
| 2 | `query` | read (`QUERY_TOOL_ANNOTATIONS`, `openWorldHint:true`, `tools.ts:43-48`) | `['search_query']` | `search_query:str`, `task_context:str`, `goal:str`, `limit:num (10, 1..100)`, `max_symbols:num (25, 1..200)`, `include_content:bool (false)`, `chain_depth:int (0, 0..3)`, `maxTokens:int (≥1)`, `repo:str`, `service:str (minLength 1)`, `branch:str` | `{processes[], process_symbols[], definitions[], staleness?}` | `tools.ts:153-238` |
| 3 | `cypher` | read | `['statement']` | `statement:str`, `params:object`, `repo:str`, `branch:str` | rows as a markdown table `{markdown,row_count}` when tabular, else raw rows | `tools.ts:241-315`; `local-backend.ts:4487-4519` |
| 4 | `context` | read | `[]` | `name`, `uid`, `file_path`, `file` (alias), `kind`, `include_content:bool (false)`, `chain_depth:int (0,0..3)`, `maxTokens:int`, `repo`, `service`, `branch` | `{symbol, incoming, outgoing, processes, epistemic, boundaries, causes, routes?, chain?, staleness?}` | `tools.ts:318-398` |
| 5 | `detect_changes` | read | `[]` | `scope:enum(unstaged\|staged\|all\|compare, default unstaged)`, `base_ref:str`, `worktree:str`, `repo:str`, `branch:str` | `{changed_symbols[], affected_processes[], summary, risk_level, partial?, truncated?, unmapped_files[]}` | `tools.ts:401-438` |
| 6 | `check` | read | `[]` | `cycles:bool (true)`, `repo:str`, `branch:str` | `{status, enumeration, cycles[], cycleCount, componentCount, truncated}` | `tools.ts:441-477` |
| 7 | `rename` | **mutating** (`DESTRUCTIVE_TOOL_ANNOTATIONS`, `tools.ts:50-55`; but `dry_run` defaults `true`) | `['new_name']` | `symbol_name`, `symbol_uid`, `new_name`, `file_path`, `dry_run:bool (true)`, `repo:str` | `result_version:2` + `semantic_edits`, spans, coverage, `changes`/`failed_files`/`unattempted_files` | `tools.ts:480-500`, `107-112` |
| 8 | `impact` | read | `['direction']` | `target`, `name`/`symbol` (aliases), `target_uid`, `direction`, `mode:enum(callgraph\|pdg, default callgraph)`, `line:int (≥0)`, `file_path`, `kind`, `maxDepth:num (3, 1..32)`, `depth:num` (alias), `crossDepth:num (1, 1..32)`, `relationTypes:str[]`, `includeTests:bool (false)`, `minConfidence:num (0, 0..1)`, `repo`, `service`, `subgroup`, `limit:int (100, 1..10000)`, `offset:int (0,≥0)`, `summaryOnly:bool (false)`, `maxTokens:int`, `timeoutMs:num (1..3.6e6)`, `timeout:num` (alias), `branch` | `byDepth`, `byDepthCounts`, `risk`, `summary`, `affected_processes`, `affected_modules`, `staleness?` | `tools.ts:502-701` |
| 9 | `explain` | read (needs `--pdg` index) | `[]` | `target`, `limit:int (50, 1..200)`, `repo`, `branch` | taint findings + `totalFindings`, `truncated` | `tools.ts:703-745` |
| 10 | `pdg_query` | read (needs `--pdg`) | `['mode','target']` | `mode:enum(controls\|flows)`, `target`, `variable`, `limit:int (50, 1..200)`, `repo`, `branch` | CDG or REACHING_DEF edges + `total`, `truncated` | `tools.ts:748-797` |
| 11 | `route_map` | read | `[]` | `route:str`, `repo`, `branch` | routes with handlers, middleware chains, consumers, `runtimeEvidence` | `tools.ts:800-821` |
| 12 | `tool_map` | read | `[]` | `tool:str`, `repo`, `branch` | tool nodes + handler files | `tools.ts:824-841` |
| 13 | `shape_check` | read | `[]` | `route:str`, `repo`, `branch` | routes with `responseKeys` vs consumer accesses, MISMATCH status | `tools.ts:844-865` |
| 14 | `api_impact` | read | `[]` | `route`, `file`, `method`, `repo`, `branch` | single route object, or `{routes[], total}` | `tools.ts:868-893` |
| 15 | `group_list` | read | `[]` | `name:str` | group list / one group config | `tools.ts:896-907` |
| 16 | `group_sync` | **mutating** (writes `contracts.json`) | `['name']` | `name:str`, `exactOnly:bool` | `{missingRepos, unreadableRepos, degradedLinks, failedRepos, warnings, registryOutcome}` | `tools.ts:910-934` |
| 17 | `trace` | read | `[]` | `from`, `from_uid`, `file`/`from_file`, `to`, `to_uid`, `to_file`, `maxDepth:num (10, 1..30)`, `depth` (alias), `includeTests:bool (false)`, `pdg:bool (false)`, `crossDepth:num (1, 1..1)`, `limit:num (50, 1..200)`, `repo`, `branch` | ordered hops + aligned `edges[]` (`type`,`confidence`); cross-repo adds `crossings[]`, `notes[]` | `tools.ts:937-1016` |
| 18 | `read_file` | read | `['path']` | `path:str`, `startLine:int(≥0)`, `endLine:int(≥0)`, `maxLines:int (2000, ≥0)`, `repo` | `{content, totalLines, slice bounds}`; `code:'source-unavailable'` when retention ≠ full | `tools.ts:1019-1058` |
| 19 | `grep` | read | `['pattern']` | `pattern:str (≤200 chars)`, `fileFilter:str`, `limit:num (50, 1..200)`, `caseSensitive:bool`, `literal:bool`, `repo` | hits (1-based lines) + `timedOut` | `tools.ts:1061-1104` |

**Read-only mode** — `GITNEXUS_MCP_READ_ONLY=1` (`read-only-policy.ts:36-41`) exposes only
`MCP_READ_ONLY_TOOLS` (16 names, `read-only-policy.ts:5-24`): `cypher`, `group_list`, `group_sync` are
removed from discovery **and** rejected before dispatch; `rename` is rewritten to a preview-only
schema with `dry_run` pinned `const:true` (`read-only-policy.ts:130-161`); `@group` routing and the
`subgroup`/`crossDepth` args are rejected (`read-only-policy.ts:61-73`).

**Repository policy** — `GITNEXUS_MCP_ALLOWED_REPOS` / `GITNEXUS_MCP_DEFAULT_REPO`
(`README.md:384-386`), enforced in `mcp/repository-policy.ts`; when `mutatingRequiresRepo` /
`readOnlyRequiresRepo` is true the server appends `'repo'` to `required` for every `REPO_SCOPED_TOOLS`
entry (`mcp/server.ts:222-247`).

**Response budgets** — `query`, `context`, `impact` accept `maxTokens`; `GITNEXUS_MCP_DEFAULT_MAX_TOKENS`
supplies the default (`README.md:391-395`; `mcp/output-budget.ts`).

**Query methods behind the tools** (`gitnexus/src/mcp/local/local-backend.ts`, 457 KB):
`init()` `2026`, cluster/process enumeration `queryClusters` `10334`, `queryProcesses` `10366`,
`queryClusterDetail` `10398`, `queryProcessDetail` `10462`, plus `VALID_RELATION_TYPES` `513-563`
and the cypher→markdown formatter `formatCypherAsMarkdown` `4487-4519`. The same class backs
`serve` (constructed at `api.ts:1054`) and the CLI tool commands (`cli/tool.ts:19,27`).

---

## 4. MCP resources

Static resources — `getResourceDefinitions()`, `mcp/resources.ts:36-52`:

| URI | Name | MIME |
|---|---|---|
| `gitnexus://repos` | All Indexed Repositories | `text/yaml` |
| `gitnexus://setup` | GitNexus Setup Content (AGENTS.md text) | `text/markdown` |

URI templates — `getResourceTemplates()`, `mcp/resources.ts:57-127`:

| Template | Name | MIME | Payload |
|---|---|---|---|
| `gitnexus://repo/{name}/context` | Repo Overview | `text/yaml` | `project`, `staleness`, `index:{commit,indexed_at,storage_path,content_retention,source_available,runner_identity,incomplete_reasons,spring_actuator,asyncapi_spec,runner_identity_schema_status}`, `stats:{files,symbols,processes}`, `tools_available`, `resources_available` (`resources.ts:334-445`) |
| `gitnexus://repo/{name}/clusters` | Repo Modules | `text/yaml` | `modules:[{name,symbols,cohesion%}]`, **top 20** of up to 100 (`resources.ts:451-482`) |
| `gitnexus://repo/{name}/processes` | Repo Processes | `text/yaml` | `processes:[{name,type,steps}]`, **top 20** of up to 50 (`resources.ts:487-516`) |
| `gitnexus://repo/{name}/schema` | Graph Schema | `text/yaml` | Human-readable Cypher schema cheat sheet + example queries (`resources.ts:521-594`) |
| `gitnexus://repo/{name}/cluster/{clusterName}` | Module Detail | `text/yaml` | `{cluster:{id,label,heuristicLabel,cohesion,symbolCount,subCommunities}, members:[{name,type,filePath}]}` (≤30 members) (`resources.ts:596-640`) |
| `gitnexus://repo/{name}/process/{processName}` | Process Trace | `text/yaml` | step-by-step trace (`resources.ts:642-679`) |
| `gitnexus://group/{name}/contracts[?type=&repo=&unmatchedOnly=]` | Group Contract Registry | `text/yaml` | cross-repo contract registry (`resources.ts:96-101`, filter parsing `130-215`) |
| `gitnexus://group/{name}/status` | Group Index Status | `text/yaml` | per-repo `missing`/`unresolvable`/`unresolvableReason`, `unreadableRepos`, `suppressedMatchStages` (`resources.ts:103-126`) |

Each read returns a single `contents[]` entry `{uri, mimeType:'text/yaml', text}`; errors are returned
as `text/plain` content rather than a JSON-RPC error (`mcp/server.ts:187-217`). Read-only mode filters
`gitnexus://group/*` out of the template list and rejects those URIs (`read-only-policy.ts:76-97`,
`mcp/server.ts:170-184`).

Note: `gitnexus://group/...` is the only place a repo-*group* (multi-repo contract) view is exposed.
There is **no MCP resource for the whole graph** — the graph is only reachable via `cypher` or the
HTTP `/api/graph`.

---

## 5. Graph schema

See the **Graph schema (compact)** section above: 36 node labels with their exact columns, one
`CodeRelation` table with `type/confidence/reason/step/staticGated`, 461 declared endpoint pairs, and
33 relation types grouped by whether they participate in default traversal.

Direction convention: `FROM a TO b` in the DDL = `(a)-[r:CodeRelation]->(b)`, surfaced as
`sourceId`→`targetId` (`schema.ts:686-687`, `api.ts:449-451`).

Limits / defaults a consumer must know:

- PDG + taint layers (`CFG`, `REACHING_DEF`, `CDG`, `TAINTED`, `SANITIZES`, `TAINT_PATH`,
  `POST_DOMINATE`, `CALL_SUMMARY`) and the `BasicBlock` table are **empty on a default index**;
  `gitnexus analyze --pdg` populates them (`tools.ts:251`, `schema.ts:326-344`, `ARCHITECTURE.md:536`).
- `CONTAINS`, `DEFINES`, `MEMBER_OF`, `STEP_IN_PROCESS` are real edges but are **not** in
  `VALID_RELATION_TYPES`, so `impact({relationTypes:['CONTAINS']})` cannot traverse them.
- `ACCESSES` is excluded from the **default** impact traversal (`tools.ts:632`).
- Community membership is only emitted for `Function`/`Class`/`Method`/`Interface`
  (`schema.ts:453-459`), so `MEMBER_OF` is sparse for other labels.
- `Destination.address` is nullable **on purpose** — absent means unresolved, and two absent addresses
  must not join (`schema.ts:276-295`, `api.ts:518-535`).
- Line numbers: 0-based in storage and raw Cypher/HTTP; 1-based in the symbol-anchored MCP tools
  (`resources.ts:539`).

---

## 6. Building and serving the web UI

| Concern | Answer | Evidence |
|---|---|---|
| Dev server | `npm run dev` → `vite` (default port **5173**) | `gitnexus-web/package.json` scripts; `gitnexus-web/e2e/helpers/public-contract.ts:9` (`FRONTEND_URL` default `http://localhost:5173`) |
| Prod build | `npm run build` = `tsc -b && vite build` → output dir **`gitnexus-web/dist`** | `gitnexus-web/package.json` scripts; `gitnexus/scripts/build-web.js:63-69` |
| Vite config | React + Tailwind plugins; aliases `@`, `@shared`, `gitnexus-shared` → `../gitnexus-shared/src/index.ts`; injects `__REQUIRED_NODE_VERSION__` from `gitnexus/package.json` engines | `gitnexus-web/vite.config.ts:6-34` |
| Entry | `index.html` → `/src/main.tsx` → `<App/>` | `gitnexus-web/index.html:15-16`; `src/main.tsx:7-11` |
| Served by `serve` | Resolved from `<pkg>/web` (published) or `gitnexus-web/dist` (dev); `GITNEXUS_WEB_DIST` wins | `api.ts:2510-2517`, `215-232` |
| Served standalone | `docker-server.mjs` (port `PORT` or **4173**, root `./dist`), optionally reverse-proxying `/api/*` to `GITNEXUS_UPSTREAM_URL` | `docker-server.mjs:8-10`, `83-106`, `497-515` |
| Packaged into the CLI tarball | `gitnexus/scripts/build-web.js` runs only with `--web` / `GITNEXUS_BUILD_WEB=1`; `npm run build:web`; `prepack` includes `--web` and asserts assets | `build-web.js:5-7`, `17-71`; `gitnexus/package.json` scripts (`build:web`, `prepack`) & `files:["dist","web",…]` |
| Vercel | `vercel.json` rewrites non-`assets/`,`api/` paths to `/index.html` and marks `/assets/*` immutable | `gitnexus-web/vercel.json` |

**Runtime config it reads** — a single injected global plus URL params:

```ts
window.__GITNEXUS_CONFIG__ = {
  backendUrl?,                 // API base URL
  largeGraphNodeThreshold?,    // default 25_000
  largeGraphEdgeThreshold?,    // default 50_000
}
```
Declared `gitnexus-web/src/vite-env.d.ts:3-21`; consumed at `src/config/ui-constants.ts:5-7` and
`56-64`.

**Important gap:** `gitnexus serve` does **not** inject `__GITNEXUS_CONFIG__` — its static handler
serves `index.html` verbatim (`api.ts:292-317`). Only `docker-server.mjs` injects it, and only when
`GITNEXUS_BACKEND_URL`/`RENDER_EXTERNAL_URL` is set (`docker-server.mjs:83-89`, `581-597`). So a
plugin embedding the served UI must pass the backend through the **URL** (or pre-seed `localStorage`).

**API base discovery order** (client side):

1. `localStorage['gitnexus-backend-url']` (`hooks/useBackend.ts:7`, `35-41`)
2. else `window.__GITNEXUS_CONFIG__.backendUrl` (`config/ui-constants.ts:6`)
3. else hard default `http://localhost:4747` (`config/ui-constants.ts:7`)
4. `?server=<url>` in the query string overrides for auto-connect (`App.tsx:200`, `217-218`, `350-351`)

Deploy-access token (public edge only) is read from `sessionStorage['gitnexus-auth-token']` and sent
as `Authorization: Bearer …` (`config/ui-constants.ts:24`; `services/backend-client.ts:489-505`).

Can it be embedded by another host? Yes — the built SPA is a plain static bundle (Vite base is
default `/`), `serve` sets no `X-Frame-Options`, CSP or `frame-ancestors` anywhere (grep across
`gitnexus/src` returns nothing), and the API answers CORS for localhost/LAN/vercel origins
(`api.ts:154-190`). The Docker/static path **does** set `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (`docker-server.mjs:594-595`, `602-603`), which blocks
cross-origin framing — so embed against `gitnexus serve`, not the Docker web image.

---

## 7. Graph rendering stack, data shape, limits

| Item | Value | Evidence |
|---|---|---|
| Renderer | **sigma** `3.0.3` (WebGL) | `gitnexus-web/package.json` deps `sigma ^3.0.3`; lockfile `node_modules/sigma.version = 3.0.3` |
| Graph container | **graphology** `0.26.0` | same two files; `hooks/useSigma.ts:3` |
| Edge renderer | `@sigma/edge-curve` `3.1.0`, registered as the `curved` edge program | lockfile; `useSigma.ts:7`, `413-416` |
| Layout | `graphology-layout-forceatlas2` `0.10.1` (worker) + `graphology-layout-noverlap` `0.4.2` | lockfile; `useSigma.ts:4-6` |
| Also present | `d3` `7.9.0` (mermaid/layout helpers), `lucide-react`, `react` `19.3.0` | lockfile; `gitnexus-web/package.json` |
| Canvas component | `<GraphCanvas/>` → `useSigma()` (62 KB hook) | `src/App.tsx:6`, `413`; `src/components/GraphCanvas.tsx:16`, `156`; `src/hooks/useSigma.ts:400-469` |
| Other views | left `FileTreePanel`, right `RightPanel` (code + AI chat tabs), `Header` (repo selector + search + `RepoAnalyzer`), `StatusBar`, overlays `CodeReferencesPanel`, `SettingsPanel`, `HelpPanel`, `ProcessesPanel`, onboarding `DropZone`, standalone `ExecutionDashboard` | `src/App.tsx:363-469`, `474-476`; `src/components/Header.tsx:28`, `192-280` |

**Data shape fed to the renderer**

The wire format is exactly the shared type pair (`gitnexus-shared/src/graph/types.ts:281-339`):

```jsonc
// GET /api/graph  (or NDJSON with ?stream=true)
{
  "nodes": [ { "id": "Function:src/a.ts:10", "label": "Function",
               "properties": { "name": "…", "filePath": "…", "startLine": 0, "endLine": 0,
                               "content"?: "…" /* only includeContent=true */ } } ],
  "relationships": [ { "id": "<sourceId>_<type>_<targetId>", "type": "CALLS",
                       "sourceId": "…", "targetId": "…", "confidence": 0.9,
                       "reason": "", "step": 3 } ]
}
```
Relationship id synthesis and field mapping: `api.ts:548-556`. `step` is only meaningful on
`STEP_IN_PROCESS` edges.

That pair is converted to a graphology `Graph<SigmaNodeAttributes, SigmaEdgeAttributes>` by
`knowledgeGraphToGraphology` (`lib/graph-adapter.ts:94+`), where

- `SigmaNodeAttributes` = `{x,y,size,color,label,nodeType,filePath,startLine?,endLine?,hidden?,
  zIndex?,highlighted?,mass?,community?,communityColor?}` (`graph-adapter.ts:8-31`);
- `SigmaEdgeAttributes` = `{size,color,relationType,type?,curvature?,zIndex?,isHierarchyEdge?}`
  (`graph-adapter.ts:33-41`).

Two alternative layouts reuse the same data: `knowledgeGraphToTreeGraphology` and
`knowledgeGraphToCirclesGraphology` (`components/GraphCanvas.tsx:206-228`).

**Size limits / sampling / aggregation**

- **No sampling and no aggregation.** The UI downloads the entire graph or nothing. The only
  size-aware behaviour is a **chat-only mode** that skips the download entirely.
- Thresholds: `LARGE_GRAPH_NODE_THRESHOLD = 25_000` and `LARGE_GRAPH_EDGE_THRESHOLD = 50_000`
  (`config/ui-constants.ts:41`, `:50`), justified in-file by the sigma/graphology force-layout cliff.
- Decision: skip when either count is *strictly greater* than its threshold; unknown counts fail open
  to a full download; an explicit `?skipGraph=1|0` overrides both ways
  (`lib/graph-load-decision.ts:45-54`, `78-84`; `lib/apply-connect-result.ts`).
- Circuit breaker: the streaming NDJSON parser aborts mid-download with `GraphTooLargeError` when
  `nodes.length > maxNodes` or `relationships.length > maxEdges`, and the connect flow converts that
  into chat-only mode (`services/backend-client.ts:908-950`, `1323-1357`). The breaker is armed only
  for auto-detect downloads — an explicit "Load graph anyway" (`skipGraph=false`) disables it
  (`backend-client.ts:1338`, `1345-1346`).
- Rendering degradation past thresholds: node size scales down in tiers
  (`graph-adapter.ts:47-55`), ForceAtlas2 gravity/scaling/`barnesHutTheta` change in tiers
  (`useSigma.ts:93-119`), layout budgets run 20 s → 45 s (`useSigma.ts:121-130`), and circles-layout
  repulsion is skipped entirely above 5 000 nodes (`useSigma.ts:1109-1138`).
- Sigma settings that matter for cost: `renderLabels: true`, `labelRenderedSizeThreshold: 8`,
  `labelDensity: 0.1`, `labelGridCellSize: 70`, `hideEdgesOnMove: true`, `zIndex: true`
  (`useSigma.ts:400-469`).
- The 120 s client fetch timeout for `/api/graph` (`backend-client.ts:853`) is the practical ceiling.

**Documented max node count?** Yes, effectively: **25 000 nodes / 50 000 edges** is the documented
auto-skip boundary, derived from the ~10 K smooth / ~50 K edge force-layout cliff
(`config/ui-constants.ts:32-50`). There is **no hard server-side cap** — `/api/graph` will happily
serialize a 200 K-node graph; the limit is a client-side policy a custom visualizer may override
via `window.__GITNEXUS_CONFIG__`.

---

## 8. Getting graph data as JSON for a custom visualizer

Yes. Two endpoints matter, both fully open:

**(a) `GET /api/graph?repo=<name>&stream=true`** — `api.ts:1398-1477`.

- NDJSON: one JSON object per line, `{type:'node',data:GraphNode}` /
  `{type:'relationship',data:GraphRelationship}` / `{type:'error',error}` (`api.ts:192-195`,
  `376-394`, `558-605`). `Content-Type: application/x-ndjson` (`api.ts:1423`).
- Add `includeContent=true` only if you need symbol bodies — it inflates payloads enormously
  (`api.ts:1407`, `466-470`).
- No `limit`/`offset`/`since` parameter exists. This is a full-graph dump; the only bound is the
  client's own socket handling.
- Cheapest for **10 K–200 K nodes** because it is one HTTP round trip, streamed, and read-only
  (no write handle — `api.ts:1432-1442`), so it does not contend with an in-flight `analyze`.
  Expect ~1.7 edges per node (`config/ui-constants.ts:36-38`), so a 200 K-node repo is on the order of
  340 K relationship lines — size it before you commit to holding it in memory.

**(b) `POST /api/query` with `{cypher, params?, repo?}`** — `api.ts:1480-1482`, `908-949`.

- Returns `{result: rows[]}` with raw column values (0-based line numbers).
- Use it to fetch **aggregates or slices** instead of the whole graph, e.g. top-N by degree, one
  community, or a file subtree. This is the cheapest option when the visualizer only needs a
  projection (community map, folder tree, call graph of one route) — a single Cypher aggregate over a
  200 K-node graph is far smaller than the full dump.
- Writes are refused with 403 `{error:'Write queries are not allowed via the HTTP API'}` (`api.ts:943-946`).
- Params must be scalar-only (`api.ts:919-925`, `core/lbug/query-params.ts`).

Other useful, cheap calls for a visualizer's chrome:

| Need | Call | Cost |
|---|---|---|
| Repo list + node/edge counts to size the job | `GET /api/repos` | one `git rev-list` per repo, 60 rpm (`api.ts:1231`) |
| One repo's stats | `GET /api/repo` | `stats.{files,nodes,edges,communities,processes}` |
| Communities for a cluster view | `GET /api/clusters` | one Cypher aggregate, ≤100 rows (`local-backend.ts:10334-10356`) |
| Execution flows | `GET /api/processes` | one Cypher query, default limit 50 (`local-backend.ts:10366-10392`) |
| Live index status | `GET /api/ops` (poll) or `GET /api/ops/stream` (SSE, 1 Hz) | in-memory only, no fs/git (`api.ts:2465-2471`) |
| Job progress | `GET /api/analyze/:jobId/progress` (SSE) | relay only (`sse-progress.ts`) |

Avoid for bulk data: the MCP `cypher` tool (it formats rows into a **markdown table**,
`local-backend.ts:4487-4519`) and `gitnexus cypher` (same formatter, `cli/tool.ts:318-343`). Use the
HTTP JSON route when you need structure.

---

## 9. Embeddable widgets, iframes, standalone pages

There is **no widget bundle, no per-repo route, and no share-link generator**. Concretely:

1. **The whole SPA is the embeddable unit.** It has no client-side router; "views" are selected by
   query params (`App.tsx:46-52`, `197-289`). Deep links that work today:

   | URL | What it shows |
   |---|---|
   | `http://<host>:4747/?server=<apiUrl>` | full explorer, auto-connects and picks the sole/first repo (`App.tsx:200-218`) |
   | `…/?server=<apiUrl>&repo=<registryPath>&project=<name>` | same, pinned to an exact repo (path identity wins over display name, `App.tsx:46-47`, `153-158`) |
   | `…/?server=<apiUrl>&project=<name>&skipGraph=1` | chat-only mode, no graph download (`graph-load-decision.ts:78-84`) |
   | `…/?view=ops&server=<apiUrl>` | **standalone ops dashboard** — renders `<ExecutionDashboard/>` with no app shell (`App.tsx:49-52`, `474-476`; `components/ExecutionDashboard.tsx:198-229`) |

2. **Framing.** `serve` emits no `X-Frame-Options`/CSP/COOP/COEP (verified by grep over
   `gitnexus/src`), so `<iframe src="http://localhost:4747/?server=http://localhost:4747&project=<n>">`
   works. The Docker static server is **not** framable — it sets
   `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
   (`docker-server.mjs:594-595`, `602-603`). The hosted Vercel deployment frames nothing special but
   carries its own bearer-token gate (`gitnexus-web/src/components/AccessTokenPrompt.tsx`;
   `config/ui-constants.ts:24`).

3. **`gitnexus wiki` produces a genuinely standalone HTML page.** `generateHTMLViewer` writes a
   self-contained `index.html` (all markdown pages + module tree + mermaid, inlined) to
   `<storagePath>/wiki/index.html` (`core/wiki/html-viewer.ts:22-53`; path built in `cli/wiki.ts:598-599`).
   It has no API dependency and is trivially iframe-able. It is a *documentation* view, not a graph
   view.

4. **Per-repo graph view URLs / share links do not exist.** The nearest thing is the `?repo=` +
   `?project=` bookmark described in `App.tsx:149-158` and exercised by
   `gitnexus-web/e2e/repo-path-identity.spec.ts:230` — but it is a *UI state* restore, not a
   server-rendered page: it still downloads the whole graph client-side and still hits the 25 K/50 K
   chat-only cliff.

**Bottom line for a DSH client panel:** either (i) iframe `http://<host>:4747/?server=<api>&repo=<path>`
and accept the full client download, or (ii) iframe `…?view=ops&server=<api>` for status only, or
(iii) render your own canvas from `GET /api/graph?stream=true` / `POST /api/query` — option (iii) is
the only one that scales past the 25 K-node browser policy and the only one that lets you sample or
aggregate. If you need the built-in chat/agent as well, `POST /api/mcp` gives you the same 19 tools
over JSON-RPC.

---

## Appendix — extracted shapes & secondary evidence

### CLI query surface (`gitnexus/src/cli/`)

| Command | Flags | Output | Evidence |
|---|---|---|---|
| `gitnexus serve` | `-p/--port` (4747), `--host` | server | `cli/index.ts:307-312` |
| `gitnexus mcp` | `--http`, `-p/--port` (3000), `--host`, `--auth-token` | stdio or HTTP MCP | `cli/index.ts:314-331` |
| `gitnexus list` | none | **human text only, no `--json`** | `cli/list.ts:10-64` |
| `gitnexus status` | `-r/--repo`, `--json` | versioned JSON, `schemaVersion: 1` | `cli/index.ts:338-344`; `cli/status.ts:379-405` |
| `gitnexus query [q]` | `-q/--query`, `-r/--repo`, `--branch`, `-c/--context`, `-g/--goal`, `-l/--limit` (5), `--content` | pretty JSON via `output()` | `cli/index.ts:463-476`; `cli/tool.ts:51-97` |
| `gitnexus context [name]` | `-r`, `--branch`, `-u/--uid`, `-f/--file`, `-l/--limit`, `--content` | JSON | `cli/index.ts:478-490` |
| `gitnexus impact [target]` | `-d/--direction` (upstream), `--mode`, `--depth`, `--include-tests`, `--min-confidence`, `--limit`, `--offset`, `--summary-only`, `-r`, `--branch`, `-u`, `-f` | JSON | `cli/index.ts:492-521` |
| `gitnexus trace <from> <to>` | `--from-uid`, `-f/--file`, `--from-file`, `--to-uid`, `--to-file`, `--depth`, `--include-tests`, `-r`, `--branch` | JSON | `cli/index.ts:523-535` |
| `gitnexus cypher <query>` | `-r`, `--branch`, `-l/--limit` | `{markdown,row_count}` (tabular) or raw rows; `--limit` slices markdown rows and clamps `row_count` | `cli/index.ts:537-543`; `cli/tool.ts:303-344` |
| `gitnexus detect-changes` | `-s/--scope`, `-b/--base-ref`, `-r`, `--branch`, `-l` | formatted prose over the structured result | `cli/index.ts:545-554`; `cli/tool.ts:346-369` |
| `gitnexus check` | `--cycles`, `--json`, `-r`, `--branch` | JSON with `--json` | `cli/index.ts:556-563` |
| `gitnexus wiki` | many LLM flags; writes `<storagePath>/wiki/index.html` | standalone HTML | `cli/index.ts:407-441`; `cli/wiki.ts:598-600` |

`gitnexus status --json` shapes (all `schemaVersion: 1`) — `cli/status.ts:379-405` (healthy), `:274-281`
(not indexed / `stale-kuzu-index`), `:210-228` (`--repo` form with `{repository, storagePath,
sourceAvailable, index:{indexedAt,commit,runnerIdentity,runnerIdentityStatus,incompleteReasons,
contentRetention}, current, status:'registered'|'source-unavailable'}`), `:143-165` (errors:
`not-indexed`, `not-git-repository`). The healthy payload adds `branch`, `workspaceIndexBranch`,
`current.runnerIdentity`, `contentDrift`, `sharedStore.{key,commit,graph,privateClone}`,
`legacyLocalIndex`, and `status: 'up-to-date' | 'stale'`.

Every CLI tool command routes through one `output()` that writes to **fd 1** with `writeSync`
(bypassing LadybugDB's stdout capture) and sets `process.exitCode = 1` when the payload carries an
`error` string or `partial: true` (`cli/tool.ts:51-97`).

### Web file/URL surface (for a client panel)

| Concern | Evidence |
|---|---|
| Views | `onboarding` (DropZone), `loading`, `exploring` (Header + FileTree + GraphCanvas + RightPanel + StatusBar), `?view=ops` → ExecutionDashboard — `App.tsx:335-470`, `474-476` |
| Repo selector | `Header` dropdown fed by `GET /api/repos`, switching by registry identity — `components/Header.tsx:48-59`, `232-280`; `App.tsx:368` |
| Analyze from UI | `RepoAnalyzer` posts `POST /api/analyze`; `POST /api/analyze/upload` for folder drops — `components/RepoAnalyzer.tsx`, `components/DropZone.tsx`; `services/backend-client.ts:1116-1165` |
| Status/heartbeat | `connectHeartbeat` → `GET /api/heartbeat` EventSource; reconnect banner — `App.tsx:314-332`; `services/backend-client.ts:731-760` |
| Embedding status chip | `components/EmbeddingStatus.tsx`; `POST /api/embed` + SSE |
| AI chat | `core/llm/agent.ts` + `core/llm/tools.ts` (its own tool set mirroring the backend); calls the backend HTTP API |
| Query FAB / search | `components/QueryFAB.tsx` → `POST /api/search` |
| Backend client methods | `fetchRepos` `:806`, `fetchRepoInfo` `:822`, `fetchGraph` `:838`, `runQuery` `:976`, `search` `:991`, `grep` `:1020`, `readFile` `:1053`, `fetchProcesses` `:1071`, `fetchClusters` `:1089`, `fetchOpsSnapshot` `:1175`, `streamOpsSnapshot` `:1185`, `connectToServer` `:1304` |

### Error envelope conventions

- Generic: `{error: string}`; storage failures add `{code:'index-unavailable', state}` (`api.ts:715-727`).
- Write-origin rejection: 403 `{error:'This endpoint is restricted to trusted browser origins',
  code:'origin_not_allowed'}` (`middleware.ts:209-212`).
- Analysis-pending hold timeout: 503 (`api.ts:902-905`).
- Rate limit: 429 `{error:'Too many requests, please try again later.'}` with draft-7
  `RateLimit-*` headers (`validation.ts:151-165`).
- Client mirror of these codes: `BackendError.code` union in
  `gitnexus-web/src/services/backend-client.ts:161-190` (`network|server|client|not_found|
  source_unavailable|timeout|rate_limited|origin_blocked|unauthorized`).
