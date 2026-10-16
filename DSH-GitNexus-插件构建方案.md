# 基于 GitNexus 的 DSH 插件构建方案

> 目标：一个 DSH 插件，能 **可视化查看项目的 GitNexus 索引**，并能 **增量更新索引而不每次全量重建**。
>
> **取证来源（四份，冲突时以靠后者为准）**
> 1. 本地 GitNexus 源码 `D:\Project\GitNexus`（v1.6.12）
> 2. 官方文档站 <https://deepseek-harness.github.io/deepseek-harness/>（最新 master）
> 3. 本地 DSH 快照 `D:\Project\deepseek-harness`（master @ 2026-09-08，**比文档站旧**，仅作离线索引）
> 4. **本机已安装的 DSH 运行时 `0.2.0-rc.2`** 与其随包发布的 README、以及已装第三方插件的真实代码
>
> 所有关键结论都带证据出处。凡"实测"字样均为本机跑出的结果，命令与读数一并给出。
>
> **修订记录**
> - **v4** —— 新增 §3.8 回答两个边界问题：① 超大文件/超长行（GitNexus 已有跳过硬上限与 minified 处理 ⇒ 面板应显示未索引归因与单行巨文件告警）；② **LSP 诊断监听经 DSH 的 LSP seam 不可行且官方有意推迟**，替代方案为 `gitnexus check --json`（但仅为循环依赖巡检，非编译级诊断）。面板新增 **Problems** 区块与 **coverage** 路由。受影响章节：§3.4、§3.6、§3.8、阶段 1、附录 A。
> - **v3** —— 面板新增**语言分布（Languages）**区块。查证前提：GitNexus 图里**没有**语言信息（无 `language` 列），其官方 UI 的"主语言"显示是读不存在列的死代码 ⇒ 必须自算。数据源定为 `fileHashes`（索引内，零额外 I/O）+ `git ls-tree -r -l HEAD`（仓库全部，带字节数），语言判定复用 `getLanguageFromFilename()`。受影响章节：§3.4、§3.6、阶段 1、§6、附录 A。
> - **v2** —— 补读官方文档站后修正两处实质错误：① 安装路径（Desktop profile 归 Electron 独占，公开 CLI 不可管理）；② Desktop 提供 `ctx.webServer` 并附加浏览器访问门（初版据 0.1.3 快照的桌面 README 误判为"Desktop 不提供 webServer"）。受影响章节：§0.1、§2.3、§2.5、§2.8、§5、§6、附录 A。

---

## 0. 结论摘要（先看这一节）

### 0.1 八个必须知道的事实

| # | 事实 | 影响 |
|---|---|---|
| 1 | **GitNexus 的"增量"已经是默认行为，不是需要开启的开关**。`gitnexus analyze` 默认复用解析缓存；`--force` 才是退出增量的开关 | 插件不该"发明"增量，而该做**差量检测 + 分层升级 + 可视化** |
| 2 | **但 GitNexus 没有真正的增量图更新**。流水线每次都重建整张内存图，`scopeResolution` 占增量耗时 ~44%、FTS 重建占 ~24%，二者都是全局的 | 不能承诺"不重建"；实测无变更重跑 8.4s vs 冷启动 29.6s（**3.5×**），小改动增量仅 **0.79×** |
| 3 | **索引产物只有元数据是可直接读的**。`gitnexus.json` / `registry.json` 是 JSON；图数据在一个单文件 LadybugDB（`lbug`，本机实际 463MB）里，**没有任何持久化的 graph JSON/CSV** | 可视化必须走 HTTP API（`gitnexus serve`）或 LadybugDB，读文件是死路 |
| 4 | **`gitnexus serve` 完全无鉴权**（`isServeAuthConfigured()` 恒返回 false），31 条路由全开放，含 `DELETE /api/repo`；只有 6 条写路由有同源守卫 | 插件必须只绑 `127.0.0.1`，并在自己的路由上补鉴权 |
| 5 | **沙箱下 `gitnexus analyze` 会因管道 stdio 触发 `spawn EPERM`**（自身重启 + FTS 扩展安装），且写 `~/.gitnexus/registry.json` 会越界被拒 | 必须 `GITNEXUS_MEMORY=off` + `--skip-fts` + `GITNEXUS_HOME` 重定向（已实测通过） |
| 6 | **本地 DSH checkout 只是 master 的 2026-09-08 快照**（包版本 0.1.3-alpha.2），比官方文档站旧：缺 `plugin-manager`、桌面 profile 归属、默认端口 `19387`、`capability-seams` 等章节 | 以**官方文档站 + 已安装包**双向取证；冲突时以已安装包为准 |
| 7 | **`$DSH_HOME/profiles/desktop` 归 Electron 独占，公开 CLI 不能启动或修改该 profile** | 安装路径**不是** `dsh plugin --profile desktop add …`，而是 Web 侧边栏「插件」页（或 Creator 模式下由 `plugin_manager` 工具代劳）；该服务**接受绝对本地路径** |
| 8 | **Desktop 确实提供 `ctx.webServer`**（`DesktopWebServer extends WebServer`，强制 127.0.0.1），并在其上加了浏览器访问门：不带 `x-dsh-desktop-renderer` 令牌一律 403 | 本机实测 `/` 与 `/api/health` 均返回 **403**（非 404）⇒ 只有 Electron 渲染进程（也就是你的 client 半）能到达插件路由。方案里的自建守卫降级为**纵深防御**，不再是唯一防线 |

### 0.2 方案一句话

> 做一个双半插件 `dsh-gitnexus-plus`：
> **host 半**负责"驱动"——进程编排、分层增量决策、HTTP 代理、工具暴露；
> **client 半**负责"看"——一个右侧栏 Tab 类型，展示索引仪表盘 + 图可视化 + 差量高亮。
> 核心增量价值不在"重新实现 analyze"，而在 **Tier 0 零成本复验（3.5×）+ 差量可视化 + 守卫式进程编排 + 真正可增量的搜索层（embeddings / FTS）**。

---

## 1. GitNexus 源码分析

### 1.1 架构总览

```
gitnexus/            npm 包：CLI + MCP(stdio) + HTTP API + 摄取流水线 + LadybugDB 图 + embeddings
gitnexus-web/        Vite + React 瘦客户端：图浏览器 + AI 对话，全部查询走 serve HTTP API
gitnexus-shared/     共享类型与常量
.claude-plugin/ 等   Agent 宿主插件元数据（Claude / Cursor / Factory）
```

端到端链路：

1. **摄取** `analyze.ts` → `runFullAnalysis`（`core/run-analyze.ts:1380`）→ `runPipelineFromRepo`，19 个阶段构成 DAG，在内存里构建 `KnowledgeGraph`，随后载入 `.gitnexus/` 下的 LadybugDB。仓库注册到 `~/.gitnexus/registry.json` 供 MCP 发现。
2. **持久化** `storage/repo-manager.ts`（路径 / 注册表 / 清理）、`core/lbug/lbug-adapter.ts`（图装载、查询、embedding 批次）。
3. **查询层**——同一后端三个接口：MCP(stdio)、HTTP(`serve.ts` → `server/api.ts`)、CLI 直连(`cli/tool.ts`)。
4. **新鲜度** `core/git-staleness.ts` 比较索引的 `lastCommit` 与 `HEAD`，分类为 `current` / `behind` / `diverged` / `unknown`。

**流水线阶段 DAG**（19 个默认阶段）：

```
scan → structure → [springConfig, markdown, cobol] → parse → [routes, tools, orm]
  → crossFile → scopeResolution → [springAutoConfiguration, springAop]
  → pruneLocalSymbols → mro → springAopInheritance → di → communities → processes
```

`runner.ts` 用 Kahn 拓扑排序校验，顺序执行；每个阶段只拿到自己声明的依赖（防止隐式耦合）。

### 1.2 索引产物：哪些能直接读

