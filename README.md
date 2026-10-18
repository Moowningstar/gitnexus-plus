# dsh-gitnexus-plus

A DeepSeek Harness plugin for **GitNexus index visibility** — starting with the part
GitNexus itself cannot tell you: **what the index left out**.

## The problem it solves

`gitnexus analyze` silently drops files. Its entire surface for saying so is one
line on stderr, printed once:

```
  Skipped 3 large files (>512KB, likely generated/vendored)
    - dist/app.min.js
    ...and 2 more (set GITNEXUS_VERBOSE=1 to list them all)
```

That line is not returned, not persisted, not queryable, and gone when the terminal
scrolls. Meanwhile the files it names can be the difference between an index that
represents your codebase and one that does not — measured on this machine,
`material-ui` skips 4.4 MB (12.4 % of scanned bytes), and those files contribute
**zero** symbols to the graph.

This plugin turns that line into data, a tool, and a route.

## What this project is, and what it is not

[GitNexus](https://github.com/abhigyanpatwari/GitNexus) is a code-intelligence engine by
**Abhigyan Patwari**. It parses a repository into symbols, relationships and execution
flows and writes them to a local graph database. It is a genuinely good piece of work,
and this project would have nothing to show without it.

What GitNexus does not give an everyday user is **visibility** and **automation**:

- **Visibility** — how much of the repository does the index actually cover? Which files
  were skipped for being too large? Has the index fallen behind `HEAD`, and by how much?
  The CLI does not answer those unasked, and the answer is invisible exactly when it
  matters.
- **Automation** — once an index is stale, somebody has to remember to refresh it.

**This project is a layer that adds those two things and nothing else.** It reads the
index GitNexus wrote, reports what the index left out, and can start an incremental
refresh through GitNexus's own CLI.

It does **not**:

- fork GitNexus, patch it, or reimplement its parser or graph database;
- redistribute GitNexus source. Nothing from that project is inside this package's
  tarball — `gitnexus` is installed by npm as a separate dependency and stays separate;
- claim authorship of, or any contribution to, GitNexus. All rights in GitNexus belong
  to its author;
- replace GitNexus. With no GitNexus index there is nothing here to display.

## Licence — read this before a commercial use

This project is **MIT** (see [LICENSE](LICENSE)).

**It depends on GitNexus, which is `PolyForm-Noncommercial-1.0.0`.** That licence grants
noncommercial use and restricts commercial use. Because installing this plugin installs
GitNexus as a dependency:

- **your use of this plugin's GitNexus-backed features is subject to GitNexus's
  licence**, not to this project's MIT grant;
- **commercial use requires a separate grant from GitNexus's author.** If your use is
  commercial, read
  <https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE> or contact the author
  before relying on any of it.

This project cannot and does not change that: it only calls the interfaces GitNexus
provides. The read-only half — reading `.gitnexus/gitnexus.json` and reporting on it —
is this project's own code and carries no GitNexus code, but it also has nothing to
report on unless GitNexus produced that file.

A one-line summary: **the MIT licence here covers my code; GitNexus's licence covers
GitNexus, and installing this plugin installs GitNexus.**

## What it reports

- **Skipped large files** — path, size, share of its language, and two independent
  signals for *why* it is not source: a single-line (minified) heuristic, and a
  build-output path heuristic. Binary assets are detected separately and never
  called minified.
- **Index freshness** — the indexed commit against HEAD, classified `current` /
  `behind` / `diverged` / `unknown` the same way `gitnexus status` does, plus the
  uncommitted-change count.
- **Graph composition** — nodes, edges, communities, processes, embeddings, and
  edges-per-node, all read from the manifest.
- **Query surfaces** — which of graph / keyword search / semantic search are
  actually available, with the reason when one is not. An index with no FTS cannot
  answer keyword queries, and hiding that is how a reader concludes otherwise.
- **Git activity, crossed with the index** — recent commits, authors (bots marked),
  branches, most-changed files and most-recent files, each carrying a three-way
  verdict: *indexed*, *excluded by design*, or **missing from the index**. That last
  one is the point: of the files people are actively editing, which does the graph
  not see?
- **Language distribution by bytes**, split three ways: languages GitNexus can
  *parse* into the graph, formats it merely *recognizes*, and everything else.
- **Resolver confidence** — untyped receiver sites, which make `impact` and
  `context` a lower bound rather than an exact answer.

## Why the git three-way split matters

A two-way "indexed / not indexed" count is misleading. Measured on a real
repository, 1 635 files had been touched in 90 days: 491 indexed, 1 143 absent, and
reporting that as "70 % missing" is wrong — 1 143 of them are lockfiles, dotfiles
and binary assets that no scan would select either. Exactly **one** was a genuine
gap (`src/stores/windowModeStore.ts`). The panel reports the three numbers
separately, and only the third raises a warning.


## Design commitments

**Reuse, don't reimplement.** "Which files did GitNexus skip?" has exactly one
correct answer: the set `walkRepositoryPaths` produced. This plugin deep-imports
GitNexus's own `createIgnoreFilter`, `glob` call and `getLanguageFromFilename`
rather than approximating them, and `test/run.mjs` cross-checks its scan against
`walkRepositoryPaths` on real repositories. If upstream reshapes those modules the
plugin degrades to a documented fallback scan (`ScanReport.primitives === 'fallback'`)
instead of reporting a wrong number.

**Absent is reported as absent.** The size cap an index was built under is read from
that index. Legacy indexes (`meta.json`, no `indexCoverage`) are reported with the
cap *unknown* and a note — never defaulted to today's value, which would misattribute
covered files as skipped.

**Read-only.** Nothing here triggers `analyze`, writes to `.gitnexus/`, or takes the
index lock. A status check must never start a 30-second rebuild.

## Usage

```sh
# CLI, no install
npm run build                       # tsc (host) + tsc (client) + wrap
node lib/bin/gitnexus-coverage.js <repo-path>
node lib/bin/gitnexus-coverage.js -r material-ui     # by registry alias
node lib/bin/gitnexus-coverage.js --all --json       # every indexed repository
node lib/bin/gitnexus-coverage.js <repo> --fail-on-large   # exit 2 — CI gate

# type check
npm run check

# tests
npm test
```

In DSH the plugin exposes:

- **tool** `gitnexus_coverage` — `{ repo, includeLanguages? }`
- **route** `GET /api/gitnexus/coverage?repo=<project>` — one report, plus the
  maintenance commands for that project
- **panel** — a right-sidebar tab type `gitnexus`, opened from the sidebar's **+** →
  guide page ("GitNexus 索引")

The coverage route is read-only and accepts only directories that are already GitNexus
indexes, so it cannot be turned into a filesystem probe; it is additionally
restricted to loopback peers because a third-party DSH route is unauthenticated by
default on a bare `dsh web` profile.

There is now a **second** route, `/api/gitnexus/analyze`, and it is the only one that
can change anything. It answers `POST` to start an incremental refresh, `GET` to report
where that got to, and `DELETE` to stop it. It is a separate module from the coverage
route so the read-only half keeps a method policy that cannot mutate — the shared guard
takes the accepted methods from the route rather than hard-coding one set for both. The
mutating verbs additionally pass the write guard, which refuses cross-origin requests;
loopback alone is not enough, because any page the operator visits can reach
`127.0.0.1`. See **Maintenance** below for what it will and will not do.

## TypeScript, and why the build looks the way it does

The source is TypeScript under `strict`, including `noImplicitAny`. That is not
decoration: an implicit `any` is a **silent** failure — it does not report an error,
it just makes the checker stop working exactly where it was needed. Migrating this
codebase from JS+JSDoc to real types surfaced six places where the documentation and
the code disagreed, none of which produced a runtime error until the affected branch
was reached:

| Where | JSDoc claimed | Actually |
| --- | --- | --- |
| `LargeFile.generatedHint` | `string \| null` | `boolean` — consumed as `if (x)` |
| `LargeFile.minified` | non-null | nullable, when the probe budget runs out |
| `analyzer.primitives` | `number` | a **string**, compared against `'gitnexus'` |
| `MinifiedVerdict` | a type name | **the type did not exist** |
| `activityView()` result | — | missing `truncated`, which callers read |
| `analyzeCoverage` options | 3 fields | 5 — two were undocumented |

### Two compile targets, no bundler

```
src/index.ts ───────────┐
src/gitnexus/*.ts ──────┤ tsc  (NodeNext)   → lib/**/*.js + *.d.ts    ESM
src/routes/*.ts ────────┤
src/bin/*.ts ───────────┘

src/client/index.ts ────→ tsc  (CommonJS)   → build/client/index.js
                                             ↓ text wrap (scripts/build-client.mjs)
                                             lib/client.js
```

The browser half needs no bundler because it **is** one module: its only imports are
platform baseline modules (`react`, the UI primitives) supplied by the loader's own
`require` at runtime, and it has no relative imports at all. `tsc --module commonjs`
therefore emits exactly one self-contained file, and the wrap is a text operation. A
bundler would add a dependency and a resolution graph to solve a problem this package
does not have.

`esModuleInterop` is **off** for the client target on purpose: it makes
`import * as React from 'react'` compile to a bare `const React = require("react")`,
which is precisely what the loader factory provides. With interop on, tsc injects an
`__importStar` helper that would ride along in every page load.

### `scripts/*.mjs` stays JavaScript (deliberate)

`scripts/link-runtime.mjs` runs from `postinstall`, and `scripts/build-client.mjs` is
the build driver itself. A bootstrap script **must not depend on the build it
bootstraps** — if those needed compiling, a fresh clone's `npm install` would fail
because `lib/` does not exist yet. `src/**` and `bin/**` are TypeScript; `scripts/`
is plain ESM, and that line is intentional rather than unfinished.

### Runtime packages ship no type declarations

`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/cordis` and
`@deepseek-ai/dsh-client-ui-primitives` each declare `"types": "lib/types/index.d.ts"`
in their manifest and ship no such file. Every plugin author has to write these
declarations; `types/` holds the four, with the surface limited to what this plugin
actually uses. The primitive **props** were read off real call sites in shipped
plugins rather than guessed, because a wrong prop name fails silently at runtime —
the control renders with a default and nothing reports anything.

## Client half

`src/client/index.ts` is one CommonJS module using nothing but baseline modules
(`react`), so `scripts/build-client.mjs` wraps it into the loader's factory
artifact with no bundler at all — a text wrap cannot drift from its source the way
a bundle can.

The panel splits fetching (`CoveragePanel`) from presentation (`CoverageView`).
That is not stylistic: a component that fetches cannot be rendered against a
fixture, and the states worth asserting on — a report with skipped files, one
without, an error, missing language data — are exactly the ones a fixture supplies.
`test/client.mjs` renders each of them through a minimal single-pass hooks shim.

Styling is theme-agnostic by construction: host elements only, `color` inherited,
every border derived from `currentColor`. `@deepseek-ai/dsh-client-ui-primitives` is
a baseline module but ships no JS in the installed runtime, so its exports cannot
be verified from outside — guessing at component props would fail at mount time in
a browser, where no test in this repository can see it.

## Verified end to end

Installed into the `web` profile and booted; the route answered with real data:

```
GET /api/gitnexus/coverage?repo=D:\Project\material-ui     HTTP 200
  manifest meta.json · scanned 28927 · selected 28924 · large 3 · 11 languages
  2.3 MB  packages/mui-icons-material/lib/index.js   generated
  1.4 MB  CHANGELOG.old.md
  739.9 KB packages/mui-icons-material/lib/index.mjs  generated
GET /api/gitnexus/coverage?repo=C:\Windows                 HTTP 404 (refused)
```

## Scope: the project you are in, not a global list

The panel reports **the project the session's workspace points at**. It does not
list indexed repositories and has no picker.

That is a deliberate reversal. The first design read `~/.gitnexus/registry.json`
and offered a dropdown, which made a global file a hard dependency — so a fresh
clone, a second working tree, or an index built with `GITNEXUS_HOME` redirected
could not be shown at all, which is exactly when a coverage panel is most useful.
The workspace comes from the slot's session-scoped props (`useWorkspaces` matched
by `sessionId`); the host route accepts any directory **that is already a GitNexus
index**, which is the bound that keeps it from being a filesystem probe.

