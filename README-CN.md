# dsh-gitnexus-plus

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/moowningstar/gitnexus-plus) [![dsh.so install · dsh 0.2.1-rc.2](https://www.dsh.so/badge/install/gitnexus-plus@0.2.1-rc.2.svg)](https://www.dsh.so/artifact/gitnexus-plus/)

[English](README.md) · **简体中文**

**当前版本：0.1.8** · [npm](https://www.npmjs.com/package/dsh-gitnexus-plus) ·
[问题反馈](https://github.com/Moowningstar/gitnexus-plus/issues)

[插件做什么](#插件做什么) · [安装](#安装) · [遇到问题怎么解决](#遇到问题怎么解决) ·
[上游 GitNexus 文档](#上游-gitnexus-文档路径)

一个 DeepSeek Harness 插件：查看 GitNexus 索引**覆盖了什么、漏掉了什么**，判断这次刷新值不值得跑，
看图，用 GitNexus 自带的 3D 视图看全貌，在右侧栏刷新索引，并按关键词搜索符号与索引记录过的文件正文。

它不 fork GitNexus、不重写解析器、不打包或再分发 GitNexus。`gitnexus` 是 **peer**，需要你自己提供。

## 插件做什么

- **刷新门禁（Tier 0）**：在给出刷新按钮之前，用工作区文件与索引记录的 sha256（`.gitnexus/gitnexus.json` 的 `fileHashes`）比对，报告真正变化的内容：改 / 增 / 删，以及被索引策略排除的文件。工作区没变时毫秒级给出结论、**不启动分析器**，按钮直接说明"无需刷新"，而不是让你等一次几分钟的重建。只有比对**锚定在索引记录的提交**上时才会说"已是最新"；索引没记录提交时会退化为工作区与 `HEAD` 比较，并明确说"无法确认"，而不是冒充新鲜。
- **图视图**：把索引里的社区画在 canvas 上，跨社区关系按权重聚合；点社区看成员符号及它们之间的关系，点符号在文件查看器里定位到行。节点与边预算由宿主限制，并明确写出省略了多少。社区之外的符号可用**符号视图**切换查看：它是按文件顺序截断的全仓库符号投影，结构全貌仍看社区视图。**展开**是居中弹窗而不是全屏。卡片滚动到视口附近才发起图请求。
- **3D 视图**：完整、可旋转的图直接复用 GitNexus 自带的 Web 前端，而不是自己重画。面板按需启动 `gitnexus serve`（每个宿主一个进程，插件卸载时停止），在自己的弹层 iframe 里展示，旁边有**在新标签页打开**和**停止服务**。服务用与分析器同一个 CLI 启动，并带上**真正登记了这个仓库**的 `GITNEXUS_HOME` 注册表，所以 URL 打开的是当前项目而不是别的已索引仓库；启动失败时把子进程自己的输出显示出来（索引版本不匹配会看到 `Trying to read a database file with a different version`，而不是一片空白）。端口上已有的服务只要能看见本仓库就直接接管、绝不杀掉。弹层默认占可用视口的 86%，顶部有**紧凑 / 标准 / 铺满**三档，右下角可拖动到任意大小；尺寸记在 `localStorage` 里，窗口变小时自动收进视口。端口可配置（`webViewPort`）。
- **AI 设置自动填好**：SPA 把供应商设置存在 `sessionStorage` 里，而跨源的 iframe 写不进去。插件改为给服务端一份生成的 `index.html`（通过 `GITNEXUS_WEB_DIST`），在 SPA 的模块脚本运行**之前**就把 `gitnexus-llm-settings` 种好；供应商、Key、模型分别取自 `GITNEXUS_PLUS_AI_PROVIDER` / `GITNEXUS_PLUS_AI_API_KEY` / `GITNEXUS_PLUS_AI_MODEL`，可选 `GITNEXUS_PLUS_AI_BASE_URL`（OpenAI 兼容端点、Azure 端点、Ollama 地址）。于是每个标签页都不用再手贴 Key。一个变量都没设时对话框保持原样；设了一半或写错（比如少了 `GITNEXUS_PLUS_AI_MODEL`）会在卡片上说明，服务照常启动。生成的页面随服务一起删除，接管的外部服务绝不改动；Key 只写进那一个页面，卡片上只看得到供应商、模型和端点。
- **刷新建议**：陈旧度判断同时给出 `无需刷新` / `增量刷新` / `重新分析` / `全量重建` / `初始化索引` / `无法判断`。没有提交基线时不会把“工作区没改”说成可增量刷新；`--skip-git` 索引会明确建议重新分析。
- **索引覆盖**：列出被 `gitnexus analyze` 跳过的超大文件，给出大小、语言占比，以及生成物/压缩文件的判断信号。
- **索引新鲜度**：索引提交与 `HEAD` 对比，分为 `current` / `behind` / `diverged` / `unknown`，并给出未提交变更数。
- **版本一致性**：把索引记录的 `runnerIdentity.cliVersion` 与当前 CLI 对比；不一致时给出警告，而不是默认索引与查询路径一致。
- **图构成**：节点、边、社区、流程、embedding、边/节点比。
- **Git 活跃度 × 索引**：最近提交、作者、分支、改动最多的文件，每个文件给出 **已索引 / 设计上排除 / 索引缺失** 三方判断；另有活动 × 索引交叉表、相对索引提交的基线审查（索引未记录提交时用活动窗口起点并明确标注）、7/14/30 天提交时间线，以及点击文件行查看该文件自己的时间线。
- **语言分布**：按字节拆分“能解析进图的语言 / 只识别格式的语言 / 其他”；GitNexus 不在时用内置扩展名映射，并标为 `builtin`，不冒充已解析。
- **关键词搜索**：图查询按符号的 `name` / `filePath` 匹配，返回 kind、path、line；同一次查询还会问索引自带的 FTS（`file_fts`）要文件正文，所以「只在文件内容里出现过」的词也能找到那个文件。正文命中只能是文件级、没有行号——只有图知道符号边界；面板底部会写明这次实际用了哪种范围。点符号命中会打开文件并定位到行，右侧“复制”按钮复制 `path:line`。
- **源码回退**：图查询子进程起不来时（无可用 shell 沙箱、DLL/ABI、索引忙），在索引清单内的文件里做有界源码行匹配，结果标为 `mode: "text"`。
- **工作区多项目与切换器**：工作区本身可以是容器（例如 `D:\Project` 下放着 `gitnexus-plus/`、`viewer/`，或 `geo/` 下放着 `frontend/`、`backend/`）。面板会从当前工作区**向下**收集工作区自身、已索引项目，以及尚未建索引的 git 仓库；默认选一个，标题栏显示项目数并可切换；选择按工作区记住。未索引的 git 项目也会列出来，选中后可以针对该目录初始化。
- **无索引也有信息**：git 项目或普通文件夹尚未建索引时，显示扫描概览、语言分布和初始化命令，而不是空白面板。普通文件夹的索引由 `--skip-git` 建立。
- **维护**：初始化、增量刷新、全量重建（`--force`）都通过 DSH 的 shell 执行器运行，不自行请求提权。索引报告 FTS 不可用时，面板另外提供 **修复搜索索引（FTS）**，只跑 `analyze --repair-fts`，不重跑分析。

## 安装

前置：

- DSH `>=0.2.0-rc.2 <0.3.0`（已逐项对照桌面宿主 `0.2.1-rc.3`：本插件用到的 `shell`、
  `webServer`、`sandboxPolicy`、`tools` 服务，`sidebar.right.pane.tab` 槽位与客户端 primitives 都在）
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

- 工具 `gitnexus_coverage`：`{ repo, includeLanguages? }` —— 索引漏掉了什么
- 工具 `gitnexus_delta`：`{ repo }` —— 这次刷新会不会改变索引
- 工具 `gitnexus_impact`：`{ repo, target, direction?, maxDepth?, summaryOnly?, limit?, minConfidence? }`
  —— “改这个符号会波及谁”，改代码**之前**该问的
- 工具 `gitnexus_context`：`{ repo, name?, uid?, file_path?, kind?, include_content? }` —— 一个符号的
  定义、调用者、被调用者与它参与的流程；名字有歧义时用 `uid`（`gitnexus_query` 的定义行会打印
  `uid <id>`）
- 工具 `gitnexus_query`：`{ repo, search_query, goal?, task_context?, limit?, max_symbols? }` ——
  用自然语言问图“这块功能在哪”，返回流程、流程内符号与同名定义
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

**名字对照**：GitNexus 自己生成的 `AGENTS.md`（每次 analyze 都会被重写）用的是上游 MCP 的裸名，本插件注册的是带前缀的工具名。照着那份文件调用会找不到工具，所以按这张表换：

| `AGENTS.md` 里写的 | 本插件里的工具 | 说明 |
| --- | --- | --- |
| `impact({target, direction})` | `gitnexus_impact` | 同名参数，外加 `maxDepth`/`summaryOnly`/`limit`/`minConfidence` |
| `context({name})` | `gitnexus_context` | 除 `name` 外可用 `uid`/`file_path`/`kind` |
| `query({search_query})` | `gitnexus_query` | 同名参数，外加 `goal`/`task_context`/`limit`/`max_symbols` |
| `detect_changes({scope})` | `gitnexus_delta` | 只回答「要不要刷新」；按 staged/compare 分范围的能力留待 0.1.9 |

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

`npm test` 会先构建，再依次跑引擎、插件、客户端三套 —— 0.1.8 时共 1026 项（引擎 708、插件 80、
客户端 238）。其中 7 项是编解码护栏：它把 GBK 能编码的每个字符映回字节，一旦连续一段又能被
UTF-8 解码成正常文本就失败 —— 这正是双解码字符串的样子，而字符黑名单总是漏掉它。另有 4 项是
发布卫生：`.npmrc` 与 `package-lock.json` 必须只指向 `registry.npmjs.org`（0.1.7 的 lockfile 全指
镜像，一次 `npm install` 就会写回，只有断言能发现）。测试不依赖
开发机的 `D:` 盘：格式测试会自建一次性仓库，真实仓库冒烟测试默认用本
checkout（或用 `GITNEXUS_SMOKE_REPO` 指定），没有索引时跳过。`.github/workflows/ci.yml` 在
Windows 与 Ubuntu、Node 22 与 24 上跑 `npm ci`、`npm run check`、`npm test`。

### 三个图工具怎么工作

`gitnexus_impact`、`gitnexus_context`、`gitnexus_query` 不是插件自己实现的遍历：它们把请求交给
`lib/bin/graph-query-helper.js`，由系统 Node 加载 GitNexus 自己的 MCP 后端来回答。原因是原生
`lbug` 加载不进宿主进程（宿主是 Electron 的 Node，ABI 不匹配），这和画图投影用的是同一条边界。

一次调用一个短命子进程，冷启动约 400–600 ms（node + 注册表 + 原生存储 + 遍历），和一次 grep
同量级。请求体走临时文件而不是命令行参数：符号名是调用方的文本，可能有空格、引号、换行。

**子进程走宿主的执行 seam，而不是插件自己 `spawn`**（`src/subprocess.ts`）：宿主挂了
`ctx.subprocess` 就用它（`argv` 原样交给系统，不经 shell 解释；有沙箱策略时先过
`ctx.sandbox.confine`，拿不到 `confine` 就**拒绝**无隔离启动，而不是偷偷放行）；没挂
`ctx.subprocess` 才退回 `ctx.shell` 与命令字符串。两条路都转发了工具的 `exec.signal`，所以调用方
取消时子进程会被停掉，回答是「这次查图被取消了」而不是等满超时。这条 seam 也让面板在没有 shell
的部署里仍然能读图 —— 有 `ctx.subprocess` 就够了。

回答里有两样东西**永远不会被截断**，因为它们是“这个答案能信多少”的元信息：

- `risk`：`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`/`UNKNOWN`。**`UNKNOWN` 不等于安全** —— 它表示上游
  遍历一个调用者都没解析到，可能只是调用点解析不出来（动态派发、跨语言、没索引的包）。
- `epistemic`：`exact` 或 `lower-bound`。`lower-bound` 时列表是下界，真实依赖可能更多。

上游还会在某些路径上给出 `boundaries`（中文解释「为什么是下界」）、`causes`（缺口来源的计数）
和 `riskNote`（遍历自己的理由）。**有就照登，没有就不提** —— 实测 `impact`/`context` 在 1.6.12
上通常不带这三个字段，所以本插件不替上游编，也不会因为它们缺失而省掉上面那两行。

**查不到符号时会说出来。** 上游对不存在的目标返回 `{"error":"Target 'x' not found", …}` 加一个
`risk: UNKNOWN`；只印 UNKNOWN 会被读成“没有人调用它”。现在渲染层把 `error` 原样登出，并补一句
「这个符号不在索引里 —— 先刷新索引再问它」。

列表本身有上限（调用者 12 条、流程 6 条、定义 12 条），但**计数永远是真实的**：被截断时会写明
“还有 N 条未列出”。

`graphTools: false` 可以把这三个工具整体关掉，只留 coverage 与 delta（它们不需要起子进程）。


搜索分为两种模式：

- **graph**：正常情况。宿主不直接加载原生 `lbug`，而是启动 `lib/bin/search-helper.js`（系统 Node）：符号名与文件路径由图查询（`CONTAINS`）给出，能带上精确的符号和行号；正文由索引自己的 FTS（`file_fts`）给出，所以关键词也能命中「只在文件内容里出现过」的文件。正文命中只能是文件级、没有行号——只有图知道符号边界。索引是 `--skip-fts` 建的、或 FTS 扩展加载失败时，仍然返回名称/路径结果，面板会写明这次实际用了哪种范围（`按符号名、文件路径与文件正文（FTS）匹配` 或 `按符号名与文件路径匹配；不搜索正文`）；声明可用却加载失败时，图查询会先不带 FTS 重试一次，再决定是否报错。
- **text**：图查询起不来时的回退。只读索引清单里的文件，按行匹配，代码文件优先，文件数/字节数/匹配数都有上限；面板标题会显示“源码关键词（回退）”。

点击结果行会用 `ctx.sidebarRight.openResourceIn(sessionId, address, { params: { line } })` 打开平台文件查看器并定位行；没有该服务时退回复制路径。

### 给内嵌 Web 端的 AI 设置

内嵌的 GitNexus SPA 自带对话，AI 设置按标签页保存在 `sessionStorage` 里。在 DSH 启动的环境里导出下面这些变量，面板每次启动服务时都会替你填好：

| 变量 | 含义 |
| --- | --- |
| `GITNEXUS_PLUS_AI_PROVIDER` | `openai`、`gemini`、`anthropic`、`azure-openai`、`ollama`、`openrouter`、`minimax`、`glm`、`deepseek` 之一；常见别名也认（`google`、`claude`、`azure`、`z.ai`、`open-ai`）。 |
| `GITNEXUS_PLUS_AI_API_KEY` | 供应商 Key；`ollama` 不需要。 |
| `GITNEXUS_PLUS_AI_MODEL` | 供应商那边的模型 id，例如 `gpt-4o-mini`、`gemini-2.0-flash`、`llama3.2`。 |
| `GITNEXUS_PLUS_AI_BASE_URL` | 可选。OpenAI 兼容端点、Azure 端点（`azure-openai` 必填）或 Ollama 地址。 |

这些值不经过网络：服务端交出去的那一页在 SPA 模块脚本运行前用内联脚本写 `sessionStorage`。一个变量都没设时对话框原样不动，卡片会说明这一点；设了一半（比如有供应商和模型但没有 Key）会在卡片上报错，服务仍然启动，写错变量不会连 3D 视图一起丢掉。

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
| Windows 上搜索命中很少，或面板提示 FTS 不可用 | 先看 `.gitnexus/meta.json` 里的 `capabilities.fts`：`status: "unavailable"` 只是建索引时写下的记录，**可能是陈旧的**——本机实测记录说不可用，而 `gitnexus doctor` 报 `Full-text search: available`，扩展文件也都在。用 **修复搜索索引（FTS）**（`analyze --repair-fts`）重写这份记录与搜索索引，不动图；之后面板报的是「这次实际搜了什么」，不再复述 manifest。其余原因按可能性排：索引是 `--skip-fts` 建的；修复需要在**子进程**里安装/加载扩展而受限 shell 拒绝（`spawn EPERM` → 把命令复制到终端跑）；或扩展真的加载不了，那是 Windows 缺少原生运行时（VC++ 2015-2022 x64 与 OpenSSL 3）——四种里最少见的一种，值得先确认再下结论。 | [`gitnexus/README.md` — Windows: full-text search unavailable](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#windows-full-text-search-unavailable)、[Analyze warns about unavailable FTS](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#analyze-warns-about-unavailable-fts-or-vector-extensions) |
| 刷新按钮显示“无需刷新”且不可点 | 这是 Tier 0 的判断，不是故障：索引记录的文件内容哈希全部没变，再跑分析器也不会改变索引。**仍然刷新** 可以强制跑一次（例如 GitNexus 升级或 schema 变化后）。如果索引没有记录提交基线，面板**不会**说“无需刷新”，而是显示“无法确认”并保持按钮可用。 | 本插件的差量引擎；无上游 GitNexus 路径。 |
| 门禁显示“无法确认”，而不是“无需刷新” | 索引没有记录提交。0.1.8 起，插件在**自己发起的那次刷新成功之后**会把当前提交写回 manifest 的 `lastCommit` 和这次 analyze 用的那份 registry，所以沙箱里刷新完也能给出“已是最新”。工作区有未提交改动时它**不写** —— 把提交记上去会让门禁误报“已是最新”，面板会说明“还有 N 处未提交改动，提交后再刷新”。仍然只剩三种情况需要去普通终端：索引是别人在终端建的、目录不是 git 仓库、或这个仓库还没有提交。写回只填空不覆盖，已有基线不会被改动。 | 本插件差量引擎 + 分析器的 git 访问；无上游 GitNexus 路径。 |
| 面板显示 git 不可用，活动与文件历史为空 | 0.1.7 及以前用**管道**捕获 `git` 的输出，受限宿主（DSH 沙箱、以受限令牌启动子进程的 Windows 服务）会拒绝命名管道，表现为 `spawn EPERM`，于是被误读成“机器上没有 git”。0.1.8 起所有 git 调用都改成把子进程的输出写进文件再读回（`src/gitnexus/git-capture.ts`）；stdout 与 stderr 分开捕获，避免 git 的 `LF will be replaced by CRLF` 警告混进文件名列表。捕获先试宿主自己的 spawner，够不到 git 时回退到文件描述符；临时文件放在**工作区内**（`<repo>/.gitnexus/plugin-home/tmp`），因为宿主进程往往正是无权写系统临时目录的那一方。全都失败时，结论会写出原因（`git rev-parse HEAD → EPERM`、`… → exit 128`）——「没装 git」「不是仓库」「宿主拒绝起进程」是三件不同的事。 | 本插件的子进程捕获；无上游 GitNexus 路径。 |
| 图视图空白，或报 404 | 404 说明宿主还没有 `/api/gitnexus/graph` 路由，重启 DSH，而不是只刷新页面。空白画布但下面有说明，通常是索引还没有社区（旧索引）或索引忙：刷新索引即可。节点数按预算截断，卡片会写明省略了多少。 | 本插件宿主路由；图数据本身来自 GitNexus 索引。 |
| 图视图对某些项目一直加载或 504，另一些正常 | Windows ACL 沙箱第一次给 workspace 授权时会把可继承 ACE 传播到整棵仓库树，大仓库可能超过 25 秒 helper 超时；已授权过的项目则很快。0.1.5 起搜索/图 helper 的 workspace 根收窄到 `<repo>/.gitnexus`，只覆盖索引目录；重启 DSH 后生效。仍失败时确认 `.gitnexus/lbug` 存在，并检查是否有另一个 analyze 正占用该索引。 | 本插件的 sandbox 策略根；图数据本身来自 GitNexus 索引。 |
| 3D 视图打不开，或弹层里一片空白 | 先看卡片上的状态文案：`不可用` 表示宿主没有 shell 执行器，或本机没有 `gitnexus`（卡片会给出安装命令）；`启动失败` 会附上子进程自己的输出，端口被占（`EADDRINUSE`）与索引版本不匹配（`database file version`）是最常见的两种。`服务在跑，但索引对不上` 说明端口上的服务注册表里没有本仓库：先刷新本仓库索引，或停掉外部启动的服务。卡片整个缺失/报 404 则是宿主没挂载路由，重启 DSH。 | 本插件的 web 视图生命周期；SPA 是 GitNexus 包里的 `web/` 目录。 |
| 3D 视图里 AI 设置还是空的 | 卡片上的 **AI 设置** 一行会说明原因：`没有设置 GITNEXUS_PLUS_AI_* 环境变量` 就是没配置，按上面那张表导出变量后重启 DSH 或点**重新启动**；`缺少 GITNEXUS_PLUS_AI_MODEL` / `缺少 GITNEXUS_PLUS_AI_API_KEY` 是配了一半；`外部启动的服务` 说明端口上那个服务不是插件起的，它的页面改不了，只能在弹层里手填一次。变量是 DSH 进程的环境，改完必须重启 DSH 才会被读到。 | 本插件的注入页面（`GITNEXUS_WEB_DIST`）；SPA 的设置存在自己的 `sessionStorage` 里。 |
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
- 3D 视图是第二个进程，按需启动：需要本机有 `gitnexus` CLI；宿主没有 shell 执行器时只提供手动执行的命令。嵌入是只读展示——iframe 是另一个源，面板脚本进不去，操作请在 SPA 里做，或用**在新标签页打开**。
- 端口上手工启动的服务，只有注册表里列了本仓库才会被接管，否则插件换下一个端口而不是杀掉它；卡片会说明是哪一种。接管来的服务用的是它自己的页面，AI 设置注入不到，需要在那边的对话框里手填一次。
- 注入的 AI 设置和手填的一样存在 `sessionStorage`：标签页关闭时 SPA 会清掉，下次启动时插件重新注入。生成的那份页面放在 `$DSH_HOME/gitnexus-plus/webview/`，服务停止时删除；除此之外不写仓库，也不写 `~/.dsh`。
- 只报告 GitNexus 索引的事实，不重写解析器，不重新实现图数据库。
- 搜索的 graph 模式：符号名/文件路径来自图，正文来自索引自带的 FTS（`file_fts`，仅文件级、无行号）；FTS 不可用时退回名称/路径并在面板写明。text 模式才按行匹配，且有上限。
- 源码回退只覆盖索引清单里的文件，新文件需先刷新索引。
- 没有 `.git` 的目录用 `--skip-git` 建的索引没有提交基线：门禁只能说“无法确认”，刷新是完整重分析（不是增量），Git 活动卡片也不会出现。
- 子目录搜索是**有界**的：默认最多 12 层、4000 个目录、2 秒；跳过 `node_modules`、构建产物和所有隐藏目录，不跟随符号链接。多项目时默认优先已索引项目（上次选择 → 工作区自身索引 → 第一个已索引 → 工作区扫描），标题栏可切换；遇到已索引或 `.git` 目录即停止下钻；搜索被上限截断时面板会说明“可能还有未列出的项目”。
- 更深的设计与构建记录不放进公开 README；本文件只讲“做什么”和“出问题怎么处理”。