实测 `D:\project\data-screen\.gitnexus\`：

```
.gitnexus/
├── gitnexus.json        9–411 KB   ★ 可读 JSON 元数据清单
├── meta.json            与 gitnexus.json 同步的镜像
├── lbug                 单文件 LadybugDB（本机实测最大 463 MB）
├── run.cjs              辅助脚本
├── parse-cache/         每文件 V8 序列化解析产物 + index.json
│   └── index.json       {"version":"99+1.6.12","keys":[<sha256>...]}
└── parsedfile-cache/<hash>/*.v8
```

`gitnexus.json` 的字段（本机实测）：

| 字段 | 内容 | 对插件的价值 |
|---|---|---|
| `repoPath` / `storagePath` / `branch` / `remoteUrl` | 仓库身份 | 关联 DSH 工作区 |
| `lastCommit` / `indexedAt` | 索引基准点 | 陈旧度判定 |
| `stats` | `{files, nodes, edges, communities, processes, embeddings}` | 仪表盘指标 |
| **`fileHashes`** | `{相对路径: sha256}`（37 条 / 1503 条实测） | ★ **差量检测的核心依据** |
| **`cacheKeys`** | 本索引依赖的解析缓存键数组 | 缓存命中率推算 |
| `indexCoverage` | `{maxFileSizeBytes, dirtyPaths[]}` | ★ 脏文件清单 |
| `capabilities` | `{graph, fts, vectorSearch}` 各自 provider/status | 能力探测 |
| `schemaFingerprint` | 模式指纹 | 全量重建判据之一 |
| `runnerIdentity` | 分析器身份（CLI 版本、构建摘要、依赖摘要） | 全量重建判据之一 |
| `unresolvedReceiverMembers` | 未解析接收者统计 | 图质量指标 |

> **关键结论**：可视化的**索引元数据**可以毫秒级直读 JSON；**图数据**只能走 HTTP 或 LadybugDB，**没有持久化 graph JSON/CSV**。

全局目录 `~/.gitnexus/`：`registry.json`（14 个已索引仓库实测）、`watch_config.yml`、`watch/{watch.mutex, auto-sync-state.json, watch.pid, watch.status.json}`、`groups/<g>/bridge.lbug`。

`registry.json` 每条记录：`{name, path, storagePath, indexedAt, lastCommit, remoteUrl, stats, branch}`。
**注意**：本机实测存在 `D:\Project\...` 与 `D:\project\...` 大小写混用，插件必须做路径规范化，否则同一仓库会被判成两个。

### 1.3 增量能力的真相（含本机实测）

#### 1.3.1 机制

| 复用层 | 键 | 证据 |
|---|---|---|
| 文件哈希表 | `path → sha256`，由 `diffFileHashes` 比对得 `{changed, added, deleted, toWrite}` | `storage/file-hash.ts:93-118` |
| 解析缓存（块级） | `sha256(sorted "filePath:contentHash")`，桶 `(language, sha256(path) mod 128)`，`SCHEMA_BUMP = 142` | `storage/parse-cache.ts:896, 872, 908-948` |
| 持久 ParsedFile | 同一个块哈希，同版本号 | `storage/parsedfile-store.ts:41-48` |
| DB 行 | 按节点 `filePath` 的 `extractChangedSubgraph` + `computeEffectiveWriteSet` | `core/incremental/subgraph-extract.ts:145, 194` |

**判定时机是流水线之后**（`core/run-analyze.ts:3067-3082`）：

```
incrementalEligible = !options.force
                   && !!existingMeta
                   && !schemaFingerprintMismatch(...)
                   && 无 analysis-feature 差异
                   && existingMeta.fileHashes 非空
                   && repoHasGit
                   && allFilePaths.length > 0
isIncremental       = incrementalEligible && isManualCheckpointEnabled()
```

即：**`gitnexus analyze` 默认就走增量**，`--force` 才是全量开关。相关 CLI 开关（`cli/index.ts:74-85`）：

| 开关 | 语义 |
|---|---|
| `--watch` | 持续串行增量刷新 |
| `--debounce <ms>` | 监听静默期 |
| `-f, --force` | 强制图与 FTS 重建；**未变的解析产物仍可复用** |
| `--no-parse-cache` | 每个源文件都重新解析 |
| `--repair-fts` | 只修复/重建搜索 FTS，不做完整重分析 |
| `--skip-fts` | 跳过 FTS 扩展加载与关键词索引 |

#### 1.3.2 全量重建触发条件

`REBUILD_REASON_KEYS` 共 19 个键（`core/rebuild-reasons.ts:17-37`），强制重建的包括：用户 `--force`、`--skills`、解析缓存旁路、`--pdg` 模式、content-retention、schema 指纹、图写入坍缩、analysis-features、spring-vendor-prefixes、runner-identity、cjk-segmentation、embedding-dims、spring-actuator、asyncapi、shared-store 缺图、**中断重建（脏标志 `incrementalInProgress`）**、private-graph 不可用。

非强制的**写计划**升级：`shouldEscalateIncrementalWrite(deleteCount, effectiveWriteCount, totalFiles) = deleteCount >= 50 && fraction > 0.5`（`core/incremental/escalation-gate.ts:50-56`）。

> ⚠️ `writeMode:'full'` 表示 **DB 写入计划升级**，不等于流水线全量重建。两者必须区分，否则日志会骗人。

#### 1.3.3 什么**不是**增量的

| 组件 | 状态 | 证据 |
|---|---|---|
| `scopeResolution` | **每次全跑**，占一次单文件编辑增量运行的 44% | `bench/analyze-phase-breakdown.md:216-238` |
| FTS 表 | 按表重建，占 24% | 同上 |
| `communities` / `processes` | 仅在**完全空 diff** 时复用 | `core/incremental/derived-writeback.ts:43-45` |
| MRO / DI / Spring AOP / Destinations | 全跑 | — |
| group bridge DB | 从零重建 | — |
| wiki | 不增量 | — |
| `parsedfile-cache/` `scope-index-store/` | 每次运行**清空**，不是复用单元 | `storage/scope-index-store.ts:81` |

GitNexus 自带基准给出的结论是：*"A one-file edit re-emits all 163,094 edges to write a 3,980-node subgraph."*（`bench/analyze-phase-breakdown.md`）
冷跑 63.6s（parse 36s + scope 16s）；单文件编辑增量跑 31.7s ⇒ **约 1.15× 提升，不是 100×**。

#### 1.3.4 本机实测（本方案作者跑出，1500 文件合成 TS 仓库）

夹具：120→1500 个 TS 文件，含 `import` 链；Git 仓库；统计 1503 files / 22207 nodes / 41556 edges / 787 communities / 410 processes。
统一参数：`--index-only --skip-fts`，`NODE_OPTIONS=--max-old-space-size=8192 GITNEXUS_MEMORY=off GITNEXUS_HOME=<workspace>`。

| 场景 | 命令 | 耗时 | 相对冷启动 |
|---|---|---|---|
| 冷启动全量 | `analyze --index-only --skip-fts` | **29.57 s** | 1.00× |
| **无变更重跑** | 同上（工作区无改动） | **8.42 s** | **0.28×** ⭐ |
| 小改动增量（5 改 + 1 增） | 同上 | 23.31 s | 0.79× |
| 强制全量（解析缓存仍复用） | `+ --force` | 19.04 s | 0.64× |
| 禁用解析缓存 | `+ --no-parse-cache` | 29.69 s | 1.00× |

**读数**：
- **无变更重跑 3.5× 提速**（29.6s → 8.4s）——这是最干净、最可靠的增量收益，也是插件应重点利用的一档。
- 小改动增量只有 0.79×——因为改动落在 `import` 链头部，跨文件传播使大量块失效；与 GitNexus 自带基准的 1.15× 同量级。
- `--force`（19.0s）比 `--no-parse-cache`（29.7s）快 10.6s ⇒ **解析缓存复用价值约 10s**，与"强制重建仍复用解析产物"的文档一致。

> **给方案的硬约束**：不要向用户承诺"秒级增量"。可承诺的是：**零变更时 0 成本确认 + 真实差量可视化 + 可增量的搜索层 + 诚实的原因披露**。

#### 1.3.5 监听模式

`gitnexus analyze --watch [--debounce ms]`：
- chokidar，`ignoreInitial/atomic/awaitWriteFinish{100,20}`，只消费 `add|change|unlink`（`cli/analyze-watch.ts:327-349`）；`.gitnexus` 被排除；`.gitignore`/`.gitnexusrc` 是优先级路径，会重新武装监听器。
- `WatchRefreshQueue`（`cli/watch-queue.ts:16-184`）：Set 合并、**永不重叠**、300ms 防抖且 `maxWaitMs = max(2000, debounce*10)`、**1000 路径上限后升级为 `'*'` 全量刷新**、指数退避至 30s。
- 每批以 `skipAgentsMd/skipSkills/noStats:true` 重跑 `runFullAnalysis`；`atomicIncremental: platform!=='win32'`。
- **`--force` / `--embeddings` / `--no-parse-cache` 在 `--watch` 下被拒绝**（`analyze-watch.ts:110-144`）。

#### 1.3.6 并发与锁

`acquireIndexLock(lockDir, opts)`（`storage/index-lock.ts:905`）：
- Windows/Linux 用**内核持有的 socket 锁**（命名管道 / 抽象 socket；`EADDRINUSE` == 有活持有者，进程死锁即释放）；其他平台用 `O_EXCL` 文件锁 + 不可窃取守卫。
- 默认 10 分钟等待上限（`GITNEXUS_INDEX_LOCK_TIMEOUT_MS`）；写者通过 `requireExclusiveIndexLock` **fail-closed**（`run-analyze.ts:1415`）。
- 有孤儿暂存清扫 `sweepStagingArtifacts`（`index-lock.ts:443`）。

> **铁律**：外部进程可以安全地**驱动**更新（调用 `runFullAnalysis` / fork worker / shell out），但**绝不能自己写 `gitnexus.json` / `meta.json` / `lbug`**。

### 1.4 可视化与查询 API 面

#### 1.4.1 启动

```
gitnexus serve [-p 4747] [--host localhost]
```

- 端口默认 **4747**；host 默认 **`'localhost'`**（`cli/serve.ts:29-33`；注意 `--help` 文案错写成 `127.0.0.1`）。
- 前置条件：`~/.gitnexus/registry.json` 至少一个仓库，否则所有路由 404（`server/api.ts:1267`）。
- 相关环境变量：`GITNEXUS_PUBLIC_ORIGIN`（设了会拒绝启动）、`GITNEXUS_TRUST_PROXY`、`GITNEXUS_MCP_AUTH_TOKEN`、`GITNEXUS_WEB_DIST`、`GITNEXUS_HOME`。

#### 1.4.2 鉴权现状（重要）

- `isServeAuthConfigured()` **恒返回 false**（`server/middleware.ts:228-230`）⇒ **serve 没有任何请求鉴权**。
- 仅 6 条写路由有同源守卫（403 `code:'origin_not_allowed'`，`middleware.ts:181-214`）；`/api/mcp` 可选 bearer（`server/mcp-http.ts:28-35`）。
- 限流默认 60/min/IP（`server/validation.ts:112,151-165`），`POST /api/analyze` 为 10，`/api/analyze/upload` 为 5，`/api/embed` 为 20。
- **无 Origin 的请求（curl/脚本）可以打到一切，包括 `DELETE /api/repo`**。

#### 1.4.3 路由表（31 条，全在 `server/api.ts`）

| 区域 | 路由 |
|---|---|
| 健康 | `GET /api/health` `:1197`、`GET /api/heartbeat`(SSE) `:1204`、`GET /api/info` `:1222` |
| 仓库目录 | `GET /api/repos` `:1231`、`GET /api/repo` `:1263`、`DELETE /api/repo` `:1293` |
| **图读取** | **`GET /api/graph` `:1398`**、`POST /api/query` `:1480`、`POST /api/search` `:1485` |
| 源码读取 | `GET /api/file` `:1666`、`GET /api/grep` `:1686` |
| 覆盖层 | `GET /api/processes` `:1775`、`/api/process` `:1788`、`/api/clusters` `:1811`、`/api/cluster` `:1824` |
| 分析任务 | `POST /api/analyze` `:1849`、`POST /api/analyze/upload` `:2052`、`GET /api/analyze/:jobId` `:2064`、`GET …/progress`(SSE) `:2076`、`DELETE /api/analyze/:jobId` `:2079` |
| 嵌入任务 | `POST /api/embed` `:2101`、`GET /api/embed/:jobId` `:2428`、`GET …/progress`(SSE) `:2438`、`DELETE /api/embed/:jobId` `:2441` |
| 运维 | `GET /api/ops` `:2469`、`GET /api/ops/stream`(SSE, 1Hz, ≤8 连接) `:2479` |
| MCP | `ALL /api/mcp`（`server/mcp-http.ts:44`） |
| 静态/SPA | `express.static` `:294-298`、SPA 回退 `:315`、落地页 `:319` |

**取图最便宜的方式**：

1. `GET /api/graph?repo=<name>&stream=true` → NDJSON `{type:'node'|'relationship', data}`（`:558-605`）。一次往返、只读句柄、**无分页无上限**。按 ~1.7 边/节点，20 万节点约 34 万条 relationship 行。
2. `POST /api/query` `{cypher, params?, repo?}` → `{result: rows}`（`:908-949`）——**大图做投影/聚合应当走这条**；写操作 403。
3. 辅助：`GET /api/repos`（先估规模）、`/api/clusters`、`/api/processes`、`/api/ops`。

> ⛔ **不要**用 MCP `cypher` 或 `gitnexus cypher` 取批量数据——它们把结果格式化成 markdown 表格（`mcp/local/local-backend.ts:4487-4519`）。

**数据形状**：`{nodes:[{id,label,properties}], relationships:[{id,type,sourceId,targetId,confidence,reason,step}]}`（`gitnexus-shared/src/graph/types.ts:281-339`）。`startLine`/`endLine` 是 **0-based**。

#### 1.4.4 图模式

- **36 个节点标签**（`gitnexus-shared/src/lbug/schema-constants.ts:11-49`；DDL 在 `gitnexus/src/core/lbug/schema.ts`）。
- **单张** `CodeRelation` 表，含 `type/confidence/reason/step/staticGated`，461 组已声明端点对（`schema.ts:684-693`）。
- **33 种关系类型**（`schema-constants.ts:55-96`）。
- 默认排除：`CONTAINS`、`DEFINES`、`MEMBER_OF`、`STEP_IN_PROCESS` 不在 `VALID_RELATION_TYPES` 内（`local-backend.ts:513-563`）；`ACCESSES` 不在默认 impact 遍历里。
- PDG/污点层（`CFG`/`REACHING_DEF`/`CDG`/`TAINTED`/`SANITIZES`/`TAINT_PATH`/`POST_DOMINATE`/`CALL_SUMMARY`）**仅在 `analyze --pdg` 后才有**。

#### 1.4.5 现有 Web UI

- 渲染栈：**sigma 3.0.3（WebGL）+ graphology 0.26.0 + @sigma/edge-curve 3.1.0 + graphology-layout-forceatlas2 0.10.1**（`gitnexus-web/src/hooks/useSigma.ts:400-469`）。
- **无采样、无聚合**——整图或什么都不画。**文档化上限：25,000 节点 / 50,000 边**（`gitnexus-web/src/config/ui-constants.ts:41,50`；判定 `lib/graph-load-decision.ts:45-54`），超过就退化成"仅对话"模式。服务端不设上限。
- 构建：dev `npm run dev`（vite :5173）；prod `tsc -b && vite build` → `gitnexus-web/dist`；`serve` 依次解析 `<pkg>/web`、`gitnexus-web/dist`（`api.ts:2514-2516`，可用 `GITNEXUS_WEB_DIST` 覆盖）。
- **坑**：运行时配置全局 `window.__GITNEXUS_CONFIG__{backendUrl, largeGraphNodeThreshold, largeGraphEdgeThreshold}` 只有 `docker-server.mjs:83-89` 会注入，**`serve` 不注入**。所以被 serve 出来的 UI 会退回 `localStorage['gitnexus-backend-url']` → 全局 → `http://localhost:4747`。**必须用 URL 传后端**：`?server=<apiUrl>&repo=<registryPath>`。
- 可嵌入的 URL（`App.tsx:46-52`）：
  - `?server=<api>&repo=<registryPath>&project=<name>` → 钉住的图浏览器
  - `?server=<api>&project=<name>&skipGraph=1` → 仅对话
  - **`?view=ops&server=<api>`** → 独立的运维/状态看板（无应用外壳）
- **无 widget、无按仓库路由、无分享链接**；SPA 无 router，视图全靠 query 参数。
- `serve` **不设** `X-Frame-Options`/CSP/COOP/COEP ⇒ **可以 iframe**。（Docker web 镜像设了 COOP/COEP，**不可** iframe。）
- `gitnexus wiki` 会产出自包含的 `<storagePath>/wiki/index.html`（`cli/wiki.ts:598-599`）。

#### 1.4.6 MCP 面（供参考，插件可直接复用）

19 个工具（17 个单仓库 + 2 个 group），见 `mcp/tools.ts:114-1106`。除 `rename`（`dry_run` 默认 true）与 `group_sync`（写 `contracts.json`）外都是只读。`GITNEXUS_MCP_READ_ONLY=1` 保留 16 个（去掉 `cypher`/`group_list`/`group_sync`）。
资源：2 个静态 + 8 个模板（`mcp/resources.ts:36-127`），全部 `text/yaml`，clusters/processes 截断到前 20。**没有整图资源**。

### 1.5 运行时与沙箱约束（本机实测，方案的关键输入）

这三条是本方案作者在实际运行中撞出来的，直接决定 host 半怎么起进程。

#### 1.5.1 管道 stdio 下的 `spawn EPERM`

`gitnexus analyze` 会**自我重启**以获得更大堆（`cli/analyze.js` 的 `ensureHeap` → `runRespawnedAnalyze`），用 `child_process.spawn` 默认管道 stdio。在受限沙箱下直接失败：

```
Error: spawn EPERM
    at runRespawnedAnalyze (.../analyze.js:282:44)
    at ensureHeap (.../analyze.js:480:29)
```

**解法（已实测）**：

```powershell
$env:NODE_OPTIONS       = '--max-old-space-size=8192'
$env:GITNEXUS_MEMORY    = 'off'   # 关键：抑制自我重启
```

只设 `NODE_OPTIONS` 不够——GitNexus 会认为"8192MB 低于本机 48993MB 上限"并**照样重启**，必须 `GITNEXUS_MEMORY=off` 才吸收该值。

#### 1.5.2 FTS 扩展安装同样 EPERM

绕过堆重启后，下一步死在 `installDuckDbExtensionOutOfProcess`（`core/lbug/extension-loader.js:61`）：

```
Error: spawn EPERM
    at installDuckDbExtensionOutOfProcess (.../extension-loader.js:61:18)
    at async loadFTSExtension (.../lbug-adapter.js:2952:20)
```

**解法（已实测）**：`--skip-fts` 跳过扩展加载（索引本身建得出来），之后按需用 `--repair-fts` 单独修搜索索引。

#### 1.5.3 全局注册表越界

流水线跑完后，最后一步写 `~/.gitnexus/registry.json` 在 DSH 沙箱下越界：

```
Error: EPERM: operation not permitted, open 'C:\Users\massnote\.gitnexus\registry.json.tmp...'
    at async writeRegistry (.../repo-manager.js:688:5)
```

**解法（已实测）**：`GITNEXUS_HOME=<workspace 内目录>` 把全局目录重定向进工作区，注册表成功写入、退出码 0。

> 组合起来，本机成功复现的完整命令等价于：
> ```powershell
> $env:NODE_OPTIONS='--max-old-space-size=8192'; $env:GITNEXUS_MEMORY='off'
> $env:GITNEXUS_HOME='<workspace>\.gitnexus-home'
> gitnexus analyze --index-only --skip-fts <repo>
> ```

#### 1.5.4 对插件的三条设计约束

1. **任何 `analyze` 调用都必须由 host 半在后台 job 里发起**（`ctx.jobs`），不能同步阻塞一次工具调用（实测 8–30s，大仓库更久）。
2. 环境变量必须显式注入（`GITNEXUS_MEMORY=off`、`NODE_OPTIONS`、`GITNEXUS_HOME`），不能依赖继承。
3. 当索引目录在 DSH 工作区之外时，写操作需要用户批准的 `danger-full-access` 升级——插件必须把这条设计成**一条明确的、可解释的升级路径**，而不是静默失败。

---

## 2. DSH 插件契约（以已安装的 0.2.0-rc.2 为准）

> ⚠️ **文档版本说明**：官方文档站从仓库 `master` 构建；本地 checkout `D:\Project\deepseek-harness` 是 master 的 **2026-09-08 快照**（包版本 0.1.3-alpha.2），**比文档站旧**——缺 `plugin-manager`、桌面 profile 归属、默认端口 19387、`capability-seams` 等章节，而这些恰好影响本方案。实际加载插件的是 **0.2.0-rc.2** 发行版（`…\DSH Desktop\resources\app\node_modules\@deepseek-ai\`）。
> **取证优先级：官方文档站 / 已安装包（含随包 README、`lib/*.js`）/ 已装第三方插件真实代码 > 本地快照文档。** 本节结论均已按此核对。

### 2.1 双半插件包结构

```
dsh-gitnexus-plus/
├── package.json
├── cordis.patch.yml
├── tsconfig.json
├── scripts/build-client.mjs
├── src/index.ts            → lib/index.js   （host 半，ESM）
└── src/client/index.tsx    → lib/client.js  （client 半，lazy-CJS）
```

- **host 半是 ESM**：`export const name / inject / apply / Config`。
- **client 半不是 ESM**：必须是 CJS，并包在 `window.__ModuleLoader__.load({ id, factory })` 里。
- 声明了 `dsh.client` 就**必须**导出 `"./client"`，否则 `client-modules` 启动即抛。

### 2.2 `dsh` 字段

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": false, "inject": ["@deepseek-ai/dsh-client-ui-renderer"] }
}
```

| 字段 | 语义 |
|---|---|
| `dsh.bundle.patch` | bundle 层补丁文件路径（相对包根）；缺失则启动时报错 |
| `dsh.client.platform` | 必须 `'web'`，否则 `ClientModuleRegistry` 返回 null |
| `dsh.client.inject` | **仅信息用途**，不决定激活顺序（不要拿它排序） |
| `dsh.client.external` | 精确的非基线模块表说明符；不是特性依赖机制 |
| `dsh.profile.bundles` | profile 里的有序层列表；`patchReload: 'live'|'startup'` |

**隐式基线（不要重复声明）**：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`。

> `dsh.engines` / `dsh.compatibility` / `dsh.plugin.json` **不是 DSH 核心字段**（`dsh-free-search`、`dsh-bash-terminal-ts` 里出现的是生态/市场侧元数据）。

### 2.3 `cordis.patch.yml`

```yaml
- insert:
    - id: gitnexus-plus
      name: dsh-gitnexus-plus
      config:
        serverPort: 4747
        autoStartServer: true
```

语义要点：
- `insert` **不带** `id` → 追加到顶层条目列表；`insert` **带** `id` → 追加到该 group 条目的 `config` 数组。
- 非 insert 补丁**必须带 `id`**；`id` 未匹配 → **告警并跳过，不抛错**。
- `name` 在非 insert 补丁里是**不匹配守卫**。
- **`config` 是整体覆盖，不做深合并**——必须把所有键写全。
- **补丁顺序**：`dsh.profile.bundles` 顺序 → profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → 各 `--patch`（argv 顺序）。同行后者胜。
- `!!js` 在条目激活时对 Loader 上下文求值。

#### 插件配置（Config）——官方形态

`Config` 必须是 **Schemastery schema**（满足 Cordis 要求的 Standard Schema 接口），与同名 TS 接口一起导出；默认值直接写在 schema 里：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  serverPort: number
  bindHost: string
  autoStartServer: boolean
}

export const Config: Schema<Config> = Schema.object({
  serverPort: Schema.natural().default(4747),
  bindHost: Schema.string().default('127.0.0.1'),
  autoStartServer: Schema.boolean().default(true),
})

export function apply(ctx: Context, config: Config) { /* 配置已校验并填好默认值 */ }
```

官方两条设计原则，本方案照做：
1. **无硬编码可调参数**——检验标准是"能否在 `cordis.yml` 里改掉它而不动代码"。§3.6 列的每一项设置项都必须走这里。
2. **配置错误要响亮**——把约束表达在 schema 里，让非法配置在**插件加载时**失败，而不是运行到一半才炸。

> ⚠️ 不要导出普通对象当 `Config`——不满足 Standard Schema 接口，插件加载会失败。
> 配置变更会触发插件热替换：框架卸载旧实例、加载新实例；因为注册都属于 effect 会自动清理，替换后不会残留旧注册。

### 2.4 host 半：工具注册

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'gitnexus-plus'
export const inject = ['tools', 'webServer', 'jobs', 'settings']

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool<StatusResult>({
    name: 'gitnexus_status',
    description: 'Report the GitNexus index status of a repository.',
    parameters: {
      repo:   { type: 'string', required: true, description: 'Absolute repo path or registry alias' },
      detail: { type: 'boolean', description: 'Include per-file drift detail' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { /* … */ } },
      render: (_args, value) => [{ type: 'text', text: formatStatus(value) }], // 必须返回 ContentBlock[]
    },
    async execute(args, exec) { /* … */ },
  }))
}
```