## Maintenance: the refresh runs here, the escape hatches do not

Two situations the read-only half cannot resolve on its own:

- **初始化索引 / 增量刷新** — the index is missing or behind HEAD. This one the plugin
  runs for you.
- **强制全量重构** — the incremental refresh has hung. GitNexus's update path is not
  reliably terminating, and when it wedges a full rebuild is the only way out. Handed
  over as text.

**增量刷新 runs through the host's shell executor.** An earlier revision handed over
every command as text, justified by "a plugin that spawns processes bypasses the
permission system". That reasoning was wrong, and the correction is worth stating
precisely:

DSH's approval service governs **sandbox escalation** — widening the scope a session was
granted. Its audit pair must be turn-enclosed, which is why `ApprovalService.request()`
throws outside an open turn; a panel route has no turn, so it cannot ask. It also has
nothing to ask about here: this command writes `.gitnexus/` **inside the workspace**,
already within the granted scope.

Confinement is not something a caller opts into. It is what `ctx.shell` *is* in a given
deployment — `dsh-pwsh-local` exposes the argv seam that `dsh-pwsh-sandbox` wraps
through `ctx.sandbox.confine`. So routing through the executor gives this plugin exactly
the isolation your own shell commands get.

What the plugin commits to, and what is tested:

- **It never sets `sandboxPolicy`.** Requesting one would be this plugin choosing its
  own confinement — escalation, asked for through a door that cannot ask. A denial comes
  back as `denied` and **is never retried wider**.
