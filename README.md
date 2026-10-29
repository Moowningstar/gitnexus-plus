# dsh-gitnexus-plus

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/moowningstar/gitnexus-plus) [![dsh.so install · dsh 0.2.1-rc.2](https://www.dsh.so/badge/install/gitnexus-plus@0.2.1-rc.2.svg)](https://www.dsh.so/artifact/gitnexus-plus/) [![Listed on DSH Get](https://img.shields.io/badge/Listed_on-DSH_Get-1677ff?style=flat-square)](https://dshget.com/plugins/Moowningstar/gitnexus-plus)

**English** · [简体中文](README-CN.md)

**Current release: [0.1.10](https://github.com/Moowningstar/gitnexus-plus/releases/tag/v0.1.10)** ·
[npm](https://www.npmjs.com/package/dsh-gitnexus-plus) ·
[Issues](https://github.com/Moowningstar/gitnexus-plus/issues)

[What it does](#what-it-does) · [Install](#install) · [Troubleshooting](#troubleshooting) ·
[Upstream GitNexus docs](#upstream-gitnexus-documentation)

A DeepSeek Harness plugin: see what a GitNexus index **covers and what it leaves out**,
decide whether a refresh is worth running, browse the graph, read the repository's own
commit graph — each commit's files and patches included — open GitNexus's own 3D view for
the full picture, refresh the index from the sidebar, and search its symbols — and the
source text the index recorded — by keyword.

It does not fork GitNexus, rewrite its parser, or bundle/redistribute it. `gitnexus` is a
**peer**; you provide it.

## What it does

- **Refresh gate (Tier 0)** — before offering a refresh, the panel compares the working
  tree with the sha256 hashes the index recorded in `.gitnexus/gitnexus.json` and reports
  what actually differs: modified / added / deleted, plus files the index's own policy
  excludes. A clean tree answers in milliseconds without starting the analyzer, and the
  button says so instead of running a minutes-long rebuild. The verdict is only called
  "up to date" when it is anchored to the commit the index recorded; an index that
  recorded none falls back to comparing the working tree with `HEAD` and says it cannot
  confirm instead of claiming freshness.
- **Graph view** — the index's communities drawn on a canvas, with aggregated
  cross-community edges; click a community to see its member symbols and the relations
  among them, click a symbol to open its file at the line. Node and edge budgets are
  applied by the host, and the view states what it left out. A **Symbol view** button
  switches to a bounded all-symbol projection when a symbol outside the current
  communities matters; it is explicitly truncated by file order, and the community view
  remains the structural overview. Single click selects a community; **Expand** opens a
  centered dialog with the same projection and a community sidebar, not a full-screen
  mode. The card defers its fetch until it is scrolled near the viewport.
- **3D view** — the full, rotatable graph is GitNexus's own web UI, embedded instead of
  reimplemented. The panel starts `gitnexus serve` (one process per plugin host, stopped
  when the plugin unloads) and shows the SPA in an overlay iframe, with **open in a new
  tab** and **stop the server** beside it. The server is spawned with the same CLI the
  analyzer uses, against the `GITNEXUS_HOME` registry that actually holds this
  repository, so the URL opens *this* project rather than another indexed one. A failed
  start surfaces the process's own output — a version-mismatched index shows
  `Trying to read a database file with a different version` instead of a blank frame. An
  existing server on the port is adopted (and never killed) when it can see the
  repository. The dialog opens at 86% of the usable viewport, has **紧凑 / 标准 / 铺满**
  presets, and can be dragged to any size from the bottom-right corner; the size is
  remembered in `localStorage` and clamped whenever the window shrinks. Port and
  embedding are configurable; see `webViewPort`.
- **AI settings, pre-filled** — the SPA keeps its provider settings in `sessionStorage`,
  which a cross-origin iframe cannot be written to. The plugin therefore serves it a
  generated `index.html` (through `GITNEXUS_WEB_DIST`) that seeds `gitnexus-llm-settings`
  before the app boots, taking provider, key and model from
  `GITNEXUS_PLUS_AI_PROVIDER` / `GITNEXUS_PLUS_AI_API_KEY` /
  `GITNEXUS_PLUS_AI_MODEL` (plus optional `GITNEXUS_PLUS_AI_BASE_URL` for
  OpenAI-compatible endpoints, Azure endpoints and Ollama hosts), so chat works without
  pasting a key into every tab. Unset variables leave the dialog untouched; a partial or
  misspelled set is explained on the card (`缺少 GITNEXUS_PLUS_AI_MODEL…`) while the
  server still starts. The generated page is removed with the server, an adopted server is
  never touched, and the key never reaches the panel — only provider, model and endpoint.
- **Refresh advice** — the staleness verdict also recommends one of `none` /
  `incremental` / `reanalyze` / `rebuild` / `init` / `unknown`, so a worktree-only
  comparison never reads as "safe to incrementally refresh" and a `--skip-git` index is
  told to re-analyze instead of being offered an impossible incremental run.
- **Index coverage** — lists the oversized files `gitnexus analyze` skipped, with size,
  language share, and generated/minified signals.
- **Index freshness** — indexed commit vs `HEAD`, classified `current` / `behind` /
  `diverged` / `unknown`, plus the uncommitted-change count. The same verdict feeds the
  panel sentence and the tool prefix described above, so there is one judgement, not three
  that can disagree.
- **Version consistency** — compares the GitNexus CLI that wrote the index
  (`runnerIdentity.cliVersion`) with the CLI installed now. A mismatch inside the
  supported range (`^1.6.12 || >=1.6.13-rc.0 <2.0.0`) is reported as a **cross-line**
  note — the index was built on the stable line and the CLI is a candidate, or the
  reverse — not as an error; only a pair with one side outside the range is a warning.
  The card names all three facts: the range, the line that wrote the index, and the
  line installed now.
- **Process budgets** — every graph card states what the process detector was allowed
  to do. The index's manifest records `processDetection` (max processes, branching,
  trace depth, entry-point candidates); the panel tells three cases apart: the flow
  count was cut by a budget, the scan produced no flows although entry points exist
  (the count is not zero because the repository has none), and no budget is recorded
  at all (an index from an older analyzer — the completeness is unknown, not "none").

- **Graph composition** — nodes, edges, communities, processes, embeddings, edges per node.
- **Git activity × index** — recent commits, authors, branches and most-changed files,
  each file marked **indexed**, **excluded by design**, or **missing from the index**.
  Includes an activity × index cross-tab, a baseline review against the indexed commit
  (or the activity-window start when the index recorded none), a 7/14/30-day commit
  timeline, and a per-file commit timeline that opens under the row that was clicked
  (whichever of the three lists it came from). One list renders at a time — the segmented
  control switches between baseline, most-changed, most-recent and missing, with the
  cross-tab and authors behind one disclosure. The header's branch select runs a real
  `git checkout` and reloads the report against the new branch; it never stashes and never
  guesses, and git's own refusal is shown as-is.

- **Commit graph** — that timeline is drawn as lanes, not as a row of dots: one column per
  concurrent line of history, a fixed colour per column, the index verdict as a thin ring
  *around* the dot instead of the dot's fill, and the refs pointing at a commit (`main`,
  `origin/main`, `tag: v0.1.9`) as chips in their column's colour. History is read with
  `--all`, so a branch that is not merged yet gets its own column instead of being flattened
  into one straight line; hovering a row thickens its lane and fades the ones it crosses;
  past six columns the gutter counts the folded ones as `+N` on each row rather than
  pretending the row is narrow. No drawing library is bundled: the curve is a cubic Bézier
  that stops short of each dot, which is why lines finally stop running through them.

- **A commit's own files** — clicking a commit expands the files it touched, with `+n` /
  `−n`, in git's path order and capped at 40 per commit (the cap is stated on screen).
  Clicking one of those files opens its patch inline: the same `file-diff` route and the
  same renderer the per-file timeline already used, with old/new line numbers, tinted
  added/removed rows and a copy button. The patch is read, never stored — nothing new
  writes to the index.

- **Paging, not "the first few"** — the four activity lists each keep their own page (25
  more per click) and the commit timeline shows 15 at a time, with the remainder counted on
  the button. Switching lists does not reset the others, and opening a commit's files does
  not collapse the page you were on.

- **Index staleness, said out loud** — when the gate's verdict is `behind`, the graph card
  carries one sentence above the drawing (which commit it is behind from, how many files
  changed, what to run), and `gitnexus_impact` / `gitnexus_context` / `gitnexus_query`
  repeat the same sentence at the top of their answers. A tree that matches says nothing at
  all, and a verdict that cannot be confirmed gets its own wording instead of borrowing
  "stale" — a refresh prompt for an index that is merely unanchored would train people to
  ignore both.

- **CI gates** — `gitnexus-coverage` can fail a pipeline instead of waiting for someone to
  read the panel: `--fail-on-uncovered` (the analyzer would index files the index does not
  hold) and `--fail-on-missing` (no index, or an index describing files that are gone) exit
  **3**; the older `--fail-on-large` keeps exit **2** for size skips. The two codes are
  separate on purpose — one is a hole the index knows about, the other means index and
  checkout have diverged — and the reasons go to **stderr**, so `--json` still parses and
  the exit code stays the contract.

- **Language distribution** — bytes split into languages GitNexus can parse, formats it
  only recognizes, and everything else. Without GitNexus, a built-in extension map keeps
  the breakdown useful and marks it `builtin`, never "parsed".
- **Keyword search** — a graph query matches symbol `name` / `filePath` and returns kind,
  path and line; the same query asks the index's own full-text index (`file_fts`) for
  source text as well, so a term that only appears inside a file body still finds that
  file. Body hits are file-level and carry no line range, because only the graph knows
  symbol boundaries, and the footer says which of the two scopes actually ran. Clicking a
  symbol hit opens the file at that line, and a separate Copy button copies `path:line`.
- **Source fallback** — when the graph helper cannot start (no usable shell sandbox,
  DLL/ABI, busy index), a bounded line search over the indexed files returns
  `mode: "text"` instead of pretending to be the graph.
- **Multiple projects in one workspace** — the workspace can be a container (`D:\Project`
  holding `gitnexus-plus/`, `viewer/`, or `geo/` holding `frontend/`, `backend/`). The
  panel discovers the workspace itself, every indexed project below it, *and* git
  repositories that have no index yet. It selects one by default and offers a header
  switcher when there is more than one; a selection is remembered per workspace, and an
  unindexed git project can be selected and initialized there.
- **No-index visibility** — a git project *or a plain folder* without an index shows a
  scan overview, language split and the initialize command instead of an empty panel. A
  folder with no `.git` is indexed with `--skip-git`.
- **Maintenance** — initialize, incremental refresh and full rebuild (`--force`) run
  through DSH's shell executor, with no self-escalation. When the index reports FTS as
  unavailable, a **修复搜索索引（FTS）** action runs `analyze --repair-fts` — the search
  indexes only, without re-analysing the repository.

## Install

Requirements:

- DSH `>=0.2.0-rc.2 <0.3.0` (checked item by item against the desktop host `0.2.1-rc.3`:
  the `shell`, `webServer`, `sandboxPolicy` and `tools` services, the `sidebar.right.pane.tab`
  slot and the client primitives this plugin uses are all still there)
- Node `>=22`
- GitNexus `>=1.6.0 <2.0.0` (peer; not installed by this plugin)

```sh
dsh plugin add dsh-gitnexus-plus
```

Restart DSH after adding it. The panel is a right-sidebar tab: open the sidebar's **+**
→ guide page → **GitNexus 索引**.

The `desktop` profile is managed by Electron; the CLI cannot change it. Use the Web
sidebar's Plugins page there. From a local checkout:

```sh
dsh plugin --profile web add <absolute path to this package>
```

GitNexus can be installed by you or by the panel. For a custom location:

```sh
GITNEXUS_CLI=/path/to/gitnexus/dist/cli/index.js
```

### Getting GitNexus

Installing it yourself is recommended:

```sh
npm install -g gitnexus
```

The panel can also install it through DSH's shell:

```sh
npm install --prefix <DSH_HOME>/gitnexus-plus/gitnexus gitnexus@^1.6.12
```

That downloads roughly 500 MB–1 GB and needs a C++ toolchain; no registry is hardcoded.
Treat the first install as unverified and fall back to the manual command if it fails.

## Usage

The panel reports the projects the current workspace contains; it has no global
repository list. It looks **downward** from the workspace: the workspace itself, every
indexed descendant, and git repositories without an index are candidates; an indexed or
`.git` directory is a project boundary. When there is more than one candidate the header
path becomes a switcher, with a line naming the workspace, the project/index counts and
the active path; unindexed projects are labelled. Refreshes, delta, search, graph and
maintenance then target the selected project. The default is the remembered choice, then
the workspace's own index, then the first indexed project, then the workspace scan; an
unindexed container stays on the workspace scan and lists its git projects for
initialization. The directory must exist and must not be a filesystem root; a plain folder
is still scanned and can be indexed with `--skip-git` (no commit baseline, no incremental
refresh). The route offers no way to browse or list any other path.

Inside DSH:

- tool `gitnexus_coverage`: `{ repo, includeLanguages? }`
- tool `gitnexus_delta`: `{ repo }` — would a refresh change anything?
- tool `gitnexus_impact`: `{ repo, target, direction?, maxDepth?, summaryOnly?, limit?, minConfidence? }`
  — who breaks if this symbol changes; ask it *before* editing
- tool `gitnexus_context`: `{ repo, name?, uid?, file_path?, kind?, include_content? }` — one symbol's
  definition, callers, callees, and the processes it takes part in; name it by `uid` when the name
  is ambiguous
- tool `gitnexus_query`: `{ repo, search_query, goal?, task_context?, limit?, max_symbols? }` — ask
  the graph where a concept lives; returns processes, the symbols inside them, and
  name-matching definitions
- route `GET /api/gitnexus/projects?root=<workspace>` — the workspace's projects (indexed and unindexed git)
- route `GET /api/gitnexus/coverage?repo=<project>`
- route `GET /api/gitnexus/search?repo=<project>&q=<keyword>&limit=20`
- route `GET /api/gitnexus/file-history?repo=<project>&path=<file>&days=7` — one file's
  bounded commit timeline
- route `GET /api/gitnexus/file-diff?repo=<project>&path=<file>&sha=<commit>` — one file's
  patch in one commit (7–40 hex sha, read-only, bounded); what a commit's file list opens
- route `POST /api/gitnexus/checkout?repo=<project>` with body `{"branch": "<ref>"}` — the
  top bar's branch switch: runs `git checkout` in the project (the one route that writes
  to the working tree), then the panel reloads the report
- route `GET /api/gitnexus/delta?repo=<project>` — Tier 0 comparison against the index
- route `GET /api/gitnexus/graph?repo=<project>&view=communities|community&id=<community>`
  — a bounded graph projection
- route `POST/GET/DELETE /api/gitnexus/analyze` (the only entry that changes an index;
  `force=1` for a full rebuild, `mode=repair-fts` for the search indexes only)
- right-sidebar tab `gitnexus`

**Name mapping.** GitNexus writes an `AGENTS.md` into every repository it analyses (and
rewrites it on each run) that names tools by their upstream MCP spelling. This plugin
registers them under a `gitnexus_` prefix, so following that file literally finds
nothing. Translate:

| `AGENTS.md` says | This plugin offers | Notes |
| --- | --- | --- |
| `impact({target, direction})` | `gitnexus_impact` | same argument names, plus `maxDepth`/`summaryOnly`/`limit`/`minConfidence` |
| `context({name})` | `gitnexus_context` | `uid`/`file_path`/`kind` when a bare name is ambiguous |
| `query({search_query})` | `gitnexus_query` | same argument name, plus `goal`/`task_context`/`limit`/`max_symbols` |
| `detect_changes({scope})` | `gitnexus_delta` | answers "does the index need a refresh"; staged/compare scoping is not wired yet |

CLI:

```sh
npm run build
node lib/bin/gitnexus-coverage.js <repo-path>
node lib/bin/gitnexus-coverage.js -r material-ui         # by registry alias
node lib/bin/gitnexus-coverage.js --all --json           # every indexed repository
node lib/bin/gitnexus-coverage.js <repo> --fail-on-large # CI gate, exit 2: a file was skipped for size
node lib/bin/gitnexus-coverage.js <repo> --fail-on-uncovered # CI gate, exit 3: the index is missing files it should hold
node lib/bin/gitnexus-coverage.js <repo> --fail-on-missing   # CI gate, exit 3: no index, or one describing deleted files
npm run check
npm test
```

`npm test` builds and runs the engine, plugin and client suites — at 0.1.10 that is 1254
checks (852 engine, 81 plugin, 321 client; three of the engine checks only run when the
local index records a commit, so a checkout without one reports 849). Seven of those are an
encoding guard: it maps every
GBK-encodable character back to its bytes and fails when a run of them decodes as UTF-8 again,
which is what a double-decoded string looks like and what a character blocklist keeps missing.
Six more are publish hygiene: `.npmrc` and `package-lock.json` must point only at
`registry.npmjs.org` (0.1.7's lockfile pointed entirely at a mirror, and one `npm install` on a
mirror-configured machine writes it back — only an assertion notices), and `LICENSE` must hold
the MIT text with nothing appended to it (an appendix makes GitHub report `NOASSERTION` and
every catalog that copies it show "Other"; the scope note therefore lives in `NOTICE.md`).
The suite no longer depends on a developer's
`D:` drive: the format test builds a disposable repository, and the real-repository smoke
test defaults to this checkout (or `GITNEXUS_SMOKE_REPO`) and skips when it has no index.
`.github/workflows/ci.yml` runs `npm ci`, `npm run check` and `npm test` on Windows and
Ubuntu with Node 22 and 24.

### How the three graph tools work

`gitnexus_impact`, `gitnexus_context` and `gitnexus_query` do not re-implement any
traversal: the request goes to `lib/bin/graph-query-helper.js`, which loads GitNexus's own
MCP backend under the system Node. The native `lbug` addon cannot load into this host
(Electron's Node, different ABI) — the same boundary the graph projection already uses.

One short-lived child per call, ~400–600 ms cold (node, registry, native store,
traversal) — the same order as a grep. The request body travels in a temporary file rather
than in argv, because a symbol name is caller-supplied text that may contain spaces, quotes
or a newline.

**The child process goes through the host's execution seam, not a bare `spawn`**
(`src/subprocess.ts`): when the profile mounts `ctx.subprocess` the argv is handed to the
system as-is (no shell parses it), and any sandbox policy is applied through
`ctx.sandbox.confine` — without `confine` the plugin **refuses** to start the process
unconfined instead of quietly bypassing isolation. Only when `ctx.subprocess` is absent does
it fall back to `ctx.shell` and a command string. Both paths forward the tool's
`exec.signal`, so cancelling a call stops the child and answers "this graph query was
cancelled" rather than burning the full timeout. The same seam is what lets the panel read
the graph in a deployment that has no shell at all.

Two things are **never** truncated, because they say how much the answer can be trusted:

- `risk`: `LOW`/`MEDIUM`/`HIGH`/`CRITICAL`/`UNKNOWN`. **`UNKNOWN` is not "safe"** — it means
  the upstream walk resolved no callers at all, which can also happen because the call
  sites are not resolvable (dynamic dispatch, other languages, unindexed packages).
- `epistemic`: `exact` or `lower-bound`. On `lower-bound` the list is a lower bound.

Upstream also emits `boundaries` (its own prose for *why* something is a lower bound),
`causes` (per-kind gap counters) and `riskNote` (the walk's own justification) on some
paths. They are printed **when present and not invented when absent** — measured on 1.6.12,
`impact`/`context` usually carry none of the three, so the plugin does not fabricate them
and does not drop the two lines above when they are missing.

**A symbol that is not in the index now says so.** Upstream answers a missing target with
`{"error":"Target 'x' not found", …}` plus `risk: UNKNOWN`; printing only the UNKNOWN reads
as "nothing calls it". The renderer prints the error verbatim and adds "this symbol is not
in the index — refresh it and ask again".

The lists themselves are bounded (12 callers, 6 processes, 12 definitions) but the counts
are always real, and a cut list says how many entries it left out.

**An answer from a stale index says so first.** Before rendering, the tool asks the same
gate the panel uses; if the index is behind, one sentence is prepended:

```text
索引落后：自 99c1e78 起 16 个文件已改（14 改 / 2 增 / 0 删），以下结果可能过期；建议增量刷新。

GitNexus impact · foo
…
```

It is a sentence, not a flag, because `<prefix?>` in a text tool would be ignored. Three
rules keep it useful: a clean tree adds nothing, an unconfirmable verdict uses its own
wording (`索引新鲜度无法确认…`) instead of borrowing "stale", and `gitnexus_delta` does not
prefix itself — it already is that answer.

`graphTools: false` withdraws the three tools entirely and keeps `gitnexus_coverage` and
`gitnexus_delta`, which spawn nothing.


Search has two modes:

- **graph** — the normal path. The host does not load native `lbug` itself; it starts
  `lib/bin/search-helper.js` under system Node, which matches a symbol's name and file path
  against the graph and returns the exact symbol and line range. Separately, the helper asks
  the index's own FTS (`file_fts`) for source text, so a query also finds files whose body
  mentions the term. Body matches arrive as file-level hits with no line range, because only
  the graph knows symbol boundaries. When the index was built with `--skip-fts`, or the FTS
  extension cannot load, the helper still answers with names and paths and the panel says
  which of the two scopes ran; the graph query is retried once without FTS before the run
  fails.
- **text** — the fallback when the graph query cannot start. It reads the files listed in
  the index manifest, matches lines, searches code before docs, and caps files/bytes/
  matches. The panel labels it 源码关键词（回退）.

Clicking a hit calls
`ctx.sidebarRight.openResourceIn(sessionId, address, { params: { line } })` to open the
platform file viewer at that line; without that service it falls back to copying the path.

## Troubleshooting

Start with the state the panel reports: `GitNexus absent`, `no index`, `index stale`,
`FTS unavailable`. The rows below cover this plugin's boundary; the linked upstream
GitNexus path owns the rest.

| Symptom | What to do here | Upstream GitNexus path |
| --- | --- | --- |
| The panel says GitNexus is absent | Install it yourself, or use the panel's install. For a non-standard location set `GITNEXUS_CLI=/path/to/gitnexus/dist/cli/index.js`. | [`gitnexus/README.md` — Requirements](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#requirements), [Quick Start](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#quick-start) |
| The project has no index | Use **初始化索引** in the panel, or run `gitnexus analyze --index-only <repo>`. For a folder that is not a git repository the panel's command adds `--skip-git` (upstream requires it); the resulting index has no commit baseline and no incremental refresh. | [`README.md` — CLI Reference](https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md#cli-reference), [`RUNBOOK.md` — Index out of date](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#index-out-of-date--stale-tools) |
| A subdirectory has an index but the switcher does not list it | The search only goes **down** from the current workspace, never up or to siblings. It skips hidden directories, `node_modules` and build output, and has depth/count/time limits. Confirm `<workspace>/<child>/.gitnexus/gitnexus.json`; if the index is in a skipped or very deep directory, open that directory as the workspace. Multiple projects appear in the header switcher, including git projects without an index; a truncated search is labelled as such. | This plugin's discovery; no upstream GitNexus path. |
| Refresh fails, `spawn EPERM`, or the index stays `incremental-in-progress` | The panel's command already sets `GITNEXUS_MEMORY=off`, `NODE_OPTIONS=--max-old-space-size=8192`, `GITNEXUS_HOME=<repo>/.gitnexus/plugin-home` and `--index-only`. If the sandbox still refuses, run the copied command in your own shell; the plugin will not escalate. | [`RUNBOOK.md` — LadybugDB / lock errors](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#ladybugdb--lock-errors), [Memory / analyze crashes](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#memory--analyze-crashes) |
| Refresh fails with `EPERM … mkdir` or `rmdir '<repo>\.gitnexus\parsedfile-store'` | GitNexus deletes this run-scoped store at the start of every parse, and a parse worker creates it again during the parse — both directions can be refused. Two causes, both addressed in 0.1.4: the plugin no longer pre-creates the directory (that was 0.1.3's `rmdir`), and the analyzer's shell call now carries the **repository** as its sandbox workspace root. A panel route has no session, so the sandbox used to fall back to the DSH application directory, whose write capability is a different identity — the repository's write grant never applied. If it still fails, the deployment's mode is read-only: run the copied command in a normal terminal. | [`RUNBOOK.md` — LadybugDB / lock errors](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#ladybugdb--lock-errors), [`RUNBOOK.md` — Clean slate](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#clean-slate-corrupt-or-huge-gitnexus) |
| Windows reports `windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\Program Files\DSH Desktop)` | The ACL sandbox failed to grant write on the **workspace root**; `D:\Program Files\DSH Desktop` is the DSH application directory, not a project. Since 0.1.5 the search/graph helpers use `<repo>/.gitnexus` as the policy root, and the installer uses the plugin prefix; a failed install returns the copyable command. If an ordinary **shell command** still fails this way, the session workspace itself is the install directory: open a writable project. Do not add ACL grants to Program Files. | This plugin's policy-root fix; the DSH sandbox itself has no upstream GitNexus path. |
| Incremental analyze hangs, or the database reports `Maximum database size … has been reached` | Use **全量重建** (`--force`), or the clean-slate steps. | [`RUNBOOK.md` — Clean slate](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#clean-slate-corrupt-or-huge-gitnexus), [`gitnexus/README.md` — Troubleshooting](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#troubleshooting) |
| Refresh fails with `EPERM … open '<repo>\.gitnexus\lbug.init.lock'` or `unable to acquire init lock` | A transient file lock, not a permissions problem: the ACL for `.gitnexus` was checked on the machine that reported it and came back healthy. GitNexus's first write is that lock, and a scanner, the indexer, or a crashed run can hold it. The plugin clears a stale lock and retries once automatically (the run shows `attempts: 2`). If it still fails, wait a moment and retry, or run the copied command in a normal terminal. | This plugin's retry plus the analyzer's own lock file; no upstream GitNexus path. |
| Search fails with `A dynamic link library (DLL) initialization routine failed` / `lbugjs.node` | Graph search runs in `lib/bin/search-helper.js`, never in the Electron host. Restart DSH after upgrading and keep `node` on the shell PATH. If the helper cannot start at all, search falls back to source text. | [`gitnexus/README.md` — Troubleshooting](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#troubleshooting) |
| Windows search returns very few hits, or the panel warns FTS is unavailable | Read `capabilities.fts` in `.gitnexus/meta.json` first: `status: "unavailable"` is a record written when the index was built, and it can be **stale** — measured here, the record said unavailable while `gitnexus doctor` reported `Full-text search: available` and the extension files were present. **修复搜索索引（FTS）** (`analyze --repair-fts`) rewrites that record and the search indexes without touching the graph; the panel then reports what it actually searched instead of repeating the manifest. Other causes, in order: the index was built with `--skip-fts`; the repair could not run out of process because the sandbox refuses the spawn (`spawn EPERM` — run the copied command in a terminal); or the extension genuinely cannot load, which is a missing Windows runtime (VC++ 2015-2022 x64 and OpenSSL 3) — the rarest of the four, and worth confirming rather than assuming. | [`gitnexus/README.md` — Windows: full-text search unavailable](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#windows-full-text-search-unavailable), [Analyze warns about unavailable FTS](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#analyze-warns-about-unavailable-fts-or-vector-extensions) |
| The refresh button says 无需刷新 and is disabled | That is the Tier 0 verdict, not a failure: every file the index recorded still hashes the same, so re-running the analyzer would change nothing. **仍然刷新** forces it anyway (useful after a schema or GitNexus upgrade). If the index recorded no commit baseline, the panel does **not** claim 无需刷新 — it says it cannot confirm and leaves the button enabled. | This plugin's delta engine; no upstream GitNexus path. |
| The gate says 无法确认 instead of 无需刷新 | The index recorded no commit. Since 0.1.8 the plugin writes the current commit back into the manifest's `lastCommit` (and the registry entry that run used) **after a refresh it started itself succeeds**, so a refresh under the sandbox ends up saying 已是最新 too. It does **not** write when the working tree is dirty — recording a commit that excludes those edits would make the gate claim 已是最新 falsely; the panel then says there are N uncommitted changes and to refresh after committing. Three cases still need a terminal: the index was built elsewhere, the directory is not a git repository, or the repository has no commits yet. The write-back only fills an empty field and never overwrites an existing baseline. | This plugin's delta engine plus the analyzer's git access; no upstream GitNexus path. |
| The graph card, or a tool answer, opens with 索引落后 | That sentence is generated from the same gate the refresh button uses: the commit it names is the index's recorded baseline, the count is content hashes that no longer match, and the suggestion is the gate's own `none` / `incremental` / `reanalyze` / `rebuild` / `init`. Clear it by refreshing the index (panel or CLI) — committing alone does not make the index fresher, it only stops new files from being counted. Since 0.1.10 it is cached for 5 seconds, so a refresh is reflected almost immediately; an index that recorded no commit says 无法确认 and never borrows this sentence. | This plugin's delta engine and `freshness.ts`; no upstream GitNexus path. |
| A coverage gate fails the pipeline with exit 3 | Read stderr: `未入索引` means the analyzer would index files the index does not hold (refresh it); `索引缺失` means the target has no `.gitnexus/gitnexus.json` (initialize it, or drop `--fail-on-missing` for a repository you only scan); `索引过陈旧` means the index describes paths that no longer exist (refresh or rebuild). Exit **2** is the older `--fail-on-large` (a file was skipped for size) and is a different problem. `--json` is unaffected because the reasons go to stderr. | This plugin's `coverage-gate.ts`; upstream owns which files get skipped. |
| The commit timeline is one column although the repository has branches | The timeline reads `git log --all` but only within the window you picked (7/14/30 days, at most the 300 most recent commits), so a branch whose commits are all older contributes no column, and a branch that was merged may show only its merge point. One column is also the correct answer for linear history — the width is evidence about the window, not about the repository. Past six columns the folded ones are counted as `+N` on each row. | This plugin's git log reader; no upstream GitNexus path. |
| `analyze` stops with `Storage path is in state "unowned" but requires one of: missing, empty, owned` | GitNexus 1.6.13 inspects `.gitnexus` before writing and refuses one that holds anything besides its own lock artifacts with no `gitnexus.json` / `meta.json`. The usual leftover is this plugin's redirected `GITNEXUS_HOME` (`plugin-home`) from a run that never wrote a manifest. Since 0.1.11 the plugin creates nothing in `.gitnexus` until a manifest exists and removes the redirect after a failed run, so a rerun fixes itself; for a directory that is already unowned, delete `.gitnexus/plugin-home` or press **全量重建** — `--force` is the only write upstream allows against that state, and it rebuilds the graph. | Upstream's storage ownership check; this plugin's `plugin-home` redirect is what usually creates the state. |
| The panel says git is unavailable, and the activity/file-history cards are empty | Up to 0.1.7 every git call captured output through a **pipe**, which a confined host (the DSH sandbox, a Windows service whose children run under a restricted token) refuses with `spawn EPERM` — read as "git is not installed". Since 0.1.8 every git call writes the child's output to a file and reads it back (`src/gitnexus/git-capture.ts`); stdout and stderr are captured separately so git's `LF will be replaced by CRLF` warning cannot leak into a list of file names. The capture tries the host's own spawner first and falls back to the file descriptor when that cannot reach git — and the scratch files live inside the workspace (`<repo>/.gitnexus/plugin-home/tmp`), because a host process is often the one component that may not write to the system temp directory. When all of it fails, the verdict now names the reason (`git rev-parse HEAD → EPERM`, `… → exit 128`): no git, no repository and a refused spawn are three different problems. | This plugin's subprocess capture; no upstream GitNexus path. |
| The graph card is empty, or fails with 404 | A 404 means the host predates `/api/gitnexus/graph` — restart DSH, not just the page. An empty canvas with a message means the index has no communities yet (an old index), or the store is busy: refresh the index. Nodes are capped by design; the card states how much it left out. | This plugin's host route; graph data itself comes from the GitNexus index. |
| The graph loads for some projects but spins or returns 504 for others | On Windows the ACL sandbox's first workspace grant propagates an inheritable ACE across the whole repository, which can exceed the 25 s helper timeout on a large tree; a project whose grant is already cached is fast. Since 0.1.5 the search/graph helpers root the policy at `<repo>/.gitnexus`, so the grant covers only the index; restart DSH. If it still fails, confirm `.gitnexus/lbug` exists and that no analyze is holding the index. | This plugin's sandbox policy root; graph data itself comes from the GitNexus index. |
| The 3D view will not open, or its overlay stays blank | Read the card first: `unavailable` means the host has no shell executor or the machine has no `gitnexus` CLI (the card prints the install command); `failed` carries the child process's own output, where a busy port (`EADDRINUSE`) and an index written by another CLI version (`database file version`) are the two common cases. `服务在跑，但索引对不上` means the server on that port does not list this repository in its registry: refresh this repository's index, or stop the server you started yourself. A missing card or a 404 means the host never mounted the route — restart DSH. | This plugin's web-view lifecycle; the SPA is the `web/` directory inside the GitNexus package. |
| The AI settings inside the 3D view are still empty | The **AI 设置** line on the card names the reason: no `GITNEXUS_PLUS_AI_*` variables set (export them and restart DSH or press **重新启动**), a partial set (`缺少 GITNEXUS_PLUS_AI_MODEL` / `缺少 GITNEXUS_PLUS_AI_API_KEY`), or `外部启动的服务` — that server was not started by the plugin, so its page cannot be seeded and the dialog has to be filled once by hand. The variables are read from the DSH process environment, so a restart is required after changing them. | This plugin's generated page (`GITNEXUS_WEB_DIST`); the SPA keeps its own settings in `sessionStorage`. |
| Clicking a search hit does not open a file | The click uses `ctx.sidebarRight.openResourceIn`; a profile without that service falls back to copying `path:line`. Restart DSH; if it persists, use the Copy button. | This panel/DSH boundary; no upstream GitNexus path. |
| The file timeline fails with 404/401 | The client hot-reloaded before the host did, so `/api/gitnexus/file-history` is not mounted yet. Restart DSH (not just refresh the page). | This plugin's host route; no upstream GitNexus path. |
| 切换分支失败 / 分支下拉不出现 | 下拉只在面板拿到报告、且项目有多个本地分支时出现。失败信息是 git 的原话：工作树有未提交改动（`Your local changes … would be overwritten`）、rebase 进行中、或分支名写错都会拒绝切换；面板不会 stash、不会丢弃改动。切换成功后索引仍是旧分支构建的那份，报告会以「索引不是当前分支构建的」标出，重建是另一个显式动作。`dubious ownership` 时面板会对该路径重试一次（等价于给这一个目录加 `safe.directory`，不写全局配置）。 | This plugin's host route; no upstream GitNexus path. |
| Analyze runs out of memory | Keep the panel's `NODE_OPTIONS` / `GITNEXUS_MEMORY` settings, or raise the heap manually; the index may need a full rebuild. | [`gitnexus/README.md` — Analysis runs out of memory](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#analysis-runs-out-of-memory), [`RUNBOOK.md` — Memory / analyze crashes](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#memory--analyze-crashes) |
| A large file is missing from the graph | This is what the panel reports: size/share, generated/minified heuristics, binary detection. Raising the cap is an upstream analyze option; this plugin only reports the skip. | [`gitnexus/README.md` — Large files are being skipped](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#large-files-are-being-skipped) |
| Native install fails (`@ladybugdb/core`, `tree-sitter-*`) | The plugin runs `npm install --prefix …`; it needs a C++ toolchain and a reachable registry. Run the manual command from **Getting GitNexus** to see the compiler error. | [`gitnexus/README.md` — Installation fails with native module errors](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#installation-fails-with-native-module-errors) |
| The panel does not appear at all | Check that `dsh plugin add` succeeded and DSH was restarted; open it from the sidebar's **+** guide page. For the `desktop` profile, use the Web Plugins page. | This plugin's install path; no upstream GitNexus path. |

## Upstream GitNexus documentation

This README describes the plugin, not GitNexus. GitNexus behavior follows its source docs.
Repository: [`abhigyanpatwari/GitNexus`](https://github.com/abhigyanpatwari/GitNexus)
(branch `main`).

| Topic | Path |
| --- | --- |
| Install, CLI, environment variables, MCP | [`README.md`](https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md) |
| CLI package, requirements, full Troubleshooting | [`gitnexus/README.md`](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md) |
| Index stale, clean slate, locks, memory | [`RUNBOOK.md`](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md) |
| Architecture and data flow | [`ARCHITECTURE.md`](https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md) |
| Tests and guardrails | [`TESTING.md`](https://github.com/abhigyanpatwari/GitNexus/blob/main/TESTING.md), [`GUARDRAILS.md`](https://github.com/abhigyanpatwari/GitNexus/blob/main/GUARDRAILS.md) |
| CLI command reference | [`gitnexus/skills/gitnexus-cli.md`](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/skills/gitnexus-cli.md) |
| Language-specific notes | [`docs/languages/`](https://github.com/abhigyanpatwari/GitNexus/tree/main/docs/languages) |

Local `.docs/` notes are gitignored; the links above are the published source of truth.

## Maintenance commands

The panel shows and runs more than a bare `gitnexus analyze`:

```powershell
$env:GITNEXUS_MEMORY='off'; $env:NODE_OPTIONS='--max-old-space-size=8192'; `
  $env:GITNEXUS_HOME='<repo>/.gitnexus/plugin-home'; `
  gitnexus analyze --index-only '<repo>'
```

Add `--force` for a full rebuild, or `--repair-fts` alone to rebuild the search indexes
without touching the graph (the panel offers that as **修复搜索索引（FTS）** when the index
reports FTS as unavailable). A folder without `.git` also gets `--skip-git`.

- `--skip-git` — GitNexus refuses a directory without `.git` even when its path is
  explicit; this flag indexes the folder directly. The index then has no commit baseline,
  no incremental refresh and no Git activity, and the panel says so.

- `GITNEXUS_MEMORY=off` — stops the CLI from re-spawning itself over piped stdio, which a
  confined sandbox denies (`spawn EPERM`).
- `NODE_OPTIONS=--max-old-space-size=8192` — supplies the heap that respawn wanted.
- `GITNEXUS_HOME` — redirects the global registry write into the project, so a failed
  write to `~/.gitnexus` cannot leave the index stuck at `incremental-in-progress`.
- `--index-only` — otherwise `analyze` rewrites `AGENTS.md`, `CLAUDE.md` and skill files
  inside the repository.

`--skip-fts` is **adaptive per index**: no flag when the manifest says FTS is available,
and the flag when it is not. `skipFts: true` can force the flag; there is no config that
forces FTS on, because enabling it is a repair (`gitnexus analyze --repair-fts`), not an
incremental refresh — so the panel exposes it as its own action, and a repair run never
carries `--skip-fts` (the CLI accepts that pair and exits 0 having done nothing).

### AI settings for the embedded web UI

The embedded GitNexus SPA has its own chat, and its AI settings are stored per tab. Export
these in the environment DSH starts from, and the panel seeds them whenever it starts the
server:

| Variable | Meaning |
| --- | --- |
| `GITNEXUS_PLUS_AI_PROVIDER` | One of `openai`, `gemini`, `anthropic`, `azure-openai`, `ollama`, `openrouter`, `minimax`, `glm`, `deepseek`. Common aliases are accepted (`google`, `claude`, `azure`, `z.ai`, `open-ai`). |
| `GITNEXUS_PLUS_AI_API_KEY` | The provider key. Not needed for `ollama`. |
| `GITNEXUS_PLUS_AI_MODEL` | Model id as the provider spells it, e.g. `gpt-4o-mini`, `gemini-2.0-flash`, `llama3.2`. |
| `GITNEXUS_PLUS_AI_BASE_URL` | Optional. OpenAI-compatible endpoint, Azure endpoint (required for `azure-openai`), or Ollama host. |

Nothing is sent over the network to configure this: the page the server hands out seeds
`sessionStorage` inline, before the SPA's module script runs. With none of the variables
set the dialog is left exactly as it was, and the card says so. A partial set (say,
provider and model but no key) is reported on the card and the server still starts, so a
typo never costs you the 3D view.

## License (read before commercial use)

This plugin is **MIT** (see [LICENSE](LICENSE); the scope of that grant, and the part
it does not cover, is in [NOTICE.md](NOTICE.md) — `LICENSE` deliberately holds nothing
but the standard text, because a licence file with an appendix is detected as "Other").

**GitNexus is `PolyForm-Noncommercial-1.0.0`**: noncommercial use is granted, commercial
use is restricted. `gitnexus` is a **peer**; this package does not install, bundle or
redistribute it. But using this plugin's GitNexus-backed features (reading an index,
refreshing it, installing it) puts **your use of GitNexus** under GitNexus's license;
commercial use needs a separate grant from GitNexus's author:

<https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE>

In one line: **MIT covers this plugin's code; GitNexus's license covers GitNexus, and using
the related features puts that use under it.**

## Boundaries

- Coverage and search are read-only; maintenance is a separately confirmed write and
  never starts by itself.
- The refresh gate compares content hashes of the files the index recorded. It cannot
  see a change the analyzer would make for its own reasons (a schema upgrade, a new
  feature mode); **仍然刷新** exists for exactly that case.
- The commit graph is bounded on purpose: a 7/14/30-day window, at most the 300 most
  recent commits across all refs, six drawn columns and 40 files per commit. `+N` and
  「仅列出前 40 个文件」 name what was folded; a missing column or file is evidence about
  the window, not proof that it never existed.
- The staleness sentence is advisory. It never blocks a query, a refresh or a commit, and
  it is cached for 5 seconds — so a refresh can be visible slightly before the sentence
  disappears, and a just-committed change can still be reported for a moment.
- A coverage gate judges only what the analyzer would include. A file it would never index
  (no extension, generated, over the size cap) is reported as `excluded` and does **not**
  trip `--fail-on-uncovered`; a gate that fired on those would be permanently red.
- The graph view draws communities by default, not every symbol: the overview is the
  community graph, and a drill-down shows at most the configured node budget of one
  community's members. The **Symbol view** is a bounded all-symbol projection ordered by
  file and explicitly truncated, not a claim of completeness. Both say when they are
  truncated.
- The 3D view is a second process, started on demand: it needs the `gitnexus` CLI on the
  machine and, on a host with no shell executor, only the manual command is offered.
  Embedding is display-only — the iframe is another origin, so the panel cannot script
  into it; select things in the SPA itself, or open it in its own tab.
- A server started by hand on the configured port is adopted only when its registry lists
  this repository; otherwise the plugin tries the next port rather than killing it. The
  card says which case it is in. An adopted server keeps its own page, so the AI settings
  cannot be seeded into it — fill the dialog once by hand there.
- The seeded AI settings live in `sessionStorage`, exactly like hand-entered ones: the
  SPA clears them when the tab closes, and the plugin re-seeds them on the next start.
  Nothing is written to the repository or to `~/.dsh` beyond the generated page, which is
  deleted when the server stops.
- The plugin reports facts about a GitNexus index; it does not rewrite the parser or
  reimplement the graph database.
- Graph search answers with two scopes: symbol names and file paths from the graph, and
  source text from the index's own FTS. Body hits are file-level and carry no line range,
  and the footer states which scope ran. The text fallback matches lines and is capped.
- The source fallback only covers files in the index manifest; refresh the index for new
  files.
- An index built with `--skip-git` has no commit baseline: the gate can only say it cannot
  confirm, a refresh re-analyses the whole folder, and the Git activity cards do not
  appear.
- The workspace search is **bounded**: 12 levels, 4000 directories and 2 seconds by
  default; it skips `node_modules`, build output and every hidden directory, and does not
  follow symlinks. Indexed projects are preferred by default; unindexed git projects are
  listed and can be initialized. An indexed or `.git` directory stops the descent. When a
  bound stops the search the panel says it may have missed a project.
- Deeper design/build notes are kept out of the public README; this file stays at the
  "what it does" and "how to fix it" level.