要点：
- **schema DSL 是 DSH 自己的 JSON 值 DSL**（`string`/`number`/`integer`/`boolean`/`null`/`array`/`object`/`oneOf`），**不是** Schemastery / TypeBox / zod。Schemastery 只用于插件 `Config`。
- `output.render` **必须返回 `ContentBlock[]`**，返回裸字符串会让 `tools/post-execute` 消费者崩溃。
- 模型看到的描述走 `schemas()` 白名单；`output/execute/finalizeContent/timeoutMs/presentCall/presentResult` **不会泄漏**给模型。
- 错误码：`ToolArgsError`/`INVALID_ARGS`、`ToolOutputError`/`INVALID_TOOL_OUTPUT`、`UNKNOWN_TOOL`、`ABORTED`、`TOOL_TIMEOUT`。
- 长任务：`ctx.jobs.start({ kind, label, owner: exec.agent, run })`，之后用任务自有 signal，而不是 `exec.signal`。
- 自定义 Web 卡片要注册进 `tool.call.toolview` 键控槽（内置 Web Client **不消费** `presentCall`/`presentResult`）。

### 2.5 host 半：HTTP 路由

```ts
import type { IncomingMessage, ServerResponse } from 'node:http'

const dispose = ctx.webServer.register({
  kind: 'prefix',
  path: '/api/gitnexus',
  handler: (req, res) => { /* bare node:http */ },
})
```

- 裸 `node:http`——**没有** Express / Hono / 中间件。匹配顺序：exact 表 → 最长 prefix → fallback。
- 重复 `(kind, path)` **抛错**。`/plugins/*` 被 client-modules 占用。社区前缀约定 `/api/<plugin-slug>/…`。
- **第三方命名路由默认无鉴权**：载体"不负责 TLS、鉴权或 Origin 策略"，`client/connection` 注册的 Host/Origin 检查只覆盖它自己注册的路由。`dsh-free-search` 因此**自己实现**了 loopback + method 守卫、`writeJson`/`readJsonBody` 带字节上限、`referrer-policy: no-referrer`。
- **但在 Desktop profile 上有一层额外保护（实测）**：桌面壳用 `DesktopWebServer extends WebServer` 接管该服务，强制 `host === '127.0.0.1'`（否则构造即抛错），并在前面加了浏览器访问门 `decideDesktopBrowserAccess`：
  - 带正确 `x-dsh-desktop-renderer` 令牌（32 字节 base64url，每次 Host 世代随机生成，只有 Electron 渲染进程的原生网络会话会附上）→ `renderer`，放行；
  - 否则若 `ordinaryBrowserEnabled` 为 false，或 URL 里带 `dsh-desktop-*` 查询参数 → `denied`，返回 **403 forbidden**；
  - 其余 → `browser`，放行。
  本机实测 `GET /`、`GET /api/health`、`GET /api/dsh-free-search-settings` **全部 403**（注意是 403 而非 404，说明请求根本没进路由），即 `ordinaryBrowserEnabled` 为 false。
  ⇒ **插件路由只有 DSH 自己的渲染进程能到达**；外部 curl、普通浏览器都打不到。方案 §3.4 的自建守卫因此是**纵深防御**，而不是唯一防线。同时这也意味着：**不能给用户一个"用系统浏览器打开这个看板"的入口**（会被 403）。

### 2.6 client 半：构建契约

`dsh-bash-terminal-ts` 的 `scripts/build-client.mjs` 是现成范式（esbuild）：