- **One run per repository.** Two concurrent `analyze` processes contend for the same
  store, and the second reports a failure that says nothing about the repository.
- **`--index-only` always.** Without it `analyze` rewrites `AGENTS.md`, `CLAUDE.md` and
  the agent skill files in your tree — a far larger change than "refresh the index".
- **A confirmation before it starts**, stating the exact command, what it touches and
  how long it takes.
- **Cancellable**, with a ten-minute ceiling by default (`analyzeTimeoutMs`).

The full rebuild still has no button, because the host route does not implement
`--force`. A button that quietly ran something other than its label would be worse than
no button.

The commands handed over are not a bare `gitnexus analyze`, because that does not work
in every deployment:

```
$env:GITNEXUS_MEMORY='off'; $env:NODE_OPTIONS='--max-old-space-size=8192'; \
  gitnexus analyze --index-only '<project>'

$env:GITNEXUS_MEMORY='off'; $env:NODE_OPTIONS='--max-old-space-size=8192'; \
  gitnexus analyze --index-only --force '<project>'
```

- `GITNEXUS_MEMORY=off` — the CLI otherwise re-spawns itself with a larger heap over
  piped stdio, which a confined sandbox denies (`spawn EPERM`).
- `NODE_OPTIONS=--max-old-space-size=8192` — supplies the heap that respawn wanted.
- `--index-only` — the default `analyze` also rewrites `AGENTS.md`, `CLAUDE.md` and
  agent skill files inside your repository. A maintenance action must not edit the
  working tree.

