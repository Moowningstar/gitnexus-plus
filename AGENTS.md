<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **gitnexus-plus** (4622 symbols, 10596 relationships, 322 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/gitnexus-plus/context` | Codebase overview, check index freshness |
| `gitnexus://repo/gitnexus-plus/clusters` | All functional areas |
| `gitnexus://repo/gitnexus-plus/processes` | All execution flows |
| `gitnexus://repo/gitnexus-plus/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Version baseline (this repo's own policy — everything above is generated)

This package **consumes** GitNexus; it is not a fork. Two versions are in play at once, on purpose:

- **Development baseline: `gitnexus@1.6.12`.** `GITNEXUS_RANGE` in `src/gitnexus/install.ts` is `^1.6.12`, the install confirmation quotes that same string, and the fixtures are written against it. Code must not assume anything the candidate line adds.
- **Daily driver: the newest published build** (currently `1.6.13-rc.159`), installed both globally and in the plugin's managed prefix. Upstream regressions are meant to surface here first, so a green run on this machine means "works on the candidate", never "works for users".
- **The bridge is `peerDependencies.gitnexus`** = `^1.6.12 || >=1.6.13-rc.0 <2.0.0`. npm hides prereleases from a plain range, so the second arm says *a candidate checkout is accepted*, not *we ship a candidate*.
- **Storage versions are one-way.** 1.6.12 pins lbug storage 42, 1.6.13 pins 47. The newer reader opens the older store; the older reader refuses a 47 store (`Trying to read a database file with a different version`). This checkout's `.gitnexus` is a **47** store, so pointing it back at 1.6.12 needs `gitnexus analyze --force` (about 90 s) first.
- **Cross-engine rule.** A change that touches an upstream artifact — walker constants, `LocalBackend`, `stdio-context`, `GITNEXUS_WEB_DIST` resolution — is verified on both engines before it is called done. The measured contract matrix lives in `.docs/audit-v1.6.13-rc.159.md` §7 (local, gitignored).

## The pre-change gate (this repo's own surface, not upstream's)

`src/index.ts` also hooks the harness: `tools/pre-execute` asks for confirmation before an
`edit`/`write` whose file has live callers, and a `systemPrompt.context` line carries the change
set. Three rules a future change must keep, because each one is a way this becomes harmful:

- **Degrade to `allow`, never to a block.** No approval service (`ctx.get('approval')`), no
  `ctx.on`, no measurement, an exception, a query over its 4 s ceiling — every one of those
  returns the unmodified decision. A gate that cannot measure must not become a gate that
  stops work.
- **`precheck: false` removes both halves.** The config flag is the escape hatch; if it ever
  stops disabling the prompt line as well, an operator who turned the gate off still gets it.
- **The words are the contract.** No `编译失败` / `构建破坏` / `测试会挂` anywhere near this
  feature: the answer is structural, and `test/suites/risk-format.mjs` asserts the absence.
  `test/suites/precheck.mjs` covers the numbers, and `test/plugin.mjs` asserts the listener is
  actually registered — a silently unhooked gate looks identical to a working one from every
  other angle.