```js
await build({
  entryPoints: [join(root, 'src', 'client.tsx')],
  bundle: true, format: 'cjs', platform: 'browser',
  outfile: join(root, 'dist', 'client.core.js'),
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/*'],
  loader: { '.css': 'text' }, jsx: 'automatic',
  tsconfigRaw: { compilerOptions: { target: 'ES2022', useDefineForClassFields: true } },
})
// 再包一层 window.__ModuleLoader__.load({ id, factory: (require) => { … } }) → lib/client.js
```

**必须自己复刻**（仓库内 preset 未发布）：`format:'cjs'` + banner/intro/footer 包装，`external` = 9 项基线。**不要 bundle `@deepseek-ai/*` 或 react**——它们在模块表里解析。

### 2.7 client 半：UI 贡献

一个 API：`ctx.slots.register({ name, children?, store?, inject?, locale?, key?/id?/order?/label?/priority? }, Component)`，配合 `ctx.slots.inject(key, () => register(...))` 等待别人声明的槽。

槽分级树（节选）：

```
root
├─ sidebar
├─ conversation
│  └─ … conversation.chat.node → tool.call.toolview
├─ rightbar                     ← 右侧栏（每会话的停靠面）
│  ├─ sidebar.right.pane.tab          (keyed, session)
│  ├─ sidebar.right.pane.tab.title    (keyed, session)
│  ├─ sidebar.right.tab.guide         (chain, session)
│  └─ sidebar.right.tab.menu.item     (list, session)
└─ shell.overlay                ← 浮层/整页（list, root）
```

> ⛔ **绝不注册进 `root`**——它是 `single`，会遮蔽整个 AppFrame。

**右侧栏 Tab 类型**是本插件的主界面落点（已核对已安装包 `dsh-client-ui-sidebar-right@0.2.0-rc.2`）：

```ts
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

export const inject = ['sidebarRightTabs', 'slots']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'dsh-gitnexus-plus',
    kind: 'gitnexus',
    priority: 'extension',           // extension | builtin | fallback
    title: () => 'GitNexus',
    keepMounted: true,
  }), 'gitnexus tab type')

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: 'dsh-gitnexus-plus' }, IndexPanel))
}
```

已安装包的实测签名：`register(definition)`（`lib/client.js:8690`）、`candidates(address)` `:8782`、`claim(address, kind)` `:8812`、`openTab(kind, options)` `:6394`；definition 支持 `id/kind/priority/patterns/canOpen/title/guide/keepMounted`；重复 `id` 抛错；返回幂等 disposer（内部已包 `ctx.effect`）。
打开：`ctx.sidebarRight.openTab('gitnexus')`。

**浏览器半访问 host 路由的正确姿势**（`dsh-bash-terminal-ts/src/webterminals/browser/url.ts` 的结论）：

```ts
// HTTP 必须留在页面自身 base 上，且去掉前导斜杠，否则 Electron dsh-app:// 外壳与反向代理前缀都会丢
new URL(path.replace(/^\/+/, ''), directoryBase(document.baseURI))
// WebSocket 用外壳注入的 __DSH_TRANSPORT__.streamBaseUrl
```

⇒ **浏览器半绝不能硬编码 `http://127.0.0.1:4747`**（跨源，且插件路由不发 CORS 头）。必须同源打到插件自己的路由，由 host 半代理。

### 2.8 安装与热重载边界（已核对官方文档站 + 已安装的 `dsh-plugin-manager@0.2.0-rc.2`）

> ⚠️ **本节是本方案修正幅度最大的一节。** 初版写的 `dsh plugin --profile desktop add …` 是**错的**。

#### 两种 profile，两种权限

| profile | 谁拥有 | 怎么装 | 能否用公开 CLI |
|---|---|---|---|
| `web`（`~/.dsh/profiles/web`） | 公开 CLI | `dsh plugin --profile web add …` | ✅ 可以 |
| **`desktop`**（`~/.dsh/profiles/desktop`） | **Electron 独占** | **Web 侧边栏「插件」页**，或 Creator 模式下的 `plugin_manager` 工具 | ❌ **不可以** |

官方架构文档明确：*"Electron 拥有保留 profile `$DSH_HOME/profiles/desktop`……**CLI 不能启动或修改该 profile**。"*
本机实测佐证：`dsh --profile desktop --dump-config` 直接失败（`prepareProfile` 试图写 `profiles/desktop/cordis.yml`）。

Desktop 侧还有三条硬事实：
- 走**内置 Node.js + 内置 pnpm**，store 固定在 `$DSH_HOME/desktop/pnpm/store`；**系统 Node / 系统 pnpm / 用户的包管理器配置不进入执行路径**。
- Electron 在碰任何 profile 前取**进程生命周期单实例锁**，独占该 profile 及其包管理器状态。
- 插件变更是**事务式**的：装到 staging → 起完整后端做健康检查 → 才替换活跃 profile；中断由事务日志 + rollback profile 恢复。

#### 安装契约（来自 `dsh-plugin-manager` README）

`inspect(spec)` 与 `installBundle(spec)` 接受的 spec 形态：

| spec | 说明 |
|---|---|
| registry 包名 | 经 `pnpm view` 查询；注册表可按 `registry` → `fallbackRegistries` 顺序回退 |
| **绝对路径** | **直接读该目录的 `package.json`**（本方案本地开发就用这条） |
| git 地址 / tarball | 安装前先 `git ls-remote` 探活（`githubConnectionTimeoutMs` 默认 5000ms）；本地路径与 tarball **跳过**该探查 |

要点：
- **DSH peer 兼容性预检发生在 pnpm 之前**——本地路径读自己的 `package.json`，registry spec 查注册表选中的版本及其 peer；不兼容则**不下载任何东西、不跑构建脚本**，直接失败。所以 `peerDependencies` 写对很值钱。
- **依赖构建脚本需单独批准**：pnpm 11 会拦下脚本，失败的安装在 `pendingBuilds` 里列出待决定的包名；Web 插件页提供「允许这些脚本并重试」。插件的 `postinstall` 之类不会被静默执行。
- 失败或被取消的安装会**恢复 `package.json` 与 `pnpm-lock.yaml` 快照**（但 pnpm 已下载的文件可能保留）。
- `plugin_manager` 工具的**每个操作都要求 `danger-full-access` 或本次调用的批准**；它在 **Creator 模式**下启用，其他预设默认禁用（本会话就没有这个工具）。
- 开关语义：**组合包**开关改 `package.json` 里的有序 `dsh.profile.bundles`；**单个插件行**开关只改 profile 的 `cordis.patch.yml` 里最后一条匹配覆盖项的 `disabled`。新装的组合包**默认启用**。

#### 推荐的开发回路

```
# 1) 开发期：挂到 web profile（公开 CLI 可管理），用 --patch overlay 免装
pnpm dsh web --patch ./gitnexus-plus/cordis.patch.yml     # 官方教程回路，http://127.0.0.1:3080

# 2) 联调期：装进 web profile
dsh plugin --profile web add <绝对路径>/gitnexus-plus

# 3) 交付期：发布后在 Desktop 的 Web「插件」页填入包名或绝对路径安装
#    切勿手改 ~/.dsh/profiles/desktop/package.json，也不要对 Desktop profile 跑系统 pnpm
```

#### 热重载边界

本机 `dsh --version` = `0.2.0-rc.2`，`DSH_PROFILE=desktop`，`DSH_PROFILE_DIR=C:\Users\massnote\.dsh\profiles\desktop`。

| 改动 | 生效方式 |
|---|---|
| bundle 增删/升级 | **必须重启**（Desktop 走 staging→健康检查→激活） |
| profile / home 的 `cordis.patch.yml` | 若 `patchReload: live` 则**热重载**（事务性重放） |
| bundle 自带的 `cordis.patch.yml` | 不被监听 ⇒ 实际需重启 |
| `lib/client.js` | 客户端 HMR（需 `dsh-client-hmr` 挂载 + 有 watcher 重建） |
| host 插件源码 | 需 `@deepseek-ai/cordis-plugin-hmr`（基线层该行默认 `disabled: true`） |

> `patchReload: live` 是**配置文件监听**，不是模块重载；端口不会被重置。这也是插件管理器逐行开关能免重启的原因。
> HMR 会串行执行模块重载、文件监听与管理写入，并与 CLI/service 共用 profile manifest 写锁（HMR 自身不取该锁）。

---

## 3. 插件设计

**包名**：`dsh-gitnexus-plus`　**仓库**：`D:\Project\gitnexus-plus`
**目标运行时**：DSH `0.2.0-rc.2`（`engines.dsh: ">=0.2.0-rc.2 <0.3.0"`）+ `gitnexus >=1.6.12`

### 3.0 设计原则

1. **不做 GitNexus 已经做的事**——解析、图构建、查询全部委托给 `gitnexus` CLI / `serve`。插件是**驱动者与呈现者**，不是第二个索引器。
2. **绝不手写索引文件**——只通过 `analyze` / worker / HTTP 写入，尊重 `acquireIndexLock` 的 fail-closed 语义。
3. **诚实披露**——每次更新都告诉用户走了哪一档、为什么、哪些部分没有增量。绝不把 `writeMode:'full'` 说成"全量重建"，也绝不把 0.79× 说成"秒级"。
4. **沙箱优先**——默认路径就在受限沙箱里能跑通；需要提权时给出一条可解释、可批准的升级路径。

### 3.1 包结构

```
gitnexus-plus/
├── package.json
├── cordis.patch.yml
├── tsconfig.json  tsconfig.client.json
├── scripts/
│   ├── build-client.mjs          esbuild → lib/client.js
│   └── check-artifacts.mjs       构建产物自检
├── src/                          ── host 半（ESM）
│   ├── index.ts                  name/inject/apply/Config
│   ├── config.ts                 Schemastery Config
│   ├── gitnexus/
│   │   ├── locate.ts             定位 CLI / registry / storagePath
│   │   ├── registry.ts           读 ~/.gitnexus/registry.json（含路径规范化）
│   │   ├── meta.ts               读 .gitnexus/gitnexus.json
│   │   ├── delta.ts              ★ Tier 0/1 差量引擎
│   │   ├── update.ts             ★ Tier 2/3 更新编排
│   │   ├── watch.ts              ★ Tier 4 常驻监听 job
│   │   ├── embeddings.ts         按变更节点增量补 embedding
│   │   └── serve.ts              serve 子进程生命周期
│   ├── routes/
│   │   ├── index.ts              /api/gitnexus/* 挂载 + 守卫
│   │   └── guard.ts              loopback + method + body 上限
│   └── tools/
│       ├── status.ts  update.ts  graph.ts  query.ts  watch.ts
└── src/client/                   ── client 半（lazy-CJS）
    ├── index.tsx                 inject/apply
    ├── panel/IndexPanel.tsx      右侧栏主体（仪表盘 + 图 + 差量）
    ├── panel/GraphCanvas.tsx     sigma 渲染
    ├── panel/DeltaList.tsx       变更文件/符号列表
    ├── panel/FreshnessBar.tsx    新鲜度 + 更新档位 + 原因
    ├── settings/SettingsCard.tsx 设置卡
    └── api.ts                    同源 fetch 封装
```

### 3.2 `package.json` 骨架

```jsonc
{
  "name": "dsh-gitnexus-plus",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".":        { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml"],
  "engines": { "node": ">=22", "dsh": ">=0.2.0-rc.2 <0.3.0" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-tools": "0.2.0-rc.2",
    "@deepseek-ai/dsh-client-ui-slots": "0.2.0-rc.2",
    "@deepseek-ai/dsh-client-ui-sidebar-right": "0.2.0-rc.2",
    "react": "^18.2.0"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.4",
    "sigma": "^3.0.3",
    "graphology": "^0.26.0",
    "graphology-layout-forceatlas2": "^0.10.1"
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: gitnexus-plus
      name: dsh-gitnexus-plus
      config:
        serverPort: 4747
        autoStartServer: true
        bindHost: 127.0.0.1
        cacheDir: ''            # 空 = 用 <workspace>/.gitnexus-home
```

### 3.3 host 半暴露的工具