`--skip-fts` is **no longer** part of either command. Measured on a 39-file repository,
disabling a search index the store already has forces a full graph-store rebuild —
179.22 s against 8.57 s, a 21× penalty on the transition an operator is most likely to
hit, and the opposite of incremental. Letting FTS fail on its own costs nothing: it
prints a warning and indexes anyway.

The panel prints these rationales next to the commands, so they do not look
arbitrary. `src/gitnexus/commands.js` is pure and asserted verbatim by tests.


The CLI cannot manage the `desktop` profile — Electron owns it. Use the Web
sidebar's Plugins page there. `web` is CLI-managed:

```sh
dsh plugin --profile web add <absolute path to this package>
dsh --profile web --dump-config | grep gitnexus-plus    # layer composes
dsh --profile web                                        # restart (bundle set changed)
```

`dsh plugin add` also adds the package to `dsh.profile.bundles` automatically,
because this package declares `dsh.bundle`.

## Known limits

- **A machine without GitNexus is not detected yet.** The plugin declares no runtime
  dependencies and never imports `gitnexus`; it reads an index another tool produced
  and, when it can, deep-imports the upstream scan primitives at runtime. That design
  keeps it a pure observer, but it makes "the operator has no GitNexus" a reachable
  state. `src/gitnexus/toolchain.ts` implements a three-state probe (`ready` /
  `library-only` / `absent`, separating "the library tree exists" from "a CLI is on
  PATH", because they gate different promises), and the refresh runner now consults it
  **before spawning anything**: with no CLI it reports `unavailable` and tells the
  operator to install one, rather than starting a process that cannot work. The engine
  also degrades correctly on its own — `scan.ts` falls back to its own walker and
  reports `primitives: 'fallback'`, and the built-in size caps apply.
- **A report that reused GitNexus's scan rules and one that fell back to an
  approximation are still not distinguished in the panel.** The probe's verdict is not
  yet carried into `CoverageReport`, so the fallback is silent: the built-in walker
  deliberately does **not** implement upstream's ignore rules faithfully, and its
  uncovered-file count can therefore carry false positives.
- **The refresh runs outside the conversation, and that has a real consequence.** A
  command started from the panel goes through `ctx.shell` and is confined exactly as
  your own shell commands are, but it is **not** a tool call: it writes no
  `approval/asked` + `approval/decided` pair into the session log, and it does not
  appear in the transcript. That pair could not be written even if it were wanted —
  `ApprovalService.request()` requires an open turn and throws without one, which is
  also why there is nothing to approve: the command does not escalate. The audit record
  is the run state the panel holds, which is per-process and is not persisted. If you
  want a refresh on the conversation's record, run the handed-over command in the
  session instead; that path is unchanged.
- **Walk cost scales with file count.** ~29 000 files takes ~1.4 s warm, ~13 s on a
  cold filesystem cache. The host half caches reports for 15 s; a panel that polls
  faster than that gains nothing.
- **The minified heuristic reads a 64 KB head and extrapolates.** It flags
  single-line bundles reliably and correctly *declines* generated-but-multi-line
  output (verified: a 2.3 MB, 75 263-line file averages 31 chars/line). The
  generated-path heuristic covers that gap, as a hint rather than a verdict.
- **Binary assets are detected and reported separately, and that is not cosmetic.**
  A first revision tested only "no newlines ⇒ one enormous line", so a real 380 MB
  `.glb` was reported as *"single-line ≈ 399 230 584 chars — probably minified
  rather than source"*. The number was absurd; the conclusion was worse, because it
  implied that 97 % of one repository's skipped bytes were compressed **source**
  when 414 of 417 MB were 3D models that could never hold a symbol. Detection is
  git's own rule (a NUL byte in the head means binary), plus a control-byte ratio;
  binary short-circuits both the minified and generated claims, and the headline
  warning now separates binary from text so the figure worth acting on is visible.
  Verified end to end on the repository that exposed it: the actionable remainder
  went from an implied 416.9 MB to **2.6 MB**.
- **`git ls-tree` is not used.** An earlier design compared the index against
  git-tracked files; real data killed it — 8 of the "missing" tracked files in a
  37-file repo were dotfiles excluded by the walker's `dot: false`, and 2 indexed
  files were untracked. The walker's own rules are the only honest denominator.
- **Panel effects and re-render are untested.** `react-dom` is not installed on
  this machine, so rendering uses a single-pass shim: `useState` yields its initial
  value and `useEffect` never runs. The pure view is covered; the fetch lifecycle
  is not.
- **No incremental update yet.** This ships the read-only monitoring half of the
  plan. Driving `analyze` is a separate concern with its own safety story — if
  nothing else, a status check must never start a 30-second rebuild.
