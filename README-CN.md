# dsh-gitnexus-plus

[English](README.md) · **简体中文**

**当前版本：0.1.2** · [npm](https://www.npmjs.com/package/dsh-gitnexus-plus) ·
[问题反馈](https://github.com/Moowningstar/gitnexus-plus/issues)

[插件做什么](#插件做什么) · [安装](#安装) · [遇到问题怎么解决](#遇到问题怎么解决) ·
[上游 GitNexus 文档](#上游-gitnexus-文档路径)

一个 DeepSeek Harness 插件：查看 GitNexus 索引**覆盖了什么、漏掉了什么**，在右侧栏刷新索引，并按关键词搜索图里的符号。

它不 fork GitNexus、不重写解析器、不打包或再分发 GitNexus。`gitnexus` 是 **peer**，需要你自己提供。

## 插件做什么

- **索引覆盖**：列出被 `gitnexus analyze` 跳过的超大文件，给出大小、语言占比，以及生成物/压缩文件的判断信号。
- **索引新鲜度**：索引提交与 `HEAD` 对比，分为 `current` / `behind` / `diverged` / `unknown`，并给出未提交变更数。
- **图构成**：节点、边、社区、流程、embedding、边/节点比。
- **Git 活跃度 × 索引**：最近提交、作者、分支、改动最多的文件，每个文件给出 **已索引 / 设计上排除 / 索引缺失** 三方判断；另有活动 × 索引交叉表、相对索引提交的基线审查（索引未记录提交时用活动窗口起点并明确标注）、7/14/30 天提交时间线，以及点击文件行查看该文件自己的时间线。
- **语言分布**：按字节拆分“能解析进图的语言 / 只识别格式的语言 / 其他”；GitNexus 不在时用内置扩展名映射，并标为 `builtin`，不冒充已解析。
- **关键词搜索**：按图节点的 `name` / `filePath` 匹配，返回 kind、path、line；点击结果打开文件并定位到行，右侧“复制”按钮复制 `path:line`。
- **源码回退**：图查询子进程起不来时（无可用 shell 沙箱、DLL/ABI、索引忙），在索引清单内的文件里做有界源码行匹配，结果标为 `mode: "text"`。
- **无索引也有信息**：git 项目尚未建索引时，显示扫描概览、语言分布和初始化命令，而不是空白面板。
- **维护**：初始化、增量刷新、全量重建（`--force`）都通过 DSH 的 shell 执行器运行，不自行请求提权。

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

面板会报告当前工作区指向的项目，不提供全局仓库列表。它以“项目根”（有 `.gitnexus` 索引或 `.git`）为边界，不会变成文件系统探测器。

DSH 内暴露：

- 工具 `gitnexus_coverage`：`{ repo, includeLanguages? }`
- 路由 `GET /api/gitnexus/coverage?repo=<project>`
- 路由 `GET /api/gitnexus/search?repo=<project>&q=<keyword>&limit=20`
- 路由 `GET /api/gitnexus/file-history?repo=<project>&path=<file>&days=7`：单个文件的
  有界提交时间线
- 路由 `POST/GET/DELETE /api/gitnexus/analyze`（唯一会改动索引的入口）
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
| 项目还没有索引 | 点 **初始化索引**，或执行 `gitnexus analyze --index-only <repo>`。 | [`README.md` — CLI Reference](https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md#cli-reference)、[`RUNBOOK.md` — Index out of date](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#index-out-of-date--stale-tools) |
| 刷新失败、`spawn EPERM`，或索引停在 `incremental-in-progress` | 面板命令已带 `GITNEXUS_MEMORY=off`、`NODE_OPTIONS=--max-old-space-size=8192`、`GITNEXUS_HOME=<repo>/.gitnexus/plugin-home`、`--index-only`。沙箱仍拒绝时，把命令复制到自己的终端跑；插件不会扩权。 | [`RUNBOOK.md` — LadybugDB / lock errors](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#ladybugdb--lock-errors)、[Memory / analyze crashes](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#memory--analyze-crashes) |
| 刷新报 `EPERM … mkdir '<repo>\.gitnexus\parsedfile-store'` | GitNexus 1.6.12 会从 parse worker 创建这个缓存目录。插件现在在启动 analyze 前由宿主预建缓存目录；升级后重启 DSH。仍失败说明沙箱令牌不能写 `.gitnexus`，把复制出的命令放到普通终端执行。 | [`RUNBOOK.md` — LadybugDB / lock errors](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#ladybugdb--lock-errors)、[`RUNBOOK.md` — Clean slate](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#clean-slate-corrupt-or-huge-gitnexus) |
| 增量分析卡住，或数据库报 `Maximum database size … has been reached` | 用 **全量重建**（`--force`），或按 clean slate 清理后重建。 | [`RUNBOOK.md` — Clean slate](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#clean-slate-corrupt-or-huge-gitnexus)、[`gitnexus/README.md` — Troubleshooting](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#troubleshooting) |
| 搜索报 `A dynamic link library (DLL) initialization routine failed` / `lbugjs.node` | 图查询在 `lib/bin/search-helper.js` 里跑，不在 Electron 宿主里加载原生模块；升级后重启 DSH，并确保 shell PATH 上有 `node`。helper 起不来时会回退源码。 | [`gitnexus/README.md` — Troubleshooting](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#troubleshooting) |
| Windows 上搜索命中很少，或面板提示 FTS 不可用 | 索引是 `--skip-fts` 建的，或 FTS 扩展加载不了。关键词搜索仍按名称/路径匹配，源码回退按行匹配；修复 FTS 是上游操作。 | [`gitnexus/README.md` — Windows: full-text search unavailable](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#windows-full-text-search-unavailable)、[Analyze warns about unavailable FTS](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#analyze-warns-about-unavailable-fts-or-vector-extensions) |
| 点击搜索结果没有打开文件 | 点击依赖 `ctx.sidebarRight.openResourceIn`；没有该服务的 profile 会退回复制 `path:line`。重启 DSH；仍不行就用“复制”。 | 面板/DSH 边界，无上游 GitNexus 路径。 |
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

全量重建再加 `--force`。

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
- 只报告 GitNexus 索引的事实，不重写解析器，不重新实现图数据库。
- 搜索的 graph 模式是名称/路径匹配，不搜正文；text 模式才按行匹配，且有上限。
- 源码回退只覆盖索引清单里的文件，新文件需先刷新索引。
- 更深的设计与构建记录不放进公开 README；本文件只讲“做什么”和“出问题怎么处理”。