| 工具 | 用途 | 关键参数 | 档位 |
|---|---|---|---|
| `gitnexus_status` | 索引状态 / 新鲜度 / 差量摘要 | `repo`, `detail?` | Tier 0，**不启动分析** |
| `gitnexus_delta` | 列出相对索引的变更文件与受影响符号 | `repo`, `limit?` | Tier 0 |
| `gitnexus_update` | 分层更新索引 | `repo`, `mode?: 'auto'\|'incremental'\|'full'`, `fts?: boolean`, `background?` | Tier 1–3 |
| `gitnexus_watch` | 常驻监听开关 | `repo`, `action: 'start'\|'stop'\|'status'`, `debounceMs?` | Tier 4 |
| `gitnexus_graph` | 取子图/投影供可视化 | `repo`, `projection?`, `maxNodes?`, `focus?` | 读 |
| `gitnexus_query` | 图查询（受控 Cypher 或语义检索） | `repo`, `cypher?`, `search?` | 读 |
| `gitnexus_open` | 在右侧栏打开可视化面板 | `repo`, `focus?` | UI |

所有长任务的工具**一律**用 `ctx.jobs.start` 起后台任务并返回 jobId，风格对齐内置的 `shell` 工具（`run_in_background` + `job_id` + `job_output`）。

### 3.4 host 半路由（同源代理）

```
GET  /api/gitnexus/repos                  仓库列表（代理 /api/repos + 合并本地发现）
GET  /api/gitnexus/status?repo=           状态 + 差量（本地计算，不碰 serve）
GET  /api/gitnexus/languages?repo=&scope= 语言分布：scope=indexed|tracked|symbols（本地聚合）
GET  /api/gitnexus/coverage?repo=         未索引归因：超限 / 忽略规则 / 未跟踪（本地聚合）
GET  /api/gitnexus/problems?repo=         结构巡检：代理 `gitnexus check --cycles --json`
GET  /api/gitnexus/graph?repo=&max=&focus= 图数据（代理 /api/graph 或 /api/query，带采样）
POST /api/gitnexus/query                  受控查询（白名单投影，不裸转发 Cypher）
POST /api/gitnexus/update                 触发分层更新，返回 jobId
GET  /api/gitnexus/jobs/:id               任务进度（轮询）
GET  /api/gitnexus/jobs/:id/stream        SSE 进度（代理 serve 的 SSE）
GET  /api/gitnexus/serve                   serve 子进程状态/启停
```

**必须实现的守卫**（照 `dsh-free-search` 的做法）：

1. 只接受 loopback 来源（`req.socket.remoteAddress` ∈ `127.0.0.1`/`::1`）。
2. 方法白名单；写操作要求同源 `Origin`/`Referer`。
3. 请求体字节上限 + JSON 解析错误归一化。
4. **绝不裸转发 `POST /api/query`**——那是任意读原语。改为**服务端投影白名单**（如 `processes` / `clusters` / `neighbors(id, depth)` / `community(id)`），把 Cyper 模板留在 host 侧，参数化注入。
5. 响应头 `referrer-policy: no-referrer`。

**serve 子进程管理**：只绑 `127.0.0.1`（**绝不 `0.0.0.0`**，因为 serve 无鉴权）；惰性启动、健康探针 `/api/health`、随插件 dispose 关闭、端口占用时顺延。

### 3.5 ★ 增量引擎：四档阶梯

这是本方案的核心。设计目标是**把"能省的全省掉"，并对省不掉的诚实披露**。

```
                    ┌─────────────────────────────────────────────┐
   文件变更事件 ───► │ Tier 0  REVALIDATE（本地，毫秒级，无 analyzer）│
                    └──────────────┬──────────────────────────────┘
                                   │ 计算 delta = fileHashes vs 现状
              ┌────────────────────┴────────────────────┐
        delta 为空                                  delta 非空
              │                                        │
     标记 fresh，刷新 UI                      ┌────────┴─────────┐
     （实测省下 8.4s / 21.2s）            仅非索引文件变更    索引内源文件变更
                                              │                  │
                                     ┌────────┴───────┐  ┌───────┴────────────────┐
                                     │ Tier 1 元数据刷新 │  │ 升级判据命中？          │
                                     │ 不跑 analyzer     │  └────┬──────────┬────────┘
                                     └───────────────────┘     是 │           │ 否
                                                                 ▼           ▼
                                                    ┌────────────────┐ ┌──────────────────┐
                                                    │ Tier 3 全量     │ │ Tier 2 增量       │
                                                    │ --force        │ │ analyze（默认）    │
                                                    └────────────────┘ └──────────────────┘
                                                                              │
                                                              ┌───────────────┴──────────────┐
                                                              │ 搜索层真正增量：              │
                                                              │ · embeddings 只补变更节点     │
                                                              │ · --repair-fts 单独修 FTS    │
                                                              └──────────────────────────────┘

    Tier 4  WATCH：常驻 analyze --watch 后台 job（防抖/合并/退避由 GitNexus 自己保证）
```

#### Tier 0 —— REVALIDATE（零 analyzer 成本）

输入：`.gitnexus/gitnexus.json` 的 `fileHashes` + `indexCoverage.dirtyPaths`；输出：变更集合。

```ts
// src/gitnexus/delta.ts（要点）
export interface Delta {
  added: string[]; modified: string[]; deleted: string[]
  indexedTouched: boolean      // 是否触及"被索引"的文件（决定 Tier 1 vs Tier 2）
  total: number; computedAt: number
}

// 两段式，先便宜后昂贵：
// 1) git status --porcelain -z  → 路径级候选（亚秒级，无需读文件内容）
//    · 索引里没有的路径 → added
//    · 索引里有但磁盘没有 → deleted
// 2) 仅对候选 + mtime > indexedAt 的路径算 sha256，与 fileHashes 比对 → modified
//    · mtime 未变且非 git 脏 → 直接判定未变，跳过哈希
```

**为什么这一档最值钱**：实测无变更重跑仍要 8.42s，而这一步是**毫秒级**。DSH 里"每轮对话都验一次新鲜度"因此变得可行。

判定 `indexedTouched`：用 `gitnexus.json` 的 `fileHashes` 键集合（就是被索引的文件清单）与实际变更路径求交；同时尊重 `indexCoverage.maxFileSizeBytes`（超限文件不算触碰）与 `.gitnexusignore`。

#### Tier 1 —— 元数据刷新

只改了 `README.md`、文档、图片、超限大文件 ⇒ 更新视图与"最后校验时间"，**不跑 analyzer**。同步更新 `indexCoverage.dirtyPaths` 的展示（只读，不改文件）。

#### Tier 2 —— 增量 analyze

命中"索引内源文件变更"且未触发升级判据时执行：

```ts
await run('gitnexus', [
  'analyze', repoPath,
  '--index-only',            // 不注入 AGENTS.md / skills，避免污染用户仓库
  '--skip-fts',              // 沙箱必需；FTS 单独修
], {
  env: {
    ...process.env,
    NODE_OPTIONS: '--max-old-space-size=8192',  // 抑制堆重启
    GITNEXUS_MEMORY: 'off',                     // ★ 关键
    GITNEXUS_HOME: cacheDir,                    // 全局目录重定向进工作区
  },
})
```

随后**真正增量的搜索层**（这是全局流水线之外唯一可增量的部分）：

1. `gitnexus analyze --repair-fts`（只重建搜索索引，不做完整重分析）；
2. `gitnexus embeddings sync` / `POST /api/embed`——embedding 是**按节点**的，只对变更符号补向量，天然增量。

#### Tier 3 —— 全量重建（必须解释原因）

升级判据（对齐 `REBUILD_REASON_KEYS` 与 `escalation-gate`）：

| 判据 | 检测方式 |
|---|---|
| 用户显式 `mode: 'full'` | 参数 |
| `schemaFingerprint` 变化 | 比较 `gitnexus.json` 与当前 CLI 期望值 |
| `runnerIdentity` 变化（CLI 版本/构建/依赖摘要） | 比较 `gitnexus.json.runnerIdentity` 与 `gitnexus --version` |
| content-retention / cjk-segmentation / embedding-dims 变化 | 比较配置与 meta |
| 删除占比 > 50% 且删除数 ≥ 50 | `shouldEscalateIncrementalWrite` 同款阈值 |
| 上次重建被中断（`incrementalInProgress` 脏标志） | 读取 meta |
| PDG 模式切换 | 配置 vs `capabilities` |

**每档更新都必须产出结构化结果并展示**：

```jsonc
{
  "tier": 2,
  "reason": "incremental-eligible",
  "writeMode": "subgraph",          // 来自 analyze 输出；'full' 表示写计划升级，≠流水线全量
  "changedFiles": 6, "reparsedChunks": 6,
  "durationMs": 23310,
  "skipped": ["fts"],               // 因沙箱跳过、待 repair 的部分
  "searchRefresh": { "embeddings": 12, "ftsRepaired": true }
}
```

> 这一步是"诚实披露"原则的落点：用户能看到 **3.5× 的复验、0.79× 的真实增量、以及哪些没增量**，而不是一个含糊的"已更新"。

#### Tier 4 —— WATCH 常驻

`gitnexus analyze --watch --debounce <ms>` 作为 DSH 后台 job 常驻。**不要自己实现防抖**——GitNexus 的 `WatchRefreshQueue` 已经做了 Set 合并、永不重叠、300ms 防抖 + `maxWaitMs`、1000 路径上限升级、30s 指数退避。插件只负责：
- 起停与状态（`gitnexus_watch`）；
- 把 watcher 的 stdout JSON 日志转成 UI 事件；
- 明确告知：**`--watch` 下 `--force`/`--embeddings`/`--no-parse-cache` 会被拒绝**（GitNexus 直接报错）。

#### 与 DSH 的集成

- **触发时机**：会话开始 / `workspace` 切换 / 用户显式 `/gitnexus-refresh` / 可选的文件变更事件（通过 `ctx.fs` 或 watcher）。
- **冷却**：同一仓库同一分钟内不重复触发 Tier 2/3；Tier 0 不限。
- **锁**：不在插件层加锁——GitNexus 的 `acquireIndexLock` 已经是权威（`EADDRINUSE` == 有活持有者，进程死即释放）。插件只做**友好的等待提示**。
- **提权路径**：若 `storagePath` 在 DSH 工作区之外，Tier 2/3 需要 `danger-full-access`。插件必须**先解释再请求**："索引目录 `<path>` 在工作区外，写入需要提升权限；仅此一次，命令为 `<exact command>`。"

### 3.6 可视化设计

#### 选型对比

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **A. iframe 现成 Web UI** | 零开发；图渲染开箱即用 | 25k 节点/50k 边上限；无法显示差量；主题不一致；`serve` 不注入 `__GITNEXUS_CONFIG__` 要手工传 `?server=` | **作为逃生舱**保留 |
| **B. iframe `?view=ops`** | 独立状态看板，零开发 | 只有运维指标，没有差量、没有仓库上下文 | 不使用 |
| **C. 自绘 sigma 画布** | 可采样/聚合（突破 25k）；可做**差量高亮**；可集成 DSH 主题与选中态 | 有开发量（sigma+graphology 约 4 个包） | **主方案** |

**决定：C 为主，A 为逃生舱**。理由：①"可视化查看索引"里最有价值的是**索引本身的状态与差量**，现成 UI 恰恰不显示；②增量是核心需求，**差量必须能看见**，只有自绘能做到；③本机实测有 93127 节点 / 135723 边的仓库（material-ui），已远超 25k 上限，现成 UI 对它直接放弃绘图。

#### 面板信息架构

`sidebar.right.pane.tab` 的 `IndexPanel`，五个堆叠区：

