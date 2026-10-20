# dsh-gitnexus-plus

**English** · [简体中文](README-CN.md)

**Current release: [0.1.4](https://github.com/Moowningstar/gitnexus-plus/releases/tag/v0.1.4)** ·
[npm](https://www.npmjs.com/package/dsh-gitnexus-plus) ·
[Issues](https://github.com/Moowningstar/gitnexus-plus/issues)

[What it does](#what-it-does) · [Install](#install) · [Troubleshooting](#troubleshooting) ·
[Upstream GitNexus docs](#upstream-gitnexus-documentation)

A DeepSeek Harness plugin: see what a GitNexus index **covers and what it leaves out**,
decide whether a refresh is worth running, browse the graph, refresh it from the sidebar,
and search its symbols by keyword.

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
  applied by the host, and the view states what it left out.
- **Index coverage** — lists the oversized files `gitnexus analyze` skipped, with size,
  language share, and generated/minified signals.
- **Index freshness** — indexed commit vs `HEAD`, classified `current` / `behind` /
  `diverged` / `unknown`, plus the uncommitted-change count.
- **Graph composition** — nodes, edges, communities, processes, embeddings, edges per node.
- **Git activity × index** — recent commits, authors, branches and most-changed files,
  each file marked **indexed**, **excluded by design**, or **missing from the index**.
  Includes an activity × index cross-tab, a baseline review against the indexed commit
  (or the activity-window start when the index recorded none), a 7/14/30-day commit
  timeline, and a per-file timeline when a file row is clicked.
- **Language distribution** — bytes split into languages GitNexus can parse, formats it
  only recognizes, and everything else. Without GitNexus, a built-in extension map keeps
  the breakdown useful and marks it `builtin`, never "parsed".
- **Keyword search** — matches graph node `name` / `filePath`, returns kind, path and line;
  clicking a hit opens the file at that line, and a separate Copy button copies
  `path:line`.
- **Source fallback** — when the graph helper cannot start (no usable shell sandbox,
  DLL/ABI, busy index), a bounded line search over the indexed files returns
  `mode: "text"` instead of pretending to be the graph.
- **No-index visibility** — a git project without an index shows a scan overview,
  language split and the initialize command instead of an empty panel.
- **Maintenance** — initialize, incremental refresh and full rebuild (`--force`) run
  through DSH's shell executor, with no self-escalation. When the index reports FTS as
  unavailable, a **修复搜索索引（FTS）** action runs `analyze --repair-fts` — the search
  indexes only, without re-analysing the repository.

## Install

Requirements:

- DSH `>=0.2.0-rc.2 <0.3.0`
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

The panel reports the project the current workspace points at; it has no global
repository list. Its bound is a project root (a `.gitnexus` index or a `.git` marker), so
it cannot become a filesystem probe.

Inside DSH:

- tool `gitnexus_coverage`: `{ repo, includeLanguages? }`
- tool `gitnexus_delta`: `{ repo }` — would a refresh change anything?
- route `GET /api/gitnexus/coverage?repo=<project>`
- route `GET /api/gitnexus/search?repo=<project>&q=<keyword>&limit=20`
- route `GET /api/gitnexus/file-history?repo=<project>&path=<file>&days=7` — one file's
  bounded commit timeline
- route `GET /api/gitnexus/delta?repo=<project>` — Tier 0 comparison against the index
- route `GET /api/gitnexus/graph?repo=<project>&view=communities|community&id=<community>`
  — a bounded graph projection
- route `POST/GET/DELETE /api/gitnexus/analyze` (the only entry that changes an index;
  `force=1` for a full rebuild, `mode=repair-fts` for the search indexes only)
- right-sidebar tab `gitnexus`

CLI:

```sh
npm run build
node lib/bin/gitnexus-coverage.js <repo-path>
node lib/bin/gitnexus-coverage.js -r material-ui         # by registry alias
node lib/bin/gitnexus-coverage.js --all --json           # every indexed repository
node lib/bin/gitnexus-coverage.js <repo> --fail-on-large # CI gate, exit 2
npm run check
npm test
```

Search has two modes:

- **graph** — the normal path. The host does not load native `lbug`; it starts
  `lib/bin/search-helper.js` under system Node and searches node names and file paths. It
  does not search bodies, so it works on an index built with `--skip-fts`.
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
| The project has no index | Use **初始化索引** in the panel, or run `gitnexus analyze --index-only <repo>`. | [`README.md` — CLI Reference](https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md#cli-reference), [`RUNBOOK.md` — Index out of date](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#index-out-of-date--stale-tools) |
| Refresh fails, `spawn EPERM`, or the index stays `incremental-in-progress` | The panel's command already sets `GITNEXUS_MEMORY=off`, `NODE_OPTIONS=--max-old-space-size=8192`, `GITNEXUS_HOME=<repo>/.gitnexus/plugin-home` and `--index-only`. If the sandbox still refuses, run the copied command in your own shell; the plugin will not escalate. | [`RUNBOOK.md` — LadybugDB / lock errors](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#ladybugdb--lock-errors), [Memory / analyze crashes](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#memory--analyze-crashes) |
| Refresh fails with `EPERM … mkdir` or `rmdir '<repo>\.gitnexus\parsedfile-store'` | GitNexus **deletes** this run-scoped store at the start of every parse and recreates it when it needs one. 0.1.3 pre-created it, which turned each refresh into a directory delete under the sandbox — the `rmdir` EPERM reported against that version. Since 0.1.4 the plugin removes a leftover instead and creates only the durable caches (`parsedfile-cache`, `parse-cache`). If a run still reports `rmdir` on it, the directory was briefly locked: run the refresh again. If it reports a write denial, the sandbox token cannot write `.gitnexus`; run the copied command in a normal terminal. | [`RUNBOOK.md` — LadybugDB / lock errors](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#ladybugdb--lock-errors), [`RUNBOOK.md` — Clean slate](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#clean-slate-corrupt-or-huge-gitnexus) |
| Incremental analyze hangs, or the database reports `Maximum database size … has been reached` | Use **全量重建** (`--force`), or the clean-slate steps. | [`RUNBOOK.md` — Clean slate](https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md#clean-slate-corrupt-or-huge-gitnexus), [`gitnexus/README.md` — Troubleshooting](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#troubleshooting) |
| Refresh fails with `EPERM … open '<repo>\.gitnexus\lbug.init.lock'` or `unable to acquire init lock` | A transient file lock, not a permissions problem: the ACL for `.gitnexus` was checked on the machine that reported it and came back healthy. GitNexus's first write is that lock, and a scanner, the indexer, or a crashed run can hold it. The plugin clears a stale lock and retries once automatically (the run shows `attempts: 2`). If it still fails, wait a moment and retry, or run the copied command in a normal terminal. | This plugin's retry plus the analyzer's own lock file; no upstream GitNexus path. |
| Search fails with `A dynamic link library (DLL) initialization routine failed` / `lbugjs.node` | Graph search runs in `lib/bin/search-helper.js`, never in the Electron host. Restart DSH after upgrading and keep `node` on the shell PATH. If the helper cannot start at all, search falls back to source text. | [`gitnexus/README.md` — Troubleshooting](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#troubleshooting) |
| Windows search returns very few hits, or the panel warns FTS is unavailable | The index was built with `--skip-fts`, or the FTS extension cannot load. Keyword search still matches names and paths; the source fallback matches lines. The panel then offers **修复搜索索引（FTS）**, which runs `analyze --repair-fts` and leaves the graph alone. If the extension file itself is missing, the repair fails too — installing it is upstream. | [`gitnexus/README.md` — Windows: full-text search unavailable](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#windows-full-text-search-unavailable), [Analyze warns about unavailable FTS](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/README.md#analyze-warns-about-unavailable-fts-or-vector-extensions) |
| The refresh button says 无需刷新 and is disabled | That is the Tier 0 verdict, not a failure: every file the index recorded still hashes the same, so re-running the analyzer would change nothing. **仍然刷新** forces it anyway (useful after a schema or GitNexus upgrade). If the index recorded no commit baseline, the panel does **not** claim 无需刷新 — it says it cannot confirm and leaves the button enabled. | This plugin's delta engine; no upstream GitNexus path. |
| The gate says 无法确认 instead of 无需刷新 | The index recorded no commit, so the comparison can only see the working tree. A confined analyze cannot start `git`, which is how the manifest ends up with an empty `lastCommit` — measured here: the same command writes it in a normal terminal and leaves it empty under the sandbox. Run the copied command outside the sandbox once if you want the stronger verdict; the refresh button stays usable either way. | This plugin's delta engine plus the analyzer's git access; no upstream GitNexus path. |
| The graph card is empty, or fails with 404 | A 404 means the host predates `/api/gitnexus/graph` — restart DSH, not just the page. An empty canvas with a message means the index has no communities yet (an old index), or the store is busy: refresh the index. Nodes are capped by design; the card states how much it left out. | This plugin's host route; graph data itself comes from the GitNexus index. |
| Clicking a search hit does not open a file | The click uses `ctx.sidebarRight.openResourceIn`; a profile without that service falls back to copying `path:line`. Restart DSH; if it persists, use the Copy button. | This panel/DSH boundary; no upstream GitNexus path. |
| The file timeline fails with 404/401 | The client hot-reloaded before the host did, so `/api/gitnexus/file-history` is not mounted yet. Restart DSH (not just refresh the page). | This plugin's host route; no upstream GitNexus path. |
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
reports FTS as unavailable).

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

## License (read before commercial use)

This plugin is **MIT** (see [LICENSE](LICENSE)).

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
- The graph view draws communities, not every symbol: the overview is the community
  graph, and a drill-down shows at most the configured node budget of one community's
  members. Both say when they are truncated.
- The plugin reports facts about a GitNexus index; it does not rewrite the parser or
  reimplement the graph database.
- Graph search matches names/paths, not bodies; the text fallback matches lines and is
  capped.
- The source fallback only covers files in the index manifest; refresh the index for new
  files.
- Deeper design/build notes are kept out of the public README; this file stays at the
  "what it does" and "how to fix it" level.
