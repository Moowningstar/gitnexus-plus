# dsh-gitnexus-plus

[English](README.md) · **简体中文**

**当前版本：0.1.5** · [npm](https://www.npmjs.com/package/dsh-gitnexus-plus) ·
[问题反馈](https://github.com/Moowningstar/gitnexus-plus/issues)

[插件做什么](#插件做什么) · [安装](#安装) · [遇到问题怎么解决](#遇到问题怎么解决) ·
[上游 GitNexus 文档](#上游-gitnexus-文档路径)

一个 DeepSeek Harness 插件：查看 GitNexus 索引**覆盖了什么、漏掉了什么**，判断这次刷新值不值得跑，
看图，在右侧栏刷新索引，并按关键词搜索图里的符号。

它不 fork GitNexus、不重写解析器、不打包或再分发 GitNexus。`gitnexus` 是 **peer**，需要你自己提供。

## 插件做什么

- **刷新门禁（Tier 0）**：在给出刷新按钮之前，用工作区文件与索引记录的 sha256（`.gitnexus/gitnexus.json` 的 `fileHashes`）比对，报告真正变化的内容：改 / 增 / 删，以及被索引策略排除的文件。工作区没变时毫秒级给出结论、**不启动分析器**，按钮直接说明"无需刷新"，而不是让你等一次几分钟的重建。只有比对**锚定在索引记录的提交**上时才会说"已是最新"；索引没记录提交时会退化为工作区与 `HEAD` 比较，并明确说"无法确认"，而不是冒充新鲜。
- **图视图**：把索引里的社区画在 canvas 上，跨社区关系按权重聚合；点社区看成员符号及它们之间的关系，点符号在文件查看器里定位到行。节点与边预算由宿主限制，并明确写出省略了多少。社区之外的符号可用**符号视图**切换查看：它是按文件顺序截断的全仓库符号投影，结构全貌仍看社区视图。卡片总览是 **3D**：同一批社区放到 Z 轴、按社区着色、标注代表文件，并支持最短路径高亮；双击社区进入成员符号；**展开**是居中弹窗而不是全屏。卡片滚动到视口附近才发起图请求。
- **刷新建议**：陈旧度判断同时给出 `无需刷新` / `增量刷新` / `重新分析` / `全量重建` / `初始化索引` / `无法判断`。没有提交基线时不会把“工作区没改”说成可增量刷新；`--skip-git` 索引会明确建议重新分析。
- **索引覆盖**：列出被 `gitnexus analyze` 跳过的超大文件，给出大小、语言占比，以及生成物/压缩文件的判断信号。
- **索引新鲜度**：索引提交与 `HEAD` 对比，分为 `current` / `behind` / `diverged` / `unknown`，并给出未提交变更数。
- **版本一致性**：把索引记录的 `runnerIdentity.cliVersion` 与当前 CLI 对比；不一致时给出警告，而不是默认索引与查询路径一致。
- **图构成**：节点、边、社区、流程、embedding、边/节点比。
- **Git 活跃度 × 索引**：最近提交、作者、分支、改动最多的文件，每个文件给出 **已索引 / 设计上排除 / 索引缺失** 三方判断；另有活动 × 索引交叉表、相对索引提交的基线审查（索引未记录提交时用活动窗口起点并明确标注）、7/14/30 天提交时间线，以及点击文件行查看该文件自己的时间线。
- **语言分布**：按字节拆分“能解析进图的语言 / 只识别格式的语言 / 其他”；GitNexus 不在时用内置扩展名映射，并标为 `builtin`，不冒充已解析。
- **关键词搜索**：按图节点的 `name` / `filePath` 匹配，返回 kind、path、line；点击结果打开文件并定位到行，右侧“复制”按钮复制 `path:line`。
- **源码回退**：图查询子进程起不来时（无可用 shell 沙箱、DLL/ABI、索引忙），在索引清单内的文件里做有界源码行匹配，结果标为 `mode: "text"`。
- **工作区多项目与切换器**：工作区本身可以是容器（例如 `D:\Project` 下放着 `gitnexus-plus/`、`viewer/`，或 `geo/` 下放着 `frontend/`、`backend/`）。面板会从当前工作区**向下**收集工作区自身、已索引项目，以及尚未建索引的 git 仓库；默认选一个，标题栏显示项目数并可切换；选择按工作区记住。未索引的 git 项目也会列出来，选中后可以针对该目录初始化。
- **无索引也有信息**：git 项目或普通文件夹尚未建索引时，显示扫描概览、语言分布和初始化命令，而不是空白面板。普通文件夹的索引由 `--skip-git` 建立。
- **维护**：初始化、增量刷新、全量重建（`--force`）都通过 DSH 的 shell 执行器运行，不自行请求提权。索引报告 FTS 不可用时，面板另外提供 **修复搜索索引（FTS）**，只跑 `analyze --repair-fts`，不重跑分析。

## 安装

前置：

- DSH `>=0.2.0-rc.2 <0.3.0`
- Node `>=22`
- GitNexus `>=1.6.0 <2.0.0`（peer，不随本插件安装）

```sh
dsh plugin add dsh-gitnexus-plus
```

添加后重启 DSH。面板是右侧栏的 tab：点侧栏 **+** → 指南页 → **GitNexus 索引**。

`desktop` profile 由 Electron 管理，CLI 不能改；在 Web 侧栏的 Plugins 页面添加。从本地 checkout 安装：

```sh
dsh plugin --profile web add <本包绝对路径>
```

GitNexus 可以自己装，也可以让面板装。自定义位置：

```sh
GITNEXUS_CLI=/path/to/gitnexus/dist/cli/index.js
```

### 获取 GitNexus

推荐自己安装：

```sh
npm install -g gitnexus
```

也可以让面板装；它通过 DSH 的 shell 执行：

```sh
npm install --prefix <DSH_HOME>/gitnexus-plus/gitnexus gitnexus@^1.6.12
```

会下载约 500 MB–1 GB，需要 C++ 工具链，且不硬编码 registry。第一次装请按未验证对待；失败就用上面的手动命令。

## 使用

面板会报告当前工作区指向的项目，不提供全局仓库列表。它会从工作区开始**向下**收集：工作区自身、子目录里的 `.gitnexus` 索引，以及还没有索引的 git 仓库；遇到已索引或带 `.git` 的目录就把它当项目边界，不再向下钻。候选多于一个时，标题栏的路径位置变成切换器，下方写明“工作区 … · N 个项目（X 个已索引）· 当前 <路径>”；未索引项目会标注“未索引”。切换后刷新、差量、搜索、图查询、维护命令都针对新项目，选择按工作区持久化。默认选择顺序是：上次选择 → 工作区自身索引 → 第一个已索引项目 → 工作区扫描。没有已索引项目时停在“本工作区”扫描，并列出未索引的 git 项目供初始化。目录必须存在、且不是文件系统根目录；没有 `.git` 的普通文件夹照样能扫描，并可用 `--skip-git` 建索引（没有提交基线，也没有增量刷新）。路由不提供浏览/列举其它路径的接口。

DSH 内暴露：

- 工具 `gitnexus_coverage`：`{ repo, includeLanguages? }`
- 工具 `gitnexus_delta`：`{ repo }` —— 这次刷新会不会改变索引
- 路由 `GET /api/gitnexus/projects?root=<workspace>`：列出工作区下的项目（已索引与未索引 git）
- 路由 `GET /api/gitnexus/coverage?repo=<project>`
- 路由 `GET /api/gitnexus/search?repo=<project>&q=<keyword>&limit=20`
- 路由 `GET /api/gitnexus/file-history?repo=<project>&path=<file>&days=7`：单个文件的
  有界提交时间线
- 路由 `GET /api/gitnexus/delta?repo=<project>`：Tier 0 差量判断
- 路由 `GET /api/gitnexus/graph?repo=<project>&view=communities|community&id=<community>`：
  有界图投影
- 路由 `POST/GET/DELETE /api/gitnexus/analyze`（唯一会改动索引的入口；`force=1` 全量重建，
  `mode=repair-fts` 只修搜索索引）
- 右侧栏 tab `gitnexus`

CLI：

```sh
npm run build
node lib/bin/gitnexus-coverage.js <repo-path>
node lib/bin/gitnexus-coverage.js -r material-ui        # 按注册表别名
node lib/bin/gitnexus-coverage.js --all --json          # 所有已索引仓库
node lib/bin/gitnexus-coverage.js <repo> --fail-on-large # CI 门禁，exit 2
npm run check
npm test
```

搜索分为两种模式：

- **graph**：正常情况。宿主不直接加载原生 `lbug`，而是启动 `lib/bin/search-helper.js`（系统 Node），查节点名和文件路径；不搜正文，所以 `--skip-fts` 的索引也能用。
- **text**：图查询起不来时的回退。只读索引清单里的文件，按行匹配，代码文件优先，文件数/字节数/匹配数都有上限；面板标题会显示“源码关键词（回退）”。

点击结果行会用 `ctx.sidebarRight.openResourceIn(sessionId, address, { params: { line } })` 打开平台文件查看器并定位行；没有该服务时退回复制路径。

## 遇到问题怎么解决

先看面板自己报的状态：`GitNexus 不存在`、`没有索引`、`索引过期`、`FTS 不可用`。下面的表只处理插件边界内的事，其余指向上游 GitNexus 的文档路径。

| 现象 | 这里怎么做 | 上游 GitNexus 路径 |
| --- | --- | --- |
| 面板说 GitNexus 不存在 | 自己安装，或用面板的安装按钮；非标准位置设 `GITNEXUS_CLI=/path/to/gitnexus/dist/cli/index.js`。 | [`gitnexus/README.md` — Requirements](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#requirements)、[Quick Start](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#quick-start) |
| 项目还没有索引 | 点 **初始化索引**，或执行 `gitnexus analyze --index-only <repo>`。目录不是 git 仓库时，面板的命令会自动带 `--skip-git`（上游要求），代价是没有提交基线与增量刷新。 | [`README.md` — CLI Reference](https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md#cli-reference)、[`RUNBOOK.md` — Index out of date](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#index-out-of-date--stale-tools) |
| 子目录里已有索引，切换器里却没有 | 面板只从当前工作区**向下**找，不会向上或找兄弟目录；默认跳过隐藏目录、`node_modules` 与构建产物，且有层数/目录数/时间上限。确认索引位于 `<工作区>/<子目录>/.gitnexus/gitnexus.json`；若它在被跳过的目录或很深的层级，直接把工作区设到该子目录。多个项目会在标题栏切换器里列出，未建索引的 git 项目也会列出；搜索被截断时面板会写明“可能还有未列出的项目”。 | 本插件的目录发现；无上游 GitNexus 路径。 |
| 刷新失败、`spawn EPERM`，或索引停在 `incremental-in-progress` | 面板命令已带 `GITNEXUS_MEMORY=off`、`NODE_OPTIONS=--max-old-space-size=8192`、`GITNEXUS_HOME=<repo>/.gitnexus/plugin-home`、`--index-only`。沙箱仍拒绝时，把命令复制到自己的终端跑；插件不会扩权。 | [`RUNBOOK.md` — LadybugDB / lock errors](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#ladybugdb--lock-errors)、[Memory / analyze crashes](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#memory--analyze-crashes) |
| 刷新报 `EPERM … mkdir` 或 `rmdir '<repo>\.gitnexus\parsedfile-store'` | GitNexus 在每次解析开始时**删除**这个 run 级存储，解析过程中再由 worker 重新创建——两个方向都可能被拒。0.1.4 处理了两个成因：不再预建该目录（那是 0.1.3 的 `rmdir` 来源）；同时让分析器的 shell 调用带上**仓库**作为沙箱工作区根。面板路由没有 session，沙箱以前会回退到 DSH 应用目录，那条路径的写能力是**另一个身份**，仓库的写授权对它无效，于是 `.gitnexus` 里的写入全被拒。若仍失败，说明部署模式是只读——把复制出的命令放到普通终端执行。 | [`RUNBOOK.md` — LadybugDB / lock errors](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#ladybugdb--lock-errors)、[`RUNBOOK.md` — Clean slate](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#clean-slate-corrupt-or-huge-gitnexus) |
| Windows 报 `windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\Program Files\DSH Desktop)` | 这是 DSH 的 Windows ACL 沙箱在给**工作区根**授权时失败；`D:\Program Files\DSH Desktop` 是 DSH 应用目录，不是项目。0.1.5 起搜索/图子进程使用 `<repo>/.gitnexus` 作为策略根，安装使用插件前缀作为策略根，安装失败会返回可复制命令。如果**普通 shell 命令**仍报同一错误，说明会话工作区本身就是安装目录：把工作区切到可写项目；不要给 Program Files 加 ACL。 | 本插件的策略根修复；DSH 沙箱本身无上游 GitNexus 路径。 |
| 增量分析卡住，或数据库报 `Maximum database size … has been reached` | 用 **全量重建**（`--force`），或按 clean slate 清理后重建。 | [`RUNBOOK.md` — Clean slate](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#clean-slate-corrupt-or-huge-gitnexus)、[`gitnexus/README.md` — Troubleshooting](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#troubleshooting) |
| 刷新报 `EPERM … open '<repo>\.gitnexus\lbug.init.lock'` 或 `unable to acquire init lock` | 这是瞬时的文件锁，不是权限问题：报出该错误的机器上做过权限体检，`.gitnexus` 的权限是健康的。GitNexus 的第一个写操作就是这把锁，杀毒、索引器或上一次崩溃都可能持有它。插件会清掉残留锁并自动重试一次（运行状态里 `attempts: 2`）。仍失败就等一会儿再刷新，或把复制出的命令放到普通终端执行。 | 本插件的重试 + 分析器自己的锁文件；无上游 GitNexus 路径。 |
| 搜索报 `A dynamic link library (DLL) initialization routine failed` / `lbugjs.node` | 图查询在 `lib/bin/search-helper.js` 里跑，不在 Electron 宿主里加载原生模块；升级后重启 DSH，并确保 shell PATH 上有 `node`。helper 起不来时会回退源码。 | [`gitnexus/README.md` — Troubleshooting](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#troubleshooting) |
| Windows 上搜索命中很少，或面板提示 FTS 不可用 | 索引是 `--skip-fts` 建的，或 FTS 扩展加载不了。关键词搜索仍按名称/路径匹配，源码回退按行匹配。此时面板提供 **修复搜索索引（FTS）**，只跑 `analyze --repair-fts`，不动图。它仍可能失败，面板会区分两种原因：修复需要在**子进程**里安装/加载扩展，受限 shell 会拒绝（`spawn EPERM` → 把命令复制到终端跑）；或扩展文件存在但加载不了，那是 Windows 缺少原生运行时（VC++ 2015-2022 x64 与 OpenSSL 3），不是索引坏了。 | [`gitnexus/README.md` — Windows: full-text search unavailable](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#windows-full-text-search-unavailable)、[Analyze warns about unavailable FTS](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#analyze-warns-about-unavailable-fts-or-vector-extensions) |
| 刷新按钮显示“无需刷新”且不可点 | 这是 Tier 0 的判断，不是故障：索引记录的文件内容哈希全部没变，再跑分析器也不会改变索引。**仍然刷新** 可以强制跑一次（例如 GitNexus 升级或 schema 变化后）。如果索引没有记录提交基线，面板**不会**说“无需刷新”，而是显示“无法确认”并保持按钮可用。 | 本插件的差量引擎；无上游 GitNexus 路径。 |
| 门禁显示“无法确认”，而不是“无需刷新” | 索引没有记录提交，所以只能比较工作区。受限沙箱里的 analyze 起不了 `git` 子进程，manifest 的 `lastCommit` 因此为空——本机实测：同一条命令在普通终端会写入提交，在沙箱里留空。想要更强的结论，把复制出的命令在沙箱外跑一次；无论哪种状态，刷新按钮都可用。 | 本插件差量引擎 + 分析器的 git 访问；无上游 GitNexus 路径。 |
| 图视图空白，或报 404 | 404 说明宿主还没有 `/api/gitnexus/graph` 路由，重启 DSH，而不是只刷新页面。空白画布但下面有说明，通常是索引还没有社区（旧索引）或索引忙：刷新索引即可。节点数按预算截断，卡片会写明省略了多少。 | 本插件宿主路由；图数据本身来自 GitNexus 索引。 |
| 图视图对某些项目一直加载或 504，另一些正常 | Windows ACL 沙箱第一次给 workspace 授权时会把可继承 ACE 传播到整棵仓库树，大仓库可能超过 25 秒 helper 超时；已授权过的项目则很快。0.1.5 起搜索/图 helper 的 workspace 根收窄到 `<repo>/.gitnexus`，只覆盖索引目录；重启 DSH 后生效。仍失败时确认 `.gitnexus/lbug` 存在，并检查是否有另一个 analyze 正占用该索引。 | 本插件的 sandbox 策略根；图数据本身来自 GitNexus 索引。 |
| 点击搜索结果没有打开文件 | 点击依赖 `ctx.sidebarRight.openResourceIn`；没有该服务的 profile 会退回复制 `path:line`。重启 DSH；仍不行就用“复制”。 | 面板/DSH 边界，无上游 GitNexus 路径。 |
| 文件时间线报 404/401 | 客户端先热更新了，宿主还没加载 `/api/gitnexus/file-history` 路由。重启 DSH，不是只刷新页面。 | 本插件宿主路由；无上游 GitNexus 路径。 |
| 分析内存不足 | 保留面板的 `NODE_OPTIONS` / `GITNEXUS_MEMORY`，或手动提高 heap；必要时全量重建。 | [`gitnexus/README.md` — Analysis runs out of memory](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#analysis-runs-out-of-memory)、[`RUNBOOK.md` — Memory / analyze crashes](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#memory--analyze-crashes) |
| 大文件没有进图 | 这正是面板要报告的：大小/占比、生成物/压缩判断、二进制检测。提高 cap 是上游 analyze 的选项，本插件只报告被跳过的事实。 | [`gitnexus/README.md` — Large files are being skipped](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#large-files-are-being-skipped) |
| 原生依赖安装失败（`@ladybugdb/core`、`tree-sitter-*`） | 插件用 `npm install --prefix …`；需要 C++ 工具链和可达的 registry。按 **获取 GitNexus** 里的手动命令跑一遍，看到编译器报错再处理。 | [`gitnexus/README.md` — Installation fails with native module errors](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#installation-fails-with-native-module-errors) |
| 面板根本不出现 | 确认 `dsh plugin add` 成功、已重启 DSH；从右侧栏 **+** 的指南页打开。`desktop` profile 用 Web 的 Plugins 页面。 | 本插件安装问题，无上游 GitNexus 路径。 |

## 上游 GitNexus 文档路径

这个 README 描述的是本插件；GitNexus 自己的行为以源码文档为准。
仓库：[`abhigyanpatwari/GitNexus`](https://github.com/abhigyanpatwari/GitNexus)（`main` 分支）。

| 主题 | 路径 |
| --- | --- |
| 安装、CLI、环境变量、MCP | [`README.md`](https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md) |
| CLI 包、Requirements、完整 Troubleshooting | [`gitnexus/README.md`](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md) |
| 索引过期、clean slate、锁、内存 | [`RUNBOOK.md`](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md) |
| 架构与数据流 | [`ARCHITECTURE.md`](https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md) |
| 测试与 guardrails | [`TESTING.md`](https://github.com/abhigyanpatwari/GitNexus/blob/main/TESTING.md)、[`GUARDRAILS.md`](https://github.com/abhigyanpatwari/GitNexus/blob/main/GUARDRAILS.md) |
| CLI 命令参考 | [`gitnexus/skills/gitnexus-cli.md`](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/skills/gitnexus-cli.md) |
| 语言相关说明 | [`docs/languages/`](https://github.com/abhigyanpatwari/GitNexus/tree/main/docs/languages) |

本地 `.docs/` 只是工作笔记，已被 gitignore；上面的链接才是对外可用的源文档。

## 维护命令

面板展示并执行的命令不是裸 `gitnexus analyze`：

```powershell
$env:GITNEXUS_MEMORY='off'; $env:NODE_OPTIONS='--max-old-space-size=8192'; `
  $env:GITNEXUS_HOME='<repo>/.gitnexus/plugin-home'; `
  gitnexus analyze --index-only '<repo>'
```

全量重建再加 `--force`；只修搜索索引用 `--repair-fts`（面板在索引报告 FTS 不可用时提供
**修复搜索索引（FTS）**，不会重跑分析）。目录没有 `.git` 时，命令还会带 `--skip-git`。

- `--skip-git`：GitNexus 默认拒绝没有 `.git` 的目录（即使路径是显式传入的）；这个标记让它直接索引该目录。代价是索引没有提交基线、没有增量刷新，也没有 Git 活动，面板会如实说明。

- `GITNEXUS_MEMORY=off`：阻止 CLI 通过管道重新 spawn 自己（受限沙箱会 `spawn EPERM`）。
- `NODE_OPTIONS=--max-old-space-size=8192`：补上它本来想通过 respawn 拿到的 heap。
- `GITNEXUS_HOME`：把全局 registry 写回项目内，避免写 `~/.gitnexus` 失败后索引卡在 `incremental-in-progress`。
- `--index-only`：否则 `analyze` 会改写仓库里的 `AGENTS.md`、`CLAUDE.md` 和技能文件。

`--skip-fts` 是**按索引自适应**的：manifest 里 FTS 可用就不加，不可用才加。强制 `skipFts: true` 可以加；没有“强制开启 FTS”的配置，因为开启是修复（`gitnexus analyze --repair-fts`），不是增量刷新。

## 许可证（商用前必读）

本插件是 **MIT**（见 [LICENSE](LICENSE)）。

**GitNexus 是 `PolyForm-Noncommercial-1.0.0`**：允许非商业使用，限制商业使用。`gitnexus` 是本包的 **peer**，不随包安装，插件也不打包或再分发它。但使用本插件的 GitNexus 相关功能（读索引、刷新、安装）时，**你对 GitNexus 的使用受 GitNexus 许可证约束**；商业使用需要 GitNexus 作者的单独授权：

<https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE>

一句话：**MIT 覆盖本插件代码；GitNexus 的许可证覆盖 GitNexus，使用相关功能就要受它约束。**

## 边界

- 覆盖与搜索是只读的；维护是单独确认的写操作，不会自动触发。
- 刷新门禁比对的是索引记录过的文件内容哈希。它看不到分析器因自身原因必须重跑的情况（schema 升级、新的分析特性）；**仍然刷新** 就是为这种情况留的。
- 社区图不画全部符号：总览是社区图，下钻最多显示一个社区的节点预算那么多成员；符号视图是全仓库符号的有界截断投影，按文件顺序取前 N 个，不能当成完整图。两者都会标注是否截断。
- 只报告 GitNexus 索引的事实，不重写解析器，不重新实现图数据库。
- 搜索的 graph 模式是名称/路径匹配，不搜正文；text 模式才按行匹配，且有上限。
- 源码回退只覆盖索引清单里的文件，新文件需先刷新索引。
- 没有 `.git` 的目录用 `--skip-git` 建的索引没有提交基线：门禁只能说“无法确认”，刷新是完整重分析（不是增量），Git 活动卡片也不会出现。
- 子目录搜索是**有界**的：默认最多 12 层、4000 个目录、2 秒；跳过 `node_modules`、构建产物和所有隐藏目录，不跟随符号链接。多项目时默认优先已索引项目（上次选择 → 工作区自身索引 → 第一个已索引 → 工作区扫描），标题栏可切换；遇到已索引或 `.git` 目录即停止下钻；搜索被上限截断时面板会说明“可能还有未列出的项目”。
- 更深的设计与构建记录不放进公开 README；本文件只讲“做什么”和“出问题怎么处理”。