```
┌─ GitNexus 索引 ──────────────────────────── [刷新] [更新] [⋯] ┐
│ 新鲜度条 FreshnessBar                                          │
│  ● current  ·  索引于 2 分钟前  ·  HEAD a1b2c3d                │
│  Tier 0 复验：0 变更（0.04s）                                   │
├─ 指标 Metrics ────────────────────────────────────────────────┤
│  1503 文件   22207 符号   41556 边   787 社区   410 流程       │
│  能力：graph ✓  fts ✗(待修)  vector ✗                          │
├─ 语言分布 Languages ───────────────────────── [索引内 ▾] ───────┤
│  ████████████████████████████████▓▓▓▓▒▒▒░░░  ← 堆叠条          │
│  ● TypeScript 71.2%   ● Vue 12.4%   ● JavaScript 8.1%          │
│  ● Python 4.8%        ● Markdown 2.1%   ● YAML 0.9%            │
│  ● Shell 0.3%         ● 其他 0.2%                              │
│  实心=可解析进图 · 浅色=仅识别 · 灰=其他   未索引 4.1% ▸       │
│  ⚠ dist/app.min.js 4.2MB 单行 → 占 JS 的 89%，非源码          │
├─ 问题 Problems ──────────────────────────────── [巡检 ▾] ──────┤
│  ● clean · 枚举 complete · 0 循环 · 0 组件                     │
│  （若 enumeration=partial，此处必须显示"结果可能不完整"）        │
├─ 差量 Delta ──────────────────────────────────────────────────┤
│  M  src/mod1.ts        → Service1, f1            (3 符号受影响) │
│  M  src/mod2.ts        → Service2, f2                          │
│  A  src/mod121.ts      → Service121, f121                      │
│  [在图中高亮] [仅看受影响子图]                                  │
├─ 图 GraphCanvas（sigma，可折叠）───────────────────────────────┤
│  采样策略 + 焦点子图 + 变更节点描边高亮                          │
└───────────────────────────────────────────────────────────────┘
```

**语言分布（Languages）的设计要点**

先说一个查证结果，它决定了这一块必须自算：**GitNexus 的图里没有语言信息。**
`gitnexus/src/core/lbug/schema.ts` 的 36 张节点表**没有任何一列叫 `language`**（`File` 只有 `id/name/filePath/content`，见 `schema.ts:27-34`），`server/api.ts` 的图节点投影里也没有。
因此 `gitnexus-web/src/components/StatusBar.tsx:14-20` 那段"检测主语言"读的是 `n.properties.language`，**永远得到 null**——那是 GitNexus 自己的死代码；`components/HelpPanel.tsx:103` 的 Language 徽章也是注释掉的。
⇒ **GitNexus 的官方 UI 从来没有显示过语言分布**，这是真实空缺，不是重复造轮子。

数据来源（两级，成本都极低）：

| 范围 | 来源 | 成本 |
|---|---|---|
| **索引内**（默认） | `.gitnexus/gitnexus.json` 的 **`fileHashes` 键集合**就是被索引的文件清单（实测 `fileHashes` 条目数 **恰好等于** `stats.files`：data-screen 37/37，夹具 1503/1503） | **零额外 I/O**——Tier 0 本来就要读这个 JSON |
| **仓库全部**（可切换） | `git ls-tree -r -l HEAD` 一次命令拿到所有 blob 的字节数（实测 GitNexus 仓库 7024 条） | 一次 git 调用，不遍历文件系统，自动排除 `.gitignore` 的文件 |
| 每个文件的字节数 | 同上；若只用 `fileHashes` 则需逐文件 `fs.stat`（28k 文件时明显更慢，故优先 `git ls-tree`） | — |

语言判定**复用 GitNexus 自己的映射**，不要另造：`gitnexus-shared/src/language-detection.ts:87` 的 `getLanguageFromFilename()`，覆盖全部 18 个 `SupportedLanguages`（`languages.ts:7-27`）。它在包外可用（`gitnexus-web` 就是这么用的）。
注意该表**只覆盖 GitNexus 能解析的 18 种语言**；GitHub 截图里的 Shell / Jinja / PowerShell 都不在其中。所以还需要一张扩展表：文件里的 `AUXILIARY_SYNTAX_MAP`（`language-detection.ts:135-155`）已经给了 json / yaml / md / html / css / sh / sql / toml / dockerfile 等，再补 Shell / PowerShell / Jinja / Batch 等即可。

**三分法是这一块相对 GitHub 的增量价值**——不是复刻，而是回答一个 GitHub 答不了的问题"我的仓库里有多少代码是 GitNexus 真正理解的"：

| 视觉 | 含义 | 判据 |
|---|---|---|
| **实心** | 可解析进图——有 `LanguageProvider`，文件内的符号会进入知识图谱 | 命中 `EXTENSION_MAP` 的 18 种 |
| **浅色/斜纹** | 仅识别、未解析——只作为 File 节点（Markdown 还有 Section 节点）存在，**不产生符号** | 命中 `AUXILIARY_SYNTAX_MAP` |
| **灰** | 其他未识别 | 两者都不命中（如 `.txt`） |

**口径必须写在界面上，不能假装等同 GitHub。** GitHub 用 linguist：按**字节**、排除 vendored/generated/minified、尊重 `.gitattributes` 的 `linguist-*` 覆盖、并按"代码行"折算。我们的口径是"**索引内 / 已跟踪文件按扩展名聚合**"。两者会有差异，UI 上要标明口径（例如 hover 提示"按扩展名聚合的字节占比，非 GitHub linguist 口径"）。
可选增强（便宜且值得做）：读 `.gitattributes` 支持 `linguist-language` / `linguist-vendored` / `linguist-generated` / `linguist-detectable` 四个属性——它们在实践中很少出现，实现成本低。**不要**试图复刻 linguist 的全部启发式，那是个无底洞。

**其他渲染约定**（对齐 GitHub 的观感）：
- 堆叠条按百分比分段，**最小段设最小可见宽度**（否则 0.1% 会消失）；GitHub 也是这么处理的。
- 图例：色点 + 语言名 + 百分比；**百分比 < 0.5% 显示 `0%`**（与截图一致），但 tooltip 里给出真实值与文件数/字节数。
- 配色：内置一份 18 语言的稳定色映射（GitHub 的 linguist 官方色可直接抄），辅助语言给一组次级色，未命中的用路径哈希生成确定性色相——**保证同一语言在两次渲染间颜色不变**。
- 图例超过 8 项时折叠成"其他 N 项"，展开看全部。
- 点击某个语言 → 过滤 Delta 列表与图高亮到该语言的文件；这是把"画像"变成"导航"的一步，成本很低。

**为什么不需要新工具**：这一块是纯读 + 聚合，无副作用。归入 `gitnexus_status` 的返回即可；但因为它要支持范围切换与懒加载，**单独开一条路由更好**（见 §3.4）。聚合结果可按 `(indexedAt, HEAD, scope)` 三元组缓存。

**符号量分布（可选，第三档 scope）**：图里没有语言列，但可以反推——按 `filePath` 分组统计节点数（`MATCH (n) RETURN n.filePath, count(*)`），再在本地把 `filePath → 语言` 映射上去。这能揭示"文件占比"与"符号占比"不一致的情况（Vue SPA 可能 38% 的文件却占 60% 的符号）。代价是 28k 文件仓库会返回 28k 行，**默认关闭、点击才加载**，并在 UI 上标注这是估算。

**渲染与规模策略**（必须显式，因为 GitNexus 自己不采样）：

| 图规模 | 策略 |
|---|---|
| ≤ 5k 节点 | 全量渲染 + forceatlas2 |
| 5k–25k | 按度数/社区采样；社区聚合视图（`/api/clusters`） |
| > 25k | **默认不画全图**，改为：社区级聚合骨架 + 按需展开（点击社区 → `neighbors` 投影）；顶部提示"已聚合，点击展开" |

大图一律走 `POST /api/query` 的**服务端投影**（白名单模板），而不是 `/api/graph` 全量 NDJSON。

**差量高亮**：Tier 0 算出的 `Delta` 只有文件路径；符号级映射由 host 半用**已有索引**做一次廉价 Cypher 投影（`MATCH (n) WHERE n.filePath IN $paths RETURN n`），无需重建。

#### client 半的 API 访问

```ts
// src/client/api.ts —— 同源，去前导斜杠，绝不打 :4747
function routeBase(): string {
  const base = document.baseURI ?? ''
  const u = new URL(base === '' ? 'http://dsh.internal/' : base, 'http://dsh.internal/')
  u.search = ''; u.hash = ''
  if (!u.pathname.endsWith('/')) u.pathname += '/'
  return u.href
}
export const api = (path: string) => new URL(path.replace(/^\/+/, ''), routeBase()).href
```

#### 设置卡

同时注册到两个时代（用 `slots.inject` 守卫，不查版本号）：
- `plugins.row.config`，key = `` `${bundle}#${rowId}` ``（0.2.x，行 id 必须在自己的 patch 里声明）；
- `settings.plugin.item`，key = 插件命名空间（旧线兜底）。

设置项：`serverPort`、`bindHost`、`autoStartServer`、`cacheDir`、`watchDebounceMs`、`graphNodeBudget`、`sampleStrategy`、`autoRevalidateOnSessionStart`、`confirmBeforeFullRebuild`。

### 3.7 数据流总览

```
┌──────────────────────── DSH host 进程 ────────────────────────┐
│  dsh-gitnexus-plus (host 半, ESM)                              │
│                                                                │
│  tools ──►  update.ts ──► ctx.jobs ──► spawn gitnexus analyze  │
│              │                              │ (GITNEXUS_MEMORY=off│
│              │                              │  --skip-fts        │
│  delta.ts ◄──┘                              │  GITNEXUS_HOME=…   │
│    │ 读 .gitnexus/gitnexus.json             ▼                   │
│    │ 读 ~/.gitnexus/registry.json      .gitnexus/{lbug,…}       │
│    │                                   ▲                        │
│  serve.ts ──► spawn gitnexus serve ────┘ (127.0.0.1:4747)       │
│                │                                               │
│  routes/ ──────┴──► /api/gitnexus/*  同源代理 + loopback 守卫    │
└───────────────────────────┬────────────────────────────────────┘
                            │ 同源 fetch（页面 base 相对路径）
┌───────────────────────────▼────────────────────────────────────┐
│  浏览器 (DSH Web Client)                                        │
│  client 半 (lazy-CJS)                                           │
│    sidebarRightTabs.register({ kind:'gitnexus' })               │
│    slots.register('sidebar.right.pane.tab', IndexPanel)         │
│       ├─ FreshnessBar  ◄── /api/gitnexus/status                 │
│       ├─ DeltaList     ◄── /api/gitnexus/status?detail=1        │
│       └─ GraphCanvas   ◄── /api/gitnexus/graph (采样/投影)       │
└────────────────────────────────────────────────────────────────┘
```

---

### 3.8 两个边界问题：超大行文件与 LSP 诊断

#### 3.8.1 超大文件 / 超长行文件 —— 可行，而且**面板本来就该显示它**

GitNexus 已经有一整套机制，不需要插件发明什么：

| 机制 | 位置 | 细节 |
|---|---|---|
| 默认跳过阈值 | `gitnexus/src/core/ingestion/utils/max-file-size.ts:5` | `DEFAULT_MAX_FILE_SIZE_BYTES = 512 * 1024` |
| 环境变量覆盖 + **硬夹** | 同上 `:8, 37-43` | `GITNEXUS_MAX_FILE_SIZE`（KB）；超出 `TREE_SITTER_MAX_BUFFER` 即夹紧，而该上限 = **32 MB**（`cli/analyze-watch.ts:38` `MAX_FILE_SIZE_KB = 32 * 1024`） |
| walker 跳过并计数 | `core/ingestion/filesystem-walker.ts:142`，`:175-203` | 打印 `Skipped N large files (>512KB, likely generated/vendored)` 与 `Set GITNEXUS_MAX_FILE_SIZE=<KB> to include files above the default cap.` |
| generated 外观路径忽略 | `config/ignore-service.ts:121-125, 373-377` | `.generated`、`auto-generated`、`monaco-workers`、文件名含 `.generated.` |
| **CFG/PDG 显式跳过 minified 函数** | `core/ingestion/cfg/collect.ts:23, 34` | "always minified/generated code) is skipped rather than walked"；超 `maxFunctionLines` 标记 |
| 单行函数的连带代价 | `core/ingestion/cfg/reaching-defs.ts:156`、`cfg/emit.ts:49, 121, 522` | "a minified one-line function coalesces arbitrarily many statements"，有边数与阻塞上限 |
| 明确承认该场景 | `core/group/extractors/http-patterns/node.ts:392` | "A minified bundle is megabytes on one line and defines no …" |

**对面板的三点结论：**

1. **语言条必须显示"未索引"及其归因**，否则一个带 minified bundle 的仓库会显示 "JavaScript 40%"，而真实源码只占 5%。这正是上一节设计的"未索引 N%"段，现在有了具体分类：**超 `maxFileSizeBytes` / 命中忽略规则 / gitignore 未跟踪**。

2. **但归因数据不是现成的。** `indexCoverage` 只有两个字段（`storage/repo-meta.ts:392-395`）：
   ```ts
   indexCoverage?: { maxFileSizeBytes: number; dirtyPaths?: string[] }
   ```
   **没有跳过计数、没有跳过文件清单。** 插件必须自己算：`git ls-tree -r -l HEAD` 取全部已跟踪文件与字节 → 减去 `fileHashes` 键集合 → 按 `size > indexCoverage.maxFileSizeBytes` 归类。一次 git 命令，可接受。
   注意 `indexCoverage` 是**可选**的（"Absent on indexes written before this field"），缺失时要退化为只报"未索引"，不编造原因。

3. **不要建议用户乱调 `--max-file-size`。** 调到 32MB 上限等于拿索引时间和内存换覆盖率；这就是 `filesystem-walker.ts:199-203` 把该开关描述成需要操作者明确决定的原因。

**一个必须处理的 UI 失真**：按字节聚合时，**单个 minified bundle 会霸屏**。建议在语言条下方给出告警行（如上面面板示意里的 `⚠ dist/app.min.js 4.2MB 单行 → 占 JS 的 89%，非源码`）。
判据要便宜——不要为了算平均行长去读整个文件：
- 读**前 64KB** 数换行数，外推 `平均行长 ≈ size / 外推行数`；`> 500` 字符即判为疑似 minified；
- 叠加"字节数 > 256KB"与 generated 命名规则作为辅证。

#### 3.8.2 LSP 诊断监听 —— 经 DSH 的 LSP seam **不可行，且是官方有意推迟**

这是查证后的硬结论，不是能力不足：

| 证据 | 内容 |
|---|---|
| `docs/subsystems/lsp.md:19` | `type LspOperation = 'goToDefinition' \| 'findReferences' \| 'goToImplementation' \| 'hover'` —— **封闭联合**，注释明写 "A closed union: adding an operation is a compile-enforced change" |
| `docs/subsystems/lsp.md:116` | **"The seam exposes no protocol types, process/document controls, or generic JSON-RPC escape hatch."** |
| `docs/subsystems/lsp.md:109-112` | 结果类型同样是封闭的 `locations \| hover` ⇒ **连自定义 provider 也塞不进 diagnostics** |
| `packages/lsp/lsp/README.zh.md:129` | 官方点名：**"diagnostics 需要独立的新鲜度与累积规则"** —— 即**有意推迟**，不是遗漏 |

三条路的可行性对比：

| 方案 | 可行 | 代价 |
|---|---|---|
| 用 `ctx.lsp` 订阅诊断 | ❌ **不可行** | 联合封闭、无通知通道；`LspProvider.query()` 的返回类型里根本没有 diagnostics 的位置 |
| 自己 spawn 语言服务器走原始 JSON-RPC | ⚠️ 技术可行但**重** | 要自管进程池、文档同步（`didOpen`/`didChange`）、workspace 配置，并自行定义诊断的**新鲜度与累积规则**——正是官方推迟它的理由。Desktop 下还要过沙箱与载体 |
| **改用 `gitnexus check --json`** | ✅ **推荐** | 静态、与索引同源、已是 JSON |

`gitnexus check --cycles --json -r <repo>` 本机实测输出（data-screen，退出码 0）：

```json
{ "status": "clean", "enumeration": "complete", "cycleCount": 0, "componentCount": 0, "cycles": [] }
```

注意 **`enumeration` 字段（`complete`）是置信度信号，比结果本身更重要**——面板必须一起显示；为 `partial` 时要明确写"结果可能不完整"。

**但必须诚实标注定位**：`check` 目前**只有 `--cycles` 一个检查项**（`gitnexus check --help`），它检测的是**循环依赖**，**不是编译级诊断**——没有类型错误、未使用变量、签名不匹配。所以面板的区块名应是"**结构巡检**"而不是"诊断"，并在 UI 上写清"检查什么 / 不检查什么"。把它当 LSP diagnostics 的等价物是误导。

> **如果确实需要类型级诊断**：正确做法是**向上游推动 LSP diagnostics 成为 DSH 能力**（官方已留下推迟理由与方向），而不是在插件里自建一个语言服务器——那等于在插件里维护一个独立的诊断子系统，与"不做 GitNexus/DSH 已经或即将做的事"这条设计原则（§3.0）直接冲突。

---

## 4. 实施路线图

每阶段都有可验收的产物，且**前一阶段不依赖后一阶段**。

### 阶段 0 —— 骨架跑通（0.5 天）

产物：可安装、可在页面看到空面板的插件。
- `package.json` / `cordis.patch.yml` / tsconfig×2 / `scripts/build-client.mjs`
- host 半：`apply()` 里注册 1 个 `gitnexus_status` 工具 + 1 条 `/api/gitnexus/ping` 路由
- client 半：注册 `gitnexus` Tab 类型 + 空 `IndexPanel`
- 验收：`dsh plugin --profile web add <绝对路径>/gitnexus-plus` 成功；`dsh --profile web --dump-config | Select-String 'gitnexus-plus'` 出现该层；重启后 `/gitnexus` 能开出面板；工具在工具列表可见

### 阶段 1 —— 只读索引仪表盘（1.5–2 天）

产物：能看到索引状态、语言画像与结构巡检，**不触发任何分析**。
- `gitnexus/locate.ts` / `registry.ts` / `meta.ts`（含 **Windows 路径大小写规范化**）
- `gitnexus/languages.ts`：`fileHashes` → 语言聚合；`git ls-tree -r -l HEAD` → 字节数；三分法（可解析 / 仅识别 / 其他）
- `gitnexus/coverage.ts`：未索引归因（超 `indexCoverage.maxFileSizeBytes` / 命中忽略规则 / 未跟踪）+ **minified 单行文件告警**（读前 64KB 外推行长）
- `IndexPanel` 的 FreshnessBar + Metrics（stats / capabilities / indexedAt / lastCommit / 陈旧度）+ **Languages**（堆叠条 + 图例 + 口径说明）+ **Problems**（结构巡检，含 `enumeration` 置信度）
- 工具 `gitnexus_status`；路由 `GET /api/gitnexus/repos|status|languages|coverage|problems`
- 验收：对 `data-screen`(37 文件) 与 `material-ui`(93127 节点) 都能亚秒返回；陈旧度与 `gitnexus status --json` 一致
- 含**语言分布**：`data-screen` 实测应显示 Vue 14 / TypeScript 12 / JSON 5 / Markdown 2 / YAML 1 / SCSS 1 / HTML 1 / 其他 1（合计 37 = `stats.files`）；语言聚合耗时 < 100ms；百分比合计 100%

### 阶段 2 —— Tier 0 差量引擎（1–1.5 天）★ 最高性价比

产物：毫秒级"索引是否过期"判定 + 变更文件清单。
- `gitnexus/delta.ts`：`git status` 候选 → mtime 预筛 → sha256 比对 `fileHashes`
- `DeltaList` 组件；路由 `GET /api/gitnexus/status?detail=1`
- 工具 `gitnexus_delta`
- 验收：1500 文件夹具上，无变更场景 **< 200ms** 给出 "0 变更"；改动 5 个文件后准确列出 5 改 1 增；**不调用 analyzer**

### 阶段 3 —— 分层更新（1.5–2 天）★ 核心需求

产物：一条命令完成"该增量的增量、该全量的说明原因"。
- `gitnexus/update.ts`：Tier 1/2/3 决策 + 升级判据 + 沙箱环境注入 + `ctx.jobs` 后台化
- `serve.ts`：serve 子进程生命周期（127.0.0.1 绑定、健康探针、dispose 关闭）
- 路由 `POST /api/gitnexus/update`、`GET /api/gitnexus/jobs/:id[/stream]`
- 工具 `gitnexus_update` / `gitnexus_watch`
- 结构化结果（`tier`/`reason`/`writeMode`/`skipped`/`searchRefresh`）并回显到 UI
- 验收：1500 文件夹具上复现本方案基准——无变更走 Tier 0（无 analyzer）；6 文件变更走 Tier 2 且耗时 ≈23s；`--force` 走 Tier 3 且耗时 ≈19s；`dirty flag`/schema 变化能正确升级并说明原因

### 阶段 4 —— 搜索层增量（1 天）

产物：图重建之外的真正增量部分。
- `gitnexus/embeddings.ts`：只对变更符号补 embedding
- `--repair-fts` 单独修复 FTS
- 验收：改 1 个文件后，仅该文件的符号被重算向量；FTS 从 `unavailable` 变 `available`

### 阶段 5 —— 图可视化（2–3 天）

产物：可交互的图视图 + 差量高亮。
- `GraphCanvas`：sigma + graphology + forceatlas2
- 服务端投影白名单（`neighbors` / `community` / `process` / `clusters`），**不裸转发 Cypher**
- 采样/聚合策略（5k / 25k 分档）+ 节点预算设置
- 差量高亮：`Delta` 文件 → 符号投影 → 描边
- 验收：对 22207 节点的夹具交互流畅（≥30fps）；对 93127 节点的 material-ui 不卡死且显示聚合视图；变更节点有可见高亮

### 阶段 6 —— 体验收口（1 天）

- 设置卡（双时代注册）、斜杠命令 `/gitnexus`、`tool.call.toolview` 自定义卡片
- 逃生舱：「在 GitNexus 完整浏览器中打开」→ iframe `?server=…&repo=…`
- 错误态：CLI 未安装 / 未索引 / 索引在工作区外需提权 / serve 起不来
- 验收：四类错误都有可读提示与下一步动作；`/gitnexus` 命令出现在候选列表（注意 client 命令的 `description` **必须是函数**）

---

## 5. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **文档与实际运行时不齐**：本地 checkout 是 master 的 2026-09-08 快照，运行时是 0.2.0-rc.2 发行版 | 照抄任一方都可能写错 settings API / 槽名 / 安装路径 | 三源交叉：官方文档站（最新 master）+ 已安装包（`lib/*.js`、随包发布的 README）+ 已装第三方插件的真实代码；冲突时以已安装包为准。`peerDependencies` 钉死 `0.2.0-rc.2`；槽注册用 `slots.inject` 守卫而非版本判断 |
| **安装路径写错会直接失败**：Desktop profile 归 Electron 独占，公开 CLI 改不了它 | 阶段 0 卡死，或误改用户 profile 导致 profile 损坏 | 开发/联调一律走 `web` profile；交付走 Web「插件」页；**绝不**手改 `profiles/desktop/package.json`，**绝不**对 Desktop profile 跑系统 pnpm |
| **Desktop 的浏览器访问门**：非渲染进程一律 403 | 任何"用系统浏览器打开"的功能都不可用；用 curl 自测会全程 403，误判为路由没注册 | 只经渲染进程内的 client 半访问路由；自测用宿主内 `fetch` 或临时放宽，别用外部 HTTP 客户端下结论 |
| **`Config` 必须是 Schemastery schema**：官方要求导出同名 `Config` schema（Standard Schema 接口），导出普通对象会在加载时报错 | 插件加载即失败 | 默认值写在 schema 里（`.default()`）；凡"不同部署可能取不同值"的参数都必须做成配置字段，不能硬编码 |
| **增量收益被高估** | 用户预期落空；方案失信 | 明确承诺边界：Tier 0 是 3.5×，Tier 2 只有 ~0.79×；UI 显示真实档位与耗时；文档写明 scopeResolution/FTS 非增量 |
| **`serve` 无鉴权** | 本机任意进程可读全部代码图、可 `DELETE /api/repo` | 只绑 `127.0.0.1`；插件路由加 loopback+同源守卫；不裸转发 Cypher；不把端口暴露到 0.0.0.0 |
| **沙箱 EPERM** | 更新静默失败 | 显式注入 `GITNEXUS_MEMORY=off` / `--skip-fts` / `GITNEXUS_HOME`；索引在工作区外时走**一次**可解释的 `danger-full-access` 升级 |
| **大图卡死** | 面板冻结，用户体验崩塌 | 显式节点预算 + 分档采样 + 超限默认聚合视图；一律走服务端投影而非全量 NDJSON |
| **`--watch` 与手动更新打架** | 锁争用、重复重建 | watch 与手动更新**互斥**（UI 上一个开关）；依赖 GitNexus 自身的 `WatchRefreshQueue` 与 `acquireIndexLock`，插件不重复加锁 |
| **`config` 整体覆盖语义** | 补丁把别的键悄悄清空 | `cordis.patch.yml` 写全所有键；`scripts/check-artifacts.mjs` 断言键集合（参考 `dsh-bash-terminal-ts` 的做法） |
| **Windows 路径大小写不一** | 同一仓库被识别成两个 | 读 registry 时统一规范化（`D:\Project` vs `D:\project` 实测存在） |
| **`analyze --index-only` 之外误改用户仓库** | 污染 `AGENTS.md`/`CLAUDE.md`/skills | 默认永远带 `--index-only`；把"生成 AI 上下文文件"做成显式可选项 |
| **client 半 bundle 打包错** | 客户端整半加载失败 | 严格照 `build-client.mjs`：`format:'cjs'` + `__ModuleLoader__.load` 包装 + 9 项基线 external；**不要 bundle react/@deepseek-ai** |
| **HMR 期望错位** | 改了看不到效果，浪费调试时间 | 文档写明：bundle 集合变更**必须重启**；`patchReload: live` 只监听配置文件 |

---

## 6. 验收清单

```powershell
# 1) 开发期：挂到 web profile（公开 CLI 可管理），--patch overlay 免安装
pnpm dsh web --patch ./gitnexus-plus/cordis.patch.yml      # 官方教程回路，http://127.0.0.1:3080

# 2) 联调期：装进 web profile，验证层进配置树
dsh plugin --profile web add 'D:\Project\gitnexus-plus'
dsh --profile web --dump-config | Select-String 'gitnexus-plus'

# 3) 交付期：Desktop profile 由 Electron 独占 —— 用 Web 侧边栏「插件」页安装
#    切勿：dsh plugin --profile desktop add ...（CLI 不能管理该 profile）
#    切勿：手改 ~/.dsh/profiles/desktop/package.json 或对 Desktop profile 跑系统 pnpm
#    若插件带依赖构建脚本，插件页会提示「允许这些脚本并重试」

# 4) 工具可见、状态可读（不触发分析）
#    在会话里调用 gitnexus_status repo=D:\project\data-screen
#    期望：亚秒返回，字段与下面命令一致
gitnexus status --json -r data-screen

# 4b) 语言分布正确且便宜（对照真实索引内容核验）
#     索引内语言清单必须与 fileHashes 的键集合一致（条目数 == stats.files）
$j = Get-Content 'D:\project\data-screen\.gitnexus\gitnexus.json' -Raw | ConvertFrom-Json
$j.fileHashes.PSObject.Properties.Name.Count    # 37，应等于 $j.stats.files
#     期望面板显示：Vue 14 / TypeScript 12 / JSON 5 / Markdown 2 / YAML 1 / SCSS 1 / HTML 1 / 其他 1
#     期望：聚合 < 100ms；切到"仓库全部"时用 git ls-tree -r -l HEAD 且能显示"未索引"差额

# 5) Tier 0 是毫秒级且不跑 analyzer
#    调用 gitnexus_delta repo=<1500 文件夹具>
#    期望：< 200ms 返回 0 变更；期间进程列表无 node analyze

# 6) 分层更新可复现本方案基准
#    改 5 文件 + 增 1 文件后调用 gitnexus_update
#    期望：tier=2, durationMs ≈ 23000, changedFiles=6, skipped=["fts"]
#    mode='full' 时期望：tier=3, durationMs ≈ 19000, reason 明确

# 7) 面板可用
#    在右侧栏打开 /gitnexus；对 material-ui(93127 节点) 不卡死，显示聚合视图
```

**性能预算**

| 指标 | 目标 |
|---|---|
| Tier 0 复验（无变更） | < 200 ms |
| Tier 0 复验（100 文件变更） | < 1.5 s |
| 面板首屏（≤5k 节点仓库） | < 1 s |
| 图交互（≤25k 节点） | ≥ 30 fps |
| 大图（>25k 节点） | 默认聚合，展开单社区 < 500 ms |

---

## 附录 A：关键证据索引

| 结论 | 证据 |
|---|---|
| `analyze` 默认增量 | `gitnexus/src/core/run-analyze.ts:3067-3082`；`gitnexus/src/cli/index.ts:74-85` |
| 复用单元四层 | `storage/file-hash.ts:93-118`、`storage/parse-cache.ts:896,872,908-948`、`storage/parsedfile-store.ts:41-48`、`core/incremental/subgraph-extract.ts:145,194` |
| 重建原因 19 键 | `core/rebuild-reasons.ts:17-37` |
| 写计划升级阈值 | `core/incremental/escalation-gate.ts:50-56` |
| scopeResolution/FTS 非增量 | `gitnexus/bench/analyze-phase-breakdown.md:58-95,216-238` |
| watch 队列语义 | `cli/analyze-watch.ts:327-349`、`cli/watch-queue.ts:16-184` |
| 索引锁 fail-closed | `storage/index-lock.ts:905`、`core/run-analyze.ts:1415` |
| serve 默认端口/主机 | `gitnexus/src/cli/serve.ts:29-33` |
| **serve 无鉴权** | `gitnexus/src/server/middleware.ts:228-230` |
| 路由表 | `gitnexus/src/server/api.ts:1197–2479` |
| `/api/graph` NDJSON | `gitnexus/src/server/api.ts:558-605` |
| 图数据形状 | `gitnexus-shared/src/graph/types.ts:281-339` |
| 25k/50k 上限 | `gitnexus-web/src/config/ui-constants.ts:41,50`、`lib/graph-load-decision.ts:45-54` |
| `__GITNEXUS_CONFIG__` 仅 docker 注入 | `docker-server.mjs:83-89` vs `hooks/useBackend.ts:35-41` |
| 36 标签 / 33 关系 | `gitnexus-shared/src/lbug/schema-constants.ts:11-49,55-96` |
| DSH 变体字段类型 | `deepseek-harness/packages/util/package-manifest/src/types.ts:7-57`（0.1.3 参考） |
| 补丁算法 | `deepseek-harness/vendor/include/src/index.ts:58-128` |
| `config` 不深合并 | `deepseek-harness/docs/user/develop/basic/publish.md:114-126` |
| client bundle 包装 | `dsh-bash-terminal-ts/scripts/build-client.mjs` |
| **sidebar-right 注册 API（0.2.0-rc.2）** | `…/dsh-client-ui-sidebar-right/lib/client.js:8690,8782,8812,6394` |
| 槽分级树 | `deepseek-harness/docs/subsystems/slots.md:110-168` |
| client 半 URL 解析规则 | `dsh-bash-terminal-ts/src/webterminals/browser/url.ts:1-70` |
| **图里没有语言信息** | `gitnexus/src/core/lbug/schema.ts:27-34`（`File` 仅 `id/name/filePath/content`）；全 schema 无 `language` 列；`server/api.ts` 节点投影亦无 |
| **GitNexus 自己的语言显示是死代码** | `gitnexus-web/src/components/StatusBar.tsx:14-20` 读 `n.properties.language`（永不存在的列）；`components/HelpPanel.tsx:103` 的 Language 徽章被注释掉 |
| **可复用的语言映射** | `gitnexus-shared/src/language-detection.ts:87` `getLanguageFromFilename()`；18 种语言 `languages.ts:7-27`；辅助表 `language-detection.ts:135-155` |
| **大文件 / 长行处理** | `core/ingestion/utils/max-file-size.ts:5,8,37-43`（默认 512KB、硬上限 = `TREE_SITTER_MAX_BUFFER`）；`cli/analyze-watch.ts:38`（32MB）；`core/ingestion/filesystem-walker.ts:142,175-203`（跳过+计数+提示）；`config/ignore-service.ts:121-125,373-377`；`core/ingestion/cfg/collect.ts:23,34`（CFG 跳过 minified 函数）；`core/group/extractors/http-patterns/node.ts:392` |
| **`indexCoverage` 只有两个字段** | `storage/repo-meta.ts:392-395` ⇒ **无跳过计数**，未索引归因必须插件自算 |
| **`gitnexus check` 面** | `gitnexus check --help`（仅 `--cycles` / `--json` / `-r` / `--branch`）；实测输出 `{status, enumeration, cycleCount, componentCount, cycles}` |
| **DSH LSP 只有四个只读操作、无 diagnostics** | `docs/subsystems/lsp.md:19,109-112,116`；**官方点名推迟**：`packages/lsp/lsp/README.zh.md:129` |
| **索引文件清单来源** | `.gitnexus/gitnexus.json` 的 `fileHashes` 键集合（实测条目数 == `stats.files`：data-screen 37/37、夹具 1503/1503） |
| 第三方路由默认无鉴权 | 官方文档 `reference/subsystems/web-server.md:47`；`dsh-free-search/lib/index.js:2945-2955` |
| **Desktop 提供 webServer 并加访问门** | `…\DSH Desktop\resources\app\lib\webserver.js`（`DesktopWebServer extends WebServer`、`host !== '127.0.0.1'` 抛错）、`lib\desktop-browser-access-*.js`（`decideDesktopBrowserAccess`、`x-dsh-desktop-renderer`、403） |
| **Desktop profile 归 Electron 独占，CLI 不可管理** | 官方架构文档"桌面应用"节；`apps/desktop/README.zh.md:15,24,26,50`（本地快照版亦已含此约束） |
| **插件安装契约（含绝对路径）** | 已安装 `@deepseek-ai/dsh-plugin-manager\README.zh.md:46,48,58,63`（0.2.0-rc.2，随包发布，权威） |
| **Config 必须是 Schemastery schema** | 官方文档站 `develop/basic/config.md` |
| **`defineTool` 形状** | 官方文档站 `develop/basic/tool.md`（与本方案 §2.4 一致，已核对） |
| 能力三角色（Definition / Provider / Consumer） | 官方文档站 `develop/practice/index.md`；`reference/capability-seams`（"不要预防性拆分"——本插件单包即可） |
| `dsh plugin` 安装面 | 本机 `dsh --help`（0.2.0-rc.2） |

**本方案作者实测数据**

*增量基准*（1500 文件夹具 / 1503 files·22207 nodes·41556 edges）：
冷启动 29.57s · 无变更重跑 8.42s · 小改动增量 23.31s · `--force` 19.04s · `--no-parse-cache` 29.69s。
沙箱解法组合（`NODE_OPTIONS` + `GITNEXUS_MEMORY=off` + `--skip-fts` + `GITNEXUS_HOME` 重定向）经三次失败后验证通过，退出码 0。

*Desktop HTTP 门*（对 `http://127.0.0.1:43120` 发起）：`GET /` → 403、`GET /api/health` → 403、`GET /api/dsh-free-search-settings` → 403（均为 forbidden，非 404）。

*Desktop profile 不可由 CLI 管理*：`dsh --profile desktop --dump-config` → `EPERM … open 'C:\Users\massnote\.dsh\profiles\desktop\cordis.yml'`（`prepareProfile` 即便在 dump 路径上也会写文件）。

*语言分布两路数据源*：
`git ls-tree -r -l HEAD` 在 GitNexus 仓库返回 **7024** 条 blob（含字节数），单次命令、无需遍历文件系统；
`data-screen` 的 `fileHashes` 聚合得 Vue 14 / TypeScript 12 / JSON 5 / Markdown 2 / YAML 1 / SCSS 1 / TXT 1 / HTML 1，合计 **37 == `stats.files`**。

---

## 附录 B：下一步

本文件是**构建方案**。如果认可这个方向，建议的执行顺序是：

1. **先做阶段 0 + 阶段 1 + 阶段 2**（约 3 天）——它们不依赖图渲染，能立刻交付"看得见索引 + 毫秒级知道过期没"的价值，且风险最低。
2. 阶段 3 是核心需求所在，建议在阶段 2 的差量引擎被实测验证后再动。
3. 阶段 5（图可视化）工作量最大且价值最不确定，建议放到最后，并先确认对 material-ui 这类 9 万节点仓库的真实体验。

三份深度分析报告可作为实施期的参考：
- `research/gitnexus-incremental.md`（72 KB）——增量机制、缓存、锁、驱动契约
- `research/gitnexus-visualize-api.md`（53 KB）——路由表、图模式、渲染栈、可嵌入面
- `research/dsh-plugin-contract.md`（153 KB）——DSH 插件契约全量、9 行矛盾账本、可复制骨架
