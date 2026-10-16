# The DSH plugin authoring contract

**Scope.** Everything needed to write, package, install and run a third-party (out-of-tree) DeepSeek Harness
plugin that (a) registers host-side agent tools and settings, (b) serves HTTP routes from the host, and
(c) contributes a browser UI panel through the client-slot system.

**Evidence base.** Two source trees, read directly:

| Tree | Path | Version |
|---|---|---|
| **Checkout** ("the source") | `D:\Project\deepseek-harness` | `0.1.3-alpha.2` (`package.json`, `apps/cli/package.json`) |
| **Installed runtime** ("the shipped product") | `C:\Users\massnote\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\` | `0.2.0-rc.2` (`dsh`, `dsh-tools`, `dsh-settings`, `dsh-client-ui-plugin-manager`, …) |
| **Installed profile** | `C:\Users\massnote\.dsh\profiles\desktop\` | third-party plugins under pnpm |

> **Version-skew warning, read this first.** The checkout is **five minor releases behind** the runtime that
> actually serves this machine's GUI. Several contracts below changed between them, and one entire package
> (`@deepseek-ai/dsh-client-ui-plugin-manager`, the owner of the `plugins.row.config` slot) **does not exist in
> the checkout at all** — `packages/client/` there contains no `ui-plugin-manager` directory, and
> `packages/boot/` contains only `app-boot` and `cmdline`. Wherever the two disagree this report gives both and
> names which is authoritative **for the version you are targeting**. The rule:
>
> * Docs and source under `D:\Project\deepseek-harness` are authoritative for **0.1.3-alpha.2**.
> * The published `README.zh.md` / `lib/*.js` inside
>   `…\DSH Desktop\resources\app\node_modules\@deepseek-ai\*` are authoritative for **0.2.0-rc.2** — which is
>   what a plugin installed on this machine is loaded by.

---

## Table of contents

1. [Minimum viable plugin package](#1-minimum-viable-plugin-package)
2. [Manifest contract — the full `dsh` field](#2-manifest-contract--the-full-dsh-field)
3. [`cordis.patch.yml` — exact syntax and ordering](#3-cordispatchyml--exact-syntax-and-ordering)
4. [Host-side tool registration](#4-host-side-tool-registration)
5. [Services a host plugin can inject](#5-services-a-host-plugin-can-inject)
6. [HTTP routes from a host plugin](#6-http-routes-from-a-host-plugin)
7. [The client (browser) half — build contract](#7-the-client-browser-half--build-contract)
8. [Slots / UI contribution](#8-slots--ui-contribution)
9. [Settings cards](#9-settings-cards)
10. [Commands](#10-commands)
11. [Install & run loop for a third-party plugin](#11-install--run-loop-for-a-third-party-plugin)
12. [Testing](#12-testing)
13. [Appendix A — copy-paste skeleton](#appendix-a--copy-paste-skeleton)
14. [Appendix B — contradiction ledger](#appendix-b--contradiction-ledger)
15. [Appendix C — evidence index](#appendix-c--evidence-index)

---

## 1. Minimum viable plugin package

### 1.1 Two roles, two manifests

`docs/user/develop/basic/publish.md:11-16`:

> * A **bundle** is an npm package that ships a configuration layer. Its manifest declares `dsh.bundle`,
>   answering "what does this package contribute?": a patch file that inserts or overrides plugin rows.
> * A **profile** is a directory under `$DSH_HOME/profiles/<name>` describing one runnable composition. Its
>   manifest declares `dsh.profile`, answering "which bundles compose this setup, in what order?".
>
> A bundle is what you author and distribute; a profile is what a user boots with `dsh --profile <name>`.
> Nothing is both.

A third-party plugin author writes **one bundle package** that may additionally declare `dsh.client` for a
browser half. The user's profile is maintained by the `dsh plugin` CLI, never by hand
(`docs/user/develop/basic/publish.md:73`).

### 1.2 Directory layout

Minimum bundle (`docs/user/develop/basic/publish.md:26-31`):

```
hello-plugin/
├── package.json       # declares dsh.bundle
├── cordis.patch.yml   # the layer applied when a profile lists this bundle
└── index.js           # plugin modules the patch rows reference
```

Full-featured dual-face plugin, mirroring the shipped client-package skeleton
(`packages/client/AGENTS.md:138`):

```
my-plugin/
├── package.json          # name/version/type/exports/files/dsh
├── cordis.patch.yml      # dsh.bundle.patch target
├── tsconfig.json
├── tsdown.config.ts      # or any bundler you like — see §7
├── src/
│   ├── index.ts          # HOST half  → lib/index.js
│   └── client/
│       └── index.tsx     # BROWSER half → lib/client.js
└── lib/                  # built artifacts (must exist in the published package)
    ├── index.js
    ├── client.js
    └── types/…
```

### 1.3 `package.json` fields

The DSH-specific minimum, verbatim from the tutorial
(`docs/user/develop/basic/publish.md:35-43`):

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

The dual-face form, verbatim from the settings-card cookbook
(`docs/cookbook/adding-a-settings-card.md:84-92`):

```jsonc
{
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings-plugins"] } }
}
```

Field-by-field:

| Field | Required? | Meaning / evidence |
|---|---|---|
| `name` | yes | The row `name:` in `cordis.patch.yml` and the profile `dependencies` key. Also the browser module id (`docs/subsystems/client-modules.md:22-23` `Entry name == package name`). |
| `version` | yes | Used by `dsh plugin` reconciliation and by third-party compat checkers. |
| `type: "module"` | yes in practice | The host half is loaded through the Loader's ESM import path. `dsh-free-search/package.json:5`, `@liustack/modlens/package.json:5`, `billion-context`, `dsh-bash-terminal-ts` all set it. |
| `main` / `exports["."]` | yes | Host-half entry. Must be the built artifact, not `src/`: a git install fetches **sources, not built artifacts** (`docs/user/develop/basic/publish.md:161`). |
| `exports["./client"]` | required **iff** `dsh.client` is declared | `packages/client/modules/src/index.ts:765-768` throws `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`. |
| `exports["./package.json"]` | recommended | The client-modules scan resolves the manifest, and `require.resolve('<pkg>/package.json')` is one of its paths (`packages/client/modules/src/index.ts:806`). `dsh-free-search` and `@liustack/modlens` both export it. |
| `files` | yes | The published payload must be closed: every relative runtime import and emitted asset must be covered (`packages/client/AGENTS.md:67`). `lib/client.js` and `cordis.patch.yml` **must** be listed. |
| `dsh` | yes for a bundle | See §2. |
| `peerDependencies` | recommended | `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-settings`, `react`… with `peerDependenciesMeta.<x>.optional: true` so that a profile lacking one of them still installs (`dsh-free-search/package.json:69-104`). |
| `engines.node` | recommended | `dsh-free-search`: `">=20"`; `@liustack/modlens`: `">=22.19"`. |
| `engines.dsh` | third-party convention | `dsh-bash-terminal-ts/package.json`: `"dsh": ">=0.1.0-rc.8 <0.2.1-0"`. **Not read by DSH core** — see §2.7. |
| `prepare` | required for `github:` installs | `docs/user/develop/basic/publish.md:163`: "The author ships a `prepare` script — pnpm runs it after a git install — that builds the published entry points from source, self-contained". |
| `bin`, `icon`, `keywords` | optional | `keywords` conventionally include `deepseek-harness`, `dsh`, `dsh-plugin`. |

### 1.4 ESM / CJS requirements — the two faces differ

* **Host half (`lib/index.js`)** — plain **ESM**. Named exports `name`, `inject`, `apply`, `Config`. Loaded by
  the vendored Cordis Loader through `EntryTree.import`. Verified against every installed plugin
  (`dsh-free-search/lib/index.js:1-13, 3046-3047, 3252`, `export { …, apply, inject, name, Config }` at
  `:4517-4602`).
* **Browser half (`lib/client.js`)** — **not ESM**. It must be the **lazy-CJS factory artifact**:

  > "The bundle must be the loader's lazy-CJS factory artifact."
  > — `docs/cookbook/adding-a-settings-card.md:94`

  Concretely, a `format: 'cjs'` bundle wrapped in a `window.__ModuleLoader__.load({ id, factory })` banner.
  Real artifact, `dsh-free-search/lib/client.js:1-9` and `:1817-1821`:

  ```js
  window.__ModuleLoader__.load({
    id: "dsh-free-search",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;

      let react = require("react");
      let react_jsx_runtime = require("react/jsx-runtime");
      // … module body …

      exports.apply = apply;
      exports.inject = inject;
      return module.exports;
    },
  });
  ```

  The banner/footer/intro this comes from is `packages/client/tsdown.client.ts:566-568`:

  ```ts
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
  footer: 'return module.exports; } });',
  intro: 'var module = { exports: {} }; var exports = module.exports;',
  ```

  Mechanics: `docs/subsystems/client-modules.md:22-35` (`WebBootEntry`) and
  `docs/subsystems/web-client.md:22` — "The module system is a lazy CommonJS table: loading a bundle registers
  its factory, while materializing an entry runs the factory with synchronous `require` over platform modules
  and declared dynamic dependencies."

* **`"type": "module"` does not break the CJS bundle.** The client bundle is never `import`ed by Node; it is
  fetched by the browser and evaluated by the module-loader facade. `dsh-free-search` has
  `"type": "module"` and a CJS-format `lib/client.js` and works.

### 1.5 Worked reference — the simplest real third-party bundle

`C:\Users\massnote\.dsh\profiles\desktop\node_modules\@liustack\modlens\package.json` (86 lines, quoted in full
in §2.6) and its whole `cordis.patch.yml` (5 lines):

```yaml
# dsh bundle layer: mount the modlens vision plugin (dsh/index.js via the
# package root export; bin stays the CLI, nothing imports the root otherwise).
- insert:
    - id: modlens
      name: '@liustack/modlens'
```

That is a complete, working third-party bundle: `dsh.bundle.patch` + a `cordis.patch.yml` with one `insert`.

---

## 2. Manifest contract — the full `dsh` field

### 2.1 The type

`packages/util/package-manifest/src/types.ts:7-57` is the **single authoritative declaration** of
`package.json.dsh`:

```ts
/** The `dsh` property of an npm manifest; a package may declare several roles. */
export interface DshManifest {
  /** Bundle metadata consumed by the profile launcher. */
  bundle?: DshBundleManifest
  /** Profile metadata consumed by the profile launcher. */
  profile?: DshProfileManifest
  /** Client module loading and build metadata. */
  client?: DshClientManifest
  /** Config directories consumed by the experimental deployment-image packer. */
  configTrees?: DshConfigTreeDeclaration[]
  /** Adjacent Session migration metadata consumed by the workspace catalog generator. */
  sessionFormatMigration?: DshSessionFormatMigrationManifest
  /**
   * Launcher-generated module proxy metadata, not an author configuration entry.
   * @internal
   */
  moduleFallback?: DshModuleFallbackManifest
}

/** The configuration layer exported by a bundle package. */
export interface DshBundleManifest {
  /** Patch file path relative to the declaring package root. */
  patch: string
}

/** The bundle composition declared by a profile directory. */
export interface DshProfileManifest {
  /** Ordered bundle layer list, using installed package names. */
  bundles?: string[]
  /** User patch lifecycle; omitted means `live` for custom profiles. */
  patchReload?: ProfilePatchReload
}

/** Whether user patch files reload while a profile remains active or apply only at startup. */
export type ProfilePatchReload = 'live' | 'startup'

/** Client module declaration read by client-modules and the client build. */
export interface DshClientManifest {
  /** Client platform identifier; the Web consumer selects `web`. */
  platform: string
  /** Informational package-name dependencies, not Cordis service injection. */
  inject?: string[]
  /** Boot phase-one registration barrier; absent means the shared application batch. */
  immediately?: boolean
  /**
   * Exact module-table requests beyond the implicit client baseline, including
   * subpaths such as `<pkg>/client`; absent means baseline externals only.
   * Type-only imports are erased and create no module request.
   */
  external?: string[]
}
```

**There is no `dsh.engines`, `dsh.compatibility`, or `dsh.remote` in this type.** See §2.7.

### 2.2 `dsh.bundle.patch` — what the host does with it

* Reader: `packages/boot/app-boot/src/profile.ts:789-798`. For every name in `dsh.profile.bundles`, the
  launcher resolves the package directory, reads its manifest, takes `dsh.bundle.patch`, joins it to the
  package root, parses it as a patch list, and pushes it as a **layer**.
* Missing declaration → **fail loud** (`profile.ts:793-795`):
  `"<bin>: profile bundle "<name>" declares no dsh.bundle in its package.json"`.
* A package **without** `dsh.bundle` still installs, but only as a plain dependency: `dsh plugin` prints a
  warning and activates no layer (`docs/user/develop/basic/publish.md:64`).
* Path is relative to the declaring package root; a leading `./` is conventional but not required
  (`dsh-free-search` uses `"cordis.patch.yml"` bare; `modlens` uses `"./cordis.patch.yml"`).

### 2.3 `dsh.profile.bundles` and `dsh.profile.patchReload`

* `bundles` is the **ordered layer list**. `profile.ts:781` reads it; an empty/absent list means no layers.
* `patchReload` must be exactly `'live'` or `'startup'`, else the launcher throws
  (`profile.ts:783-787`):
  `"<bin>: profile manifest <path> dsh.profile.patchReload must be \"live\" or \"startup\""`.
* Default when omitted: `DEFAULT_PROFILE_PATCH_RELOAD = 'live'` (`profile.ts:142`), so **a custom profile is
  live by default**. Shipped templates override it: `web` → `live`, `headless`/`sdk`/`sdk-minimal`/`acp` →
  `startup` (`profile.ts:113-129`).
* This machine's real profile (`C:\Users\massnote\.dsh\profiles\desktop\package.json:13-26`):

  ```json
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-bash-terminal-ts",
        "dsh-context",
        "@liustack/modlens",
        "dsh-free-search",
        "dsh-rewind-plugin"
      ],
      "patchReload": "live"
    }
  }
  ```

  Note `dshmarket` is a **dependency** but is **not** in `bundles` — it declares no `dsh.bundle`, so it is a
  plain dependency (it ships its own `cordis.patch.yml` but the launcher never reads it).

### 2.4 `dsh.client` — what the host does with each member

Reader: `packages/client/modules/src/index.ts`, `ClientModuleRegistry`. Parse/validate:
`packages/client/modules/src/index.ts:185-200` (`parseDshClient`) and the resolve step at `:743-778`.

```ts
/** Narrow an unknown parsed JSON value to the `dsh.client` declaration, throwing on malformed fields. */
// :189  throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`)
// :193  throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`)
// :195  const inject = optionalStringArray(pkgName, 'dsh.client.inject', decl.inject)
// :196  const external = optionalStringArray(pkgName, 'dsh.client.external', decl.external)
// :198  throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`)
```

| Member | Type | Semantics | Evidence |
|---|---|---|---|
| `platform` | `string` | **Required.** `ClientModuleRegistry.resolveMeta` returns `null` (i.e. "not a client package") unless `decl.platform === 'web'` (`packages/client/modules/src/index.ts:761-764`). No other value is currently consumed. | `docs/subsystems/client-modules.md:77`; `packages/client/modules/src/index.ts:761` |
| `inject` | `string[]` | **Informational only** — package-name dependency edges used for preflight display and HMR diffing. **They do not sequence entry activation or apply order.** Activation order is Cordis fiber inject-waiting on *services*, nothing else. | `packages/client/AGENTS.md:140`; `docs/subsystems/client-modules.md:28-29` ("`inject` names package rows whose factories must arrive before this row materializes, while Cordis separately uses the same package edges to compose entries"); `docs/subsystems/slots.md:5` |
| `immediately` | `boolean` | Stage-one prefetch mark: the script is loaded for factory registration during module-face boot. Absent ⇒ the shared application batch. Reserve for stage-one-prefetch **infrastructure** rows. | `docs/subsystems/client-modules.md:31`; `packages/client/AGENTS.md:140`; used by `@liustack/modlens/package.json:83` and `dsh-bash-terminal-ts/package.json` |
| `external` | `string[]` | Exact **non-baseline module-table** requests, matching is exact (never normalized), subpaths allowed (`<pkg>/client`). Type-only imports are erased and create no request. Self-requests throw (`packages/client/modules/src/index.ts:444`). It is **not** a feature-plugin dependency mechanism. | `packages/client/tsdown.client.ts:392-397, 406-416`; `packages/client/AGENTS.md:78`; `packages/client/modules/src/index.ts:444` |

The baseline (`PLATFORM_MODULES`, `packages/client/web/src/platform.ts:8-14`) is **implicit for every dynamic
bundle** and must not be repeated in a manifest:

```ts
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/** Client-bundle specifiers whose factories the parser preloads before the shell starts. */
export const PRELOADED_CLIENT_EXTERNALS = [
] as const
```

The registry also serves the bundle: `GET|HEAD /plugins/??<pkg-a>/client.js,<pkg-b>/client.js&rev=<rev>`, with a
parallel `.map` form. Unknown/altered/stale revisions answer 404 (never the SPA HTML); other methods 405; all
advertised responses use long-lived immutable caching (`docs/subsystems/client-modules.md:85`).

An error worth knowing at development time (`packages/client/modules/src/index.ts:767`):

```
client-modules: <pkg> declares dsh.client but exports no "./client" bundle
```

…and the activation-time failure posture (`docs/subsystems/client-modules.md:79`): at activation, a malformed
declaration or missing bundle among already-loaded entries aggregates into **one loud `AggregateError`** and the
fiber FAILS; in steady state a broken package logs a warning and must not poison the others.

### 2.5 `dsh.configTrees` and `dsh.sessionFormatMigration` — not for third parties

* `configTrees` (`types.ts:60-67`) is consumed only by the **experimental deployment-image packer**
  (`packages/experimental/webworker-packer/src/repository.ts:115`, `manifest.dsh?.configTrees`).
* `sessionFormatMigration` is explicitly closed to third parties: "The catalog generator discovers only
  packages/session/session-format-vN-to-vN+1, **not external plugins**" (`types.ts:70-72`).
* `moduleFallback` is launcher-generated (`@internal`), never authored.

### 2.6 A complete real-world `dsh` field (modlens)

`@liustack/modlens/package.json:70-85`:

```json
"exports": {
    ".": "./dsh/index.js",
    "./dsh": "./dsh/index.js",
    "./package.json": "./package.json",
    "./client": "./dsh/client.js"
},
"dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": [], "platform": "web", "immediately": true }
}
```

And the largest real one (`dsh-free-search/package.json:109-129`):

```json
"dsh": {
    "bundle": { "patch": "cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-ui-commands",
        "@deepseek-ai/dsh-client-ui-plugin-manager",
        "@deepseek-ai/dsh-client-ui-renderer"
      ],
      "platform": "web"
    },
    "engines": { "dsh": ">=0.1.7-rc.1" },
    "compatibility": { "dshReleases": { "0.1.7-rc.1": "compatible" } }
}
```

Note `engines` and `compatibility` here are **not** in `DshManifest`.

### 2.7 `dsh.engines`, `dsh.compatibility`, `dsh.remote` — do they exist?

| Claim | Verdict | Evidence |
|---|---|---|
| `dsh.engines` | **Not a DSH core field.** Absent from `DshManifest` (`packages/util/package-manifest/src/types.ts:8-24`). Used by `dsh-free-search`. The conventional, *read* equivalent is npm's own `engines.dsh` (`dsh-bash-terminal-ts/package.json`). | grep for `dsh\.engines` across `packages/` + `apps/` returns nothing |
| `dsh.compatibility` | **Not a DSH core field.** Used only by `dsh-free-search`. The nearest first-party mechanism is the marketplace's own compatibility data. | grep: no reader in the checkout |
| `dsh.remote` | **Does not exist.** Remote API contributions are declared through **`exports` subpaths** (`./typert`, `./remote`) plus a `peerDependencies` entry on `@deepseek-ai/dsh-typert-protocol` — see §2.8. | `docs/cookbook/adding-a-remote-api.md:94-103` |
| `dsh.plugin.json` | **Not a DSH core file.** Found in the third-party `dsh-bash-terminal-ts` package (`{ id, name, version, description: {en,zh}, homepage, repository, license, engines, components: { host, client } }`). No DSH package reads it (grep of the installed `dsh-plugin-manager`, `dsh-client-ui-plugin-manager`, and the checkout `docs/` finds nothing). The market's own display path is the exported locale `meta`, then the plugin's `package.json`. | `dsh-bash-terminal-ts/dsh.plugin.json`; installed `dsh-client-ui-plugin-manager/README.zh.md:32` |

**Practical consequence.** A plugin that wants to be installable and loadable needs only `dsh.bundle.patch`
and (optionally) `dsh.client`. Fields such as `dsh.engines` / `dsh.compatibility` / `dsh.plugin.json` are
ecosystem (market/manager) metadata: harmless, ignored by the loader, and meaningful only to whichever
third-party tool reads them. Adding them costs nothing; omitting them changes nothing about loading.

### 2.8 Remote API declarations (there is no `dsh.remote`)

`docs/cookbook/adding-a-remote-api.md:94-103`:

```json
{
  "exports": {
    "./typert": { "types": "./lib/typert.host.d.ts", "default": "./lib/typert.host.js" },
    "./remote": { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" }
  },
  "peerDependencies": { "@deepseek-ai/dsh-typert-protocol": "workspace:^" },
  "devDependencies": { "@deepseek-ai/dsh-typert-protocol": "workspace:^" }
}
```

Those two artifacts are **generated** (`pnpm run build:lib`) — `docs/cookbook/adding-a-remote-api.md:105`:
"Rerun `pnpm run build:lib` after changing a signature, the code table, the namespace, or an export name,
because that is what hands the Client its new declarations and codecs." The generator is
`packages/typert/generator`, and it keys off the `dsh.client` declaration
(`packages/typert/generator/src/analyzer.ts:2664` reads `manifest.dsh`;
`packages/typert/generator/tests/type-model.spec.ts:872` "keeps both runtime faces for an ordinary dsh.client
project").

This is the **first-party, typed** path. It is heavy for a third-party plugin. See §6.3 for the lightweight
alternative that real third-party plugins use.

---

## 3. `cordis.patch.yml` — exact syntax and ordering

### 3.1 The file format

A `cordis.patch.yml` is a **top-level YAML array of patch entries**, parsed with the include's dialect:
`JSON_SCHEMA` **extended with the `!!js` tag** (`vendor/include/src/index.ts:9-25`):

```ts
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data['__jsExpr'],
})

export const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)
```

Template the CLI writes into a fresh profile (`packages/boot/app-boot/src/profile.ts:146` region, visible as the
comment in the live file `C:\Users\massnote\.dsh\profiles\desktop\cordis.patch.yml:1-3`):

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
```

### 3.2 The patch algorithm — canonical source

`vendor/include/src/index.ts:58-128` (`applyEntryPatches`). This function is shared by mounting **and** by
offline config tooling, "so a dump can never drift from what boots" (`:44-47`). Reproduced with its own JSDoc:

```ts
export function applyEntryPatches(
  data: EntryOptions[],
  patches: PatchOptions[] | undefined,
  warn: (message: string, ...args: any[]) => void,
): EntryOptions[] {
  data = structuredClone(data)
  if (!patches?.length) return data

  const entryMap = new Map<string, EntryOptions>()
  const buildMap = (entries: EntryOptions[]) => {
    for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry)
      if (entry.group && Array.isArray(entry.config)) {
        buildMap(entry.config)
      }
    }
  }
  buildMap(data)

  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch

    if (insert) {
      if (id) {
        const target = entryMap.get(id)
        if (!target) { warn('patch insert: entry %C not found', id); continue }
        if (!target.group) { warn('patch insert: entry %C is not a group', id); continue }
        if (!Array.isArray(target.config)) target.config = []
        target.config.push(...insert)
      } else {
        data.push(...insert)
      }
      // Index what this patch added so a LATER patch in the same list can
      // target it. …
      buildMap(insert)
      continue
    }

    if (!id) { warn('patch: id is required for non-insert patches'); continue }

    const target = entryMap.get(id)
    if (!target) { warn('patch: entry %C not found', id); continue }

    if (name && name !== target.name) {
      warn('patch: name mismatch for %C (expected %C, got %C), skipping', id, target.name, name)
      continue
    }

    for (const [key, value] of Object.entries(overrides)) {
      if (key === 'id') continue
      target[key] = value
    }
  }

  return data
}
```

`PatchOptions` (`vendor/include/src/index.ts:145-156`):

```ts
export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}
```

### 3.3 The rules, distilled

1. **`insert` without `id`** → the listed rows are appended to the **top-level entry list** of the layer below.
2. **`insert` with `id`** → the rows are appended to that **group** entry's `config` array. The target must be
   a group (`target.group` truthy), else the patch warns and is skipped.
3. **`insert` is not affected by `name`.** The `name` destructured alongside `insert` is simply not used on
   that branch. But see rule 6 — a *non-insert* patch does use it.
4. **A non-insert patch requires `id`.** Without it: `patch: id is required for non-insert patches`.
5. **Unmatched targets warn and are skipped**, never throw. `dsh --dump-config` reports unmatched patch targets
   on stderr (`apps/cli/reference/README.md:42`).
6. **`name` is a mismatch guard on overrides.** If present and different from the target's `name`, the patch is
   skipped with a warning. This is how the live profile file disambiguates
   (`C:\Users\massnote\.dsh\profiles\desktop\cordis.patch.yml:31-34`: `- id: desktop-shell` /
   `name: dsh-plugin-desktop`).
7. **Every other key is overwritten wholesale onto the target.** `config`, `disabled`, `inject`, `isolate`,
   `group`, … This is *not* a deep merge:

   > "a patch replaces the targeted row's entire `config` value rather than deep-merging keys"
   > — `docs/user/develop/basic/publish.md:123`; `apps/cli/reference/README.md:9`

   Consequence for authors (`docs/user/develop/basic/publish.md:125-126`): *"Your patch can override rows from
   earlier layers by `id` … but must restate every key the row needs, not just the changed one."* A real-world
   scar: `dsh-bash-terminal-ts/cordis.patch.yml` restates **all twelve** `terminal-controller` keys and asserts
   the key set in a build script, precisely because omission silently reverts each limit to its `.default()`.
8. **Patches apply in list order, and a later patch can target a row an earlier patch in the same list
   inserted** (`:96-101`). So one file may insert a row and then configure it by id.
9. **The input is never mutated; the result is always detached** (`:47-52`). Repeated application after a config
   hot-reload can therefore revert a removed or changed patch.

### 3.4 `disabled` and `!!js`

`disabled` is an ordinary override. `!!js` scalars become expression nodes the Loader evaluates **at entry
activation**, against the Loader's context (`vendor/include/src/index.ts:9-23`;
`packages/boot/app-boot/tests/user-patches.spec.ts:275-284` "evaluates a `!!js` disabled expression against the
loader context"). Real examples in the shipped base layer
(`packages/bundle/base/cordis.patch.yml:21-27`):

```yaml
    - id: hmr
      name: '@deepseek-ai/cordis-plugin-hmr'
      disabled: true
      config:
        root: ['.']
```

`dsh-free-search` documents one hard-won `disabled` rule in its own patch file
(`dsh-free-search/cordis.patch.yml:21-27`): a **static** `- id: web config: searchProvider: ddg` row was
removed because a patch replaces the whole row config — when the plugin was disabled, `searchProvider: ddg`
stayed behind while nothing registered `ddg`, breaking every web search. The correct posture is to leave the
base default in place and take over at runtime.

`!!js` elsewhere — the app-argument bridge (`docs/user/develop/basic/publish.md:143-149`):

```yaml
- id: my-app
  name: '@example/my-app'
  inject: [myAppStartup]
  config:
    port: !!js ctx.myAppStartup.port ?? 8080
```

Loader semantics (`apps/cli/reference/README.md:19`): *"An ordinary plugin injects `cmdlineArgs`, parses this
app's arguments, and provides what it resolved as a service; each row configured from flags injects that
service, and Loader waits for the row before evaluating the row's config."* A flag therefore beats the literal
beside it — **provided the row keeps the expression**.

`!!js` is only interpolated on `disabled` for entry metadata. Everywhere else it is evaluated against the row's
own context (`scripts/verify-cordis-config.ts:496-531` errors with `!!js is not interpolated here` for
non-interpolated positions).

### 3.5 Ordering semantics vs bundles and `cordis.yml`

The effective configuration composes **over an empty root**, in this order
(`docs/user/develop/basic/publish.md:114-121`; identical list in `apps/cli/reference/README.md:9`):

1. Each bundle patch named in `dsh.profile.bundles`, **in list order** — `@deepseek-ai/dsh-base` first, then
   each installed bundle in the order it was added.
2. The profile's own `cordis.patch.yml`.
3. The home-level `$DSH_HOME/cordis.patch.yml` — machine-local preferences shared by every profile (so it
   **outranks** the per-profile layer).
4. Each `--patch <path>` overlay, **in argv order**.

Later layers win **per row**; a patch replaces the targeted row's whole `config`.

Resolution anchors (`apps/cli/reference/README.md:11`, `packages/boot/app-boot/src/profile.ts:751-762`):

* Bundle names resolve **from the dsh installation first, then from the profile directory.** This is why
  `@deepseek-ai/dsh-base` is always the same installation as the running `dsh` (including from an out-of-tree
  bundle's patch).
* A bare plugin `name` in **any** patch row resolves through the profile directory's Node parent walk, which
  reaches the maintained installation fallback `$DSH_HOME/profiles/node_modules`.

Inspect without booting (`apps/cli/reference/README.md:37-42`):

```sh
dsh --profile web --dump-default-config     # bundle layers only
dsh --profile web --patch ./extra.yml --dump-config   # + profile patch, home patch, --patch overlays
```

Both print comments naming the file that supplied each row and every overlay that changed it; `!!js`
expressions remain **unevaluated**; relative plugin names in inserted rows resolve beside their patch file;
unmatched patch targets are reported on stderr.

### 3.6 `cordis.yml` vs `cordis.patch.yml`

`cordis.yml` is the **base entry list** of a tree; `cordis.patch.yml` is a **patch list applied to** whatever
the composition produced. In a shipped profile the base is empty and everything arrives by patches; in the
tutorial flow (`docs/user/develop/basic/index.md:48-61`) a `cordis.yml` overlay is passed with `--patch`, which
is the same patch mechanism under a different filename:

```yaml
- insert:
    - id: hello
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/my-plugin.ts'
```

Note the constraint at `docs/user/develop/basic/index.md:56`: *"The plugin path must be absolute. A patch file
contributes configuration but does not change the profile directory from which the loader resolves module
paths."* In a **bundle's** patch, rows reference the package **by name** instead of a relative source path so
Node resolution finds the installed code (`docs/user/develop/basic/publish.md:56`).

The live profile directory on this machine has both: `cordis.yml` (3 bytes — effectively empty) and
`cordis.patch.yml` (1056 bytes, the working user layer), plus a `.bak-1791900309577` left by the plugin
manager.

---

## 4. Host-side tool registration

### 4.1 The API

```ts
ctx.tools.register(definition: ToolDefinition): () => void
```

Signature: `packages/core/tools/src/index.ts:1027`. Service declaration: `packages/core/tools/src/index.ts:131`
(`tools: ToolRuntime`). Import specifier for the type augmentation:
`import type {} from '@deepseek-ai/dsh-tools'`. The typed helper:

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
```

Registration is **effect-based**: disposing the plugin fiber unregisters the tool
(`docs/cookbook/adding-a-tool.md:38`). `ctx.tools.register()` internally uses
`{ label: 'tools.register()' }` (`packages/core/tools/src/index.ts:1050`).

### 4.2 The schema DSL — Schemastery? TypeBox? Zod? **None of them.**

This is the single most commonly mis-answered question. Tool `parameters` and `output.schema` use a
**DSH-owned JSON-value DSL** (`ValueSchemaSpec` / `ParameterSchemaSpec`), *not* Schemastery, *not* TypeBox,
*not* zod. Evidence — `docs/subsystems/tools.md:98-132`:

> "Plugin authors use one vocabulary for typed parameters and typed output values. `ValueSchemaSpec` supports
> `string`, `number`, `integer`, `boolean`, `null`, `array`, `object`, author-only `json`, and exact-one
> `oneOf`; scalar `enum` and `const` values must match their node type. An explicit object node always declares
> `additionalProperties: true | false`. Parameter definitions remain an implicit open object property map, with
> `required: true` attached to each required property."

```ts
/** One implicit parameter-root property, optionally required. */
type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

/**
 * Tool parameter schema. The map itself is an implicit open object root;
 * requiredness remains a per-property `required: true` annotation.
 */
type ParameterSchemaSpec = {
  [key: string]: ParameterPropertySpec
  [key: symbol]: never
}
```

DSL source: `packages/core/tools/src/schema.ts`. Support files: `src/json-schema.ts` (the enforced raw JSON
Schema subset), `src/presentation.ts` (card render intents).

`defineTool` ties parameter inference to `parameterSchemaSpecToJsonSchema()` / `validateArgs()` and ties
`execute`/`render`/`presentationMeta` to `InferValue<OutputSchema>`. `InferValue` stays exact through **16
container levels** and then widens to `JsonValue` (`docs/subsystems/tools.md:134-149`).

**Raw JSON Schema is also accepted directly** — that is how MCP-sourced tools arrive
(`docs/cookbook/extension-cookbook.md:9`). A raw `ToolDefinition` validates its own input
(`docs/subsystems/tools.md:96`: "`execute` receives `args: unknown` — a raw `ToolDefinition` validates its own
input").

Where Schemastery *does* appear is plugin **Config** (`export const Config: Schema<Config>`,
`docs/user/develop/basic/config.md:13-27`) — a different concern, different module
(`@deepseek-ai/schemastery`).

### 4.3 Complete minimal example (from the docs, verbatim)

`docs/cookbook/adding-a-tool.md:9-36`:

```ts
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a file from disk.',          // what the model sees
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path' },
      limit: { type: 'number' },                     // optional by default
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      // args is TYPED from the schema: { path: string; limit?: number }
      // exec carries immutable identity + token; signal is the operational field
      return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
    },
  }))
}
```

### 4.4 Handler signature and the `ToolDefinition` contract

`docs/subsystems/tools.md:13-94` — the normative types:

```ts
/** Tool-owned canonical output contract used after the body returns a JSON value. */
interface ToolOutputDefinition {
  /** Raw supported JSON Schema enforced against every successful canonical value. */
  readonly schema: JsonSchemaNode
  /** Pure projection from validated arguments and value to Native/model content. */
  render(args: unknown, value: JsonValue): ContentBlock[]
  /** Pure replayable presentation projection, computed only for top-level calls. */
  presentationMeta?(args: unknown, value: JsonValue): JsonValue
}

/** A registered tool: its schema plus the execution function. */
interface ToolDefinition extends ToolSchema {
  /** Mandatory canonical output declaration. */
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /** Cooperative tool-call timeout budget in milliseconds. Omit for no deadline. */
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args: unknown): ToolCallView | undefined
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
```

Rules from `docs/cookbook/adding-a-tool.md:42-49`, condensed:

* **Args are validated for you.** `defineTool` validates model-generated `arguments` against
  `ParameterSchemaSpec` before `execute` runs — types, required keys, literal constraints, exact-one unions,
  nested values. Explicit object nodes declare `additionalProperties: true | false`; the implicit parameter
  root stays open. **You still hand-check** non-empty strings, positive numbers, cross-field rules.
* **Registration borrows your readonly definition.** Do not mutate the schema or replace callbacks after
  registration. To hot-swap a tool, dispose its owning effect and register the replacement.
* **Execution identity is protected.** `arguments` is materialized as detached lossless JSON, frozen before
  policy, given an opaque `exec.token`; `callId`, `name`, `arguments`, `agent`, `token`, the required
  caller-owned `signal`, and an optional `parent` stay immutable.
* **Declare and return one canonical JSON value.** `execute` returns only the inferred value; the registry
  snapshots it as lossless JSON, validates it, freezes it, passes it to `output.render(args, value)`. **Do not
  return content blocks from the body.**
* **Throwing or returning an invalid value means `isError`.** Throw for infrastructure failures; represent a
  successful-but-unideal domain outcome in the canonical value (`docs/cookbook/adding-a-tool.md:46`).
* **Honor `exec.signal`.** Cancel in-flight work when it fires.
* **`presentationMeta(args, value)`** derives replayable JSON from the canonical value when a UI card needs
  result-time facts; persisted on `tool/result` and handed to `presentResult`.
* **`exec.agent` for async notifications:** `agent.inject({ content, source: { kind: 'plugin', plugin: '<name>' } })`
  appends durable context the NEXT model request sees — it is **not** a wake-up.

### 4.5 How the description reaches the model

By an explicit allowlist projection. `docs/subsystems/tools.md:11`:

> "The registry's `schemas()` builds the model-facing `ToolSchema[]` by an explicit allowlist —
> `output`/`execute`/`finalizeContent`/`timeoutMs`/`isConcurrencySafe`/`presentCall`/`presentResult` must never
> leak into a model request."

And `docs/cookbook/adding-a-tool.md:38`:

> "Registration is effect-based: disposing the plugin fiber unregisters the tool. **Schemas flow into the
> system-prompt assembly automatically.**"

`ctx.tools.schemas(scope?)` returns the visible model-facing schemas (`packages/core/tools/README.md:81`;
catalog `:1224`).

### 4.6 Long-running work, streaming, progress

The docs' own summary (`docs/cookbook/adding-a-tool.md:53-55`):

> "Gate `run_in_background` with producer config, then register through `ctx.jobs.start({ kind, label, owner:
> exec.agent, run })`. The registry rejects a pre-aborted invocation before the producer body; the runtime
> validates ownership and task-controller availability before `run()` starts work, then supplies the id, session
> fence, generic control tools, notices, and owner cleanup. A successful background branch returns a typed
> canonical handle such as `{ kind: 'background', jobId }`; its Native renderer may keep human prose such as
> `started background job bash-1`, but PTC mode must never parse that prose to recover the id."

Producer contract:

* synchronous `cancel`
* non-rejecting `done` that settles after resource cleanup
* optional consuming `readOutput` with bounded-output formatting
* once `ctx.jobs.start()` publishes the id, use a **task-owned** cancellation signal rather than `exec.signal`:
  outer-call cancellation stops *waiting* for the call but does not kill published work; `job_kill`, owner
  disposal, and service teardown own that lifetime. Foreground work stays coupled to `exec.signal`.

There is **no** separate streaming/progress API on a tool. Progress is expressed either as background-job output
(`ctx.jobs`) or as an observable/SSE stream from a plugin-owned HTTP route (§6).

### 4.7 Error shape

* Arg mismatch → `ToolArgsError` with code `INVALID_ARGS`.
* Invalid body/post-policy value → `ToolOutputError` with code `INVALID_TOOL_OUTPUT`.

Both "use the normal tool-error path" (`docs/subsystems/tools.md:149`). Cancellation codes
(`packages/core/tools/README.md:121`): cancellation before body invocation is `ABORTED_BEFORE_DISPATCH`, after
invocation it replaces only a successful outcome with `ABORTED`. Denials, wrapper failures, tool failures,
post-policy failures, and timeout-owned `TOOL_TIMEOUT` remain more specific. **Unknown and throwing tools
become structured errors (`UNKNOWN_TOOL`), so a call fails without ending the turn.**

For PTC mode, a failed `await tools.<name>(args)` rejects with the real `ToolCallError`; programs can inspect
only its `name`, `toolName`, and human-readable `message` — not internal error codes or a failure union
(`docs/cookbook/adding-a-tool.md:63`).

### 4.8 How results are rendered / presented

Two entirely separate channels — this distinction bites.

**(a) Model-facing content** = `output.render(args, value) → ContentBlock[]`. The docs are explicit that this
must be a block array, and a real third-party plugin documents why
(`dsh-free-search/lib/index.js:4154-4156`):

```js
// 契约要求直接返回 ContentBlock[]：finalizeContent 在 tools/post-execute 之后才执行，
// 只返回字符串会让该阶段的消费者（如 dsh-hooks-codex）拿到裸字符串崩溃。
return [{ type: 'text', text: `Search engine test:\n${wrapUntrustedBlock(lines.join("\n"))}` }];
```

Translation: *the contract requires returning `ContentBlock[]` directly; `finalizeContent` runs after
`tools/post-execute`, and returning a bare string makes that stage's consumers (e.g. `dsh-hooks-codex`) crash
on the raw string.*

**(b) Host-local presentation descriptors** = optional, pure `presentCall` / `presentResult` returning a
`card`-tagged render intent. `docs/cookbook/adding-a-tool.md:69-91` enumerates them:

| Card | Where | Shape |
|---|---|---|
| `generic` | call + result | `{ card: 'generic', title, kind?, rawInput?, content?, locations? }` — the default. Set `kind` for an icon (`read`/`search`/…); set `locations: [{ path, line? }]` so a capable editor follows along. |
| `terminal` | call + result | `{ card: 'terminal', title, description?, cwd? }`; result supplies raw output and optional exit metadata. |
| `diff` | call + result | `{ card: 'diff', title, diffs, locations? }`, `diffs: [{ path, oldText, newText }]` (`oldText: null` = new file). |
| `read` | result only | `{ path, offset (1-based), lines (each keeping its file line number), totalLines, lang? }`. No call view. |
| `search` | result only | grouped-by-file matches (`shape: 'matches'`) or a flat path list (`shape: 'paths'`), plus `truncated`/`total`. No call view. |
| `web` | result only | `kind: 'search' \| 'fetch'`. No body copy. |

Hard rules (`docs/cookbook/adding-a-tool.md:85-89`):

* **Purity.** These run on live streaming **and** session-log replay ⇒ pure functions of `args` (+ result).
  NO I/O, NO session state, NO clock/random.
* **UI-only formatting stays out of the model result.**
* **`defineTool` soft-validates the display path** — malformed or older logged arguments make the wrapper
  return `undefined` (generic fallback) rather than throw.

**(c) The built-in Web Client does not consume (b) at all.** `docs/cookbook/adding-a-tool.md:93-97`:

> "The built-in Web Client does not consume `presentCall` or `presentResult`. Session `page` and `follow`
> transport raw `tool/call` and `tool/result` events, including persisted `result.meta`. A Client plugin
> registers its wire tool name in the `tool.call.toolview` keyed slot and derives component props from the
> `ToolCallBlock` arguments, content, error, metadata, existing Code Dispatch `parentCallId`, and Session path
> facts. It validates these wire values locally and returns the generic row for malformed or unsupported input."

So a third-party plugin wanting a custom Web card must register into `tool.call.toolview` (a keyed child of
`conversation.chat.node`, `docs/subsystems/slots.md:137`) — **not** implement `presentCall`.

### 4.9 Policy and observation extension points (register these instead of building policy in)

`docs/cookbook/adding-a-tool.md:59` + `packages/core/tools/README.md:130`:

| Extension point | Kind | Use |
|---|---|---|
| `tools/pre-execute` | waterfall | Extensible allow/deny/ask policy. |
| `ctx.tools.guard()` | registration | A final **monotonic** deny that later listeners cannot undo (`packages/core/tools/src/index.ts:1100`). |
| `tools/execute` | waterfall | Wrap dispatch with a deadline, retry, or metrics. Only the `tools/execute` view may replace the required signal. |
| `tools/post-execute` | waterfall | Replace presentation content or the returned value, block the result, attach model-facing context. |
| `tools/result` | emit | Observe the immutable normalized outcome. |
| `ctx.tools.restrict(filter)` | registration | Per-agent allow/deny mask; requires a scoped context (`packages/core/tools/src/index.ts:1061-1086`). |

Pipeline order (`packages/core/tools/README.md:103`):
`tools/pre-execute` → monotonic guards → `tools/execute` → `tools/post-execute` → definition-owned
`finalizeContent` → `tools/result`.

A permission-gate example (`docs/cookbook/extension-cookbook.md:15-31`):

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

declare function isAllowed(exec: ToolExecution): Promise<boolean>

export const name = 'permission-gate'

export function apply(ctx: Context) {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!(await isAllowed(exec))) {
      return { kind: 'deny', reason: 'Denied by policy.' }
    }
    return next()
  })
}
```

---

## 5. Services a host plugin can inject

`inject` is Cordis service injection: the framework waits for **every** required service before running
`apply`; if a required service disappears the plugin unloads and reloads when it returns
(`docs/user/develop/framework/index.md:26-38`). A plugin whose `inject` names a service nobody provides waits
**forever in PENDING, silently** — that is a legitimate state, not an error
(`docs/cordis-tutorial/06-composition-and-hmr.md:61-63`).

The exhaustive shipped service roster is generated at
`packages/extensions/tool-cordis/src/api-catalog.ts` (68 `ctx.<key>` entries) and rendered into
`docs/subsystems/*.md` under `<a id="cordis-surface">`. The table below gives the ones a third-party plugin
actually wants, with the **import specifier that supplies the TypeScript `Context` augmentation**.

| `ctx.<key>` | Purpose (first sentence of the shipped JSDoc) | Import specifier for the augmentation |
|---|---|---|
| `ctx.tools` | Tool registry and execution pipeline. | `@deepseek-ai/dsh-tools` |
| `ctx.commands` | Human-command registry. | `@deepseek-ai/dsh-commands` |
| `ctx.settings` | Abstract settings service. | `@deepseek-ai/dsh-settings` |
| `ctx.fs` | Abstract filesystem provider. | `@deepseek-ai/dsh-fs` |
| `ctx.shell` | Abstract bash execution service. | `@deepseek-ai/dsh-shell` |
| `ctx.shellEnv` | Registry for trusted, per-execution `DSH_*` variables. | `@deepseek-ai/dsh-shell-env` |
| `ctx.jobs` | Abstract background job registry. | `@deepseek-ai/dsh-jobs` |
| `ctx.storage` | The storage hub service. | `@deepseek-ai/dsh-storage` |
| `ctx.web` | The web access service (search + fetch providers). | `@deepseek-ai/dsh-web` |
| `ctx.webServer` | The browser HTTP carrier service. | `@deepseek-ai/dsh-host-webserver` |
| `ctx.skills` | Layered registry of skill providers. | `@deepseek-ai/dsh-skill` |
| `ctx.subagents` | Named provider registry with one-shot runs, durable discovery, continuable children. | `@deepseek-ai/dsh-subagent` |
| `ctx.sessions` | In-memory session store. | `@deepseek-ai/dsh-session` |
| `ctx.sessionPersistence` | Durable append-only session storage via per-session handles. | `@deepseek-ai/dsh-session-persistence` |
| `ctx.sessionQuery` | Unified live-preferred session query service. | `@deepseek-ai/dsh-session-query` |
| `ctx.sessionTitle` | Log-backed title fold plus asynchronous fallback generation. | `@deepseek-ai/dsh-session-title` |
| `ctx.credentials` | Abstract credential service over two key spaces. | `@deepseek-ai/dsh-credentials` |
| `ctx.systemPrompt` | Registry for the prompt inputs assembled before each model step. | `@deepseek-ai/dsh-system-prompt` |
| `ctx.approval` | Approval service applying session policy before answerers. | `@deepseek-ai/dsh-user-approval` |
| `ctx.userQuestions` | Validation plus the scoped answerer waterfall. | `@deepseek-ai/dsh-user-questions` |
| `ctx.sandbox` | Abstract process-sandbox service. | `@deepseek-ai/dsh-sandbox` |
| `ctx.terminals` | In-process registry for replaceable PTY backends and exact-Agent sessions. | `@deepseek-ai/dsh-terminal` |
| `ctx.subprocess` | Abstract subprocess service. | `@deepseek-ai/dsh-subprocess` |
| `ctx.spillStore` | Abstract spill storage service. | `@deepseek-ai/dsh-spill` |
| `ctx.goals` | Goal service backed exclusively by the owning session log. | `@deepseek-ai/dsh-goal` |
| `ctx.llm` | Adapter registry plus a streaming model-call API. | `@deepseek-ai/dsh-llm` |
| `ctx.clientModules` | The web plugin table service (dsh.client scan + wire + bundle route). | `@deepseek-ai/dsh-client-modules` |
| `ctx.timer` | Disposable timer helpers mixed into Cordis contexts. | `@deepseek-ai/cordis-plugin-timer` |
| `ctx.planMode` | Owns logged plan state and the `/plan` command. | `@deepseek-ai/dsh-plan-mode` |
| `ctx.tokenMeter` | Replay owner for one service-wide estimator and per-session folds. | `@deepseek-ai/dsh-token-meter` |
| `ctx.workspaceFiles` | Host Remote service over the composed filesystem, confined to one workspace. | `@deepseek-ai/dsh-api-workspace-files` |
| `ctx.workflowEngine` | Workflow Service Definition contract. | `@deepseek-ai/dsh-workflow` |
| `ctx.invariants` | Package-owned invariant registry. | `@deepseek-ai/dsh-invariants` |
| `ctx.lsp` | The LSP capability seam. | `@deepseek-ai/dsh-lsp` |

The pattern used everywhere (including in DSH's own docs) is a **type-only import** that pulls in the
declaration merge without creating a runtime edge:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'   // brings `ctx.settings` into scope
```

Full roster (all 68 keys, from `api-catalog.ts`): `agentDefaultModel`, `agentLoop`, `agentPresets`, `agents`,
`agentTeams`, `approval`, `attachments`, `authorization`, `clientModules`, `codeRuntime`, `commands`,
`compaction`, `credentials`, `credentialsController`, `deepseekLlmApiExtensions`, `directoryPicker`,
`directoryPickerController`, `e2b`, `fileReferences`, `fileUploads`, `fs`, `goals`, `inspector`, `invariants`,
`jobs`, `llm`, `lsp`, `messageFeedback`, `permissionPresets`, `planMode`, `sandbox`, `sandboxPolicy`,
`sessionController`, `sessionFileReferences`, `sessionPersistence`, `sessionProjectionCache`,
`sessionProjections`, `sessionQuery`, `sessionReferenceResolver`, `sessions`, `sessionSkillCatalog`,
`sessionTelemetry`, `sessionTitle`, `settings`, `settingsController`, `shell`, `shellEnv`, `skills`,
`spillStore`, `storage`, `storageDomain`, `subagentModelSelection`, `subagents`, `subprocess`, `systemPrompt`,
`terminals`, `timer`, `tokenMeter`, `toolResultPruner`, `tools`, `typert`, `typertGateway`, `userQuestions`,
`web`, `webhookRuntime`, `webServer`, `workflowEngine`, `workspaceController`, `workspaceFiles`,
`workspaceRegistry`.

**Hooks.** There is no `ctx.hooks` service. "Hook system" is the *pattern* of listening on typed extension
points — `docs/cookbook/extension-cookbook.md:106`: *"Hook system (user + project level) → listeners on
`agent/session-start`, `agent/pre-step`, `agent/request`, `tools/pre-execute`, `tools/post-execute`, and
`agent/turn-stopping`"*; and `:13`: *"A 'native hook' is an ordinary Cordis plugin on an interception point; it
needs no external protocol."* The `dsh-hooks-claude-code` / `dsh-hooks-codex` packages are bridges that map
external hook config files onto those extension points.

**Events.** `ctx.on(name, handler)`, `ctx.once`, `ctx.emit`, and the waterfall `next()` convention. Event
dispatch modes (`emit` vs `waterfall`) are documented per event in the generated catalog and in
`docs/event-producer-consumer.md`; the primer section is
`docs/cordis-primer.md#dispatch-modes`.

**Lazy/optional injection.** When a service may legitimately be absent, do not put it in the module-level
`inject`. Use the nested form — `ctx.inject(['settings'], (sctx) => { … })` — which runs the callback only
while that service exists. The rationale is spelled out by a real third-party plugin
(`dshmarket/src/client/index.ts:202-206`): naming the service in the module-level `inject` "would keep this
whole plugin unmounted on any host without that service — the market's own page would vanish … Nested, the card
simply never appears there." The same rule is used on the host side by `dsh-free-search/lib/index.js:3724-3761`
(`ctx.inject(['settings'], …)`, `ctx.inject(['webServer', 'settings'], …)`,
`ctx.inject(['tools'], …)`, `ctx.inject(['systemPrompt'], …)`).

`ctx.get(name)` is the runtime lookup for a service that may arrive later than your plugin.
`dsh-free-search/lib/index.js:3255-3256`:

```js
// credentials 服务可能晚于本插件挂载（跨 bundle 顺序），运行期动态获取而不是 apply 时缓存
const getCredentials = () => ctx.get('credentials');
```

*("The credentials service may mount later than this plugin — cross-bundle ordering — so fetch it dynamically
at runtime rather than caching it during `apply`.")*

---

## 6. HTTP routes from a host plugin

### 6.1 The service and method

`ctx.webServer` — `WebServer`, from `@deepseek-ai/dsh-host-webserver`
(`packages/host/webserver/src/index.ts:24`). `docs/subsystems/web-server.md:5`:

> "[dsh-host-webserver] is the browser HTTP carrier for the GUI host: a single `node:http` plugin providing
> `ctx.webServer`, a named-route registry, optional gzip response compression, index.html transform callbacks,
> and one fallback handler that a plugin may claim. … It knows no harness concepts, and another plugin registers
> every feature route, including the `/api` bridge, plugin bundles, and the HMR event stream."

Signatures (`docs/subsystems/web-server.md:69-127`, source `packages/host/webserver/src/index.ts`):

```ts
register(route: WebRoute): () => void
registerUpgrade(route: WebUpgradeRoute): () => void
registerFallback(handler: WebRoute['handler']): () => void
tapIndex(transform: (html: string) => string): () => void
applyIndexTaps(html: string): string
collectIndexInjections(): IndexInjection[]
renderIndex(html: string): string
```

```ts
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
type WebRouteKind = 'exact' | 'prefix'

/** One named route registration. */
interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

Matching and ownership (`docs/subsystems/web-server.md:27`): exact table first, then longest matching prefix,
then the registered fallback. Registration order carries no request-facing semantics. **A duplicate
`(kind, path)` throws** — "route patterns are a composition-level contract and a collision is a
misconfiguration." The fallback seat has **one owner only**; a second registration throws.

There is **no Express, no Hono, no middleware** in this path. It is a bare `node:http` handler registry. (A
plugin may of course bundle Express/Hono privately and register a single `prefix` route that delegates.)

### 6.2 Registration and disposal — the real pattern

`dsh-free-search/lib/index.js:3744-3761` is the canonical third-party shape:

```js
ctx.inject(["webServer", "settings"], (sctx) => {
  sctx.effect(() => {
    const disposers = makeBridgeRoutes(
      sctx.settings,
      (request) => provider.search(request, undefined),
      (engine, query, timeRange) => { /* … */ },
      getCredentials
    ).map((route) => sctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "free-search: settings bridge");
});
```

and one route from `makeBridgeRoutes` (`dsh-free-search/lib/index.js:2957-2965`):

```js
return [
  {
    kind: "exact",
    path: `${BRIDGE_PREFIX}/describe`,
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      writeJson(res, 200, await handlers.describe());
    },
  },
  // …
]
```

with (`dsh-free-search/lib/index.js:88`) `const BRIDGE_PREFIX = "/api/dsh-free-search-settings";`.

### 6.3 URL prefix convention, auth and CSRF

**Prefix.** Two conventions coexist:

* `/plugins/...` — **reserved.** The client-modules registry owns it
  (`docs/subsystems/client-modules.md:85`). Do not register there.
* `/api/<plugin-slug>/...` — the community convention for a plugin's own host bridge. `dsh-free-search` uses
  `/api/dsh-free-search-settings/*`.

The shipped Web client's own transport lives under `/api` too, but it is the **generated Remote** path served by
`dsh-api-gateway` + `dsh-client-connection`. Registering a raw route under `/api/<your-slug>/...` does **not**
give you the gateway's typing, correlation, or cancellation — it is a plain HTTP endpoint.

**Auth / CSRF — read this carefully.** `docs/subsystems/web-server.md:47`:

> "The carrier itself owns **no TLS, authentication, or Origin policy**, so a non-loopback bind exposes the
> server unless the composition supplies those controls. … The shipped `dsh web` command selects loopback and
> rejects `--host 0.0.0.0`; **its Connection plugin supplies Host/Origin checks plus browser-session
> authentication for every Host API route and stream.** Other compositions own their bind and route-auth
> policy."

So: the trust fence is applied by `client/connection` to **the routes it registers**, not globally. A
third-party route is **unauthenticated by default**. The evidence is that a real, popular third-party plugin
implements its own guard rather than relying on the host:

`dsh-free-search/lib/index.js:2945-2955`:

```js
const guard = (req, res) => {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { error: "loopback requests only" });
    return false;
  }
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
    return false;
  }
  return true;
};
```

The connection config that *would* protect you, if your route went through the gateway
(`docs/config-catalog.md:346-364`):

```ts
export interface ConnectionConfig {
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by; the Web runtime derives LAN IP literals from an active all-interface
   * bind. An entry that is not a bare, canonical authority fails plugin load.
   */
  trustedHosts?: string[]
  /** Absolute browser-session lifetime in days. Default: 30. */
  cookieMaxAgeDays?: number
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
}
```

**Practical guidance for a third-party plugin:** accept the loopback-only posture and defend your route
yourself (origin check + method check + a body-size cap). A minimal, correct pattern to copy:

```ts
function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}
```

`dsh-free-search` additionally writes `referrer-policy: no-referrer` on every JSON response and caps the body
(`MAX_JSON_BODY_BYTES`) while reading it (`dsh-free-search/lib/index.js:2699-2719`).

### 6.4 How the browser half reaches it

Plain `fetch` to the same origin. There is no generated client, no RPC, no injected transport. The
`dsh-free-search` browser half POSTs to `${BRIDGE_PREFIX}/describe` and `${BRIDGE_PREFIX}/mutate` with a JSON
body and reads a `{ ok, value } | { ok, code, message }` envelope
(`dsh-free-search/lib/client.js:1766` comment: *"配置读写走自建 bridge（/api/dsh-free-search-settings），不依赖
dsh-web-ui"* — "config read/write goes through a self-built bridge … it does not depend on dsh-web-ui").

Two alternatives that avoid a hand-rolled bridge entirely:

1. **The generated Remote path** (§2.8) — typed, correlated, cancellable, and it *does* ride the trust fence.
2. **`ctx.settingsScope`** in the browser half — reads/writes through the settings controller's Remote
   namespace, revision-fenced. `docs/cookbook/adding-a-settings-card.md:50-51`: *"It reads and writes through
   `ctx.settingsScope`, which fences each write with the revision it read."*

### 6.5 Index injection and the fallback seat

If a plugin needs to add markup to `index.html`, it should not `tapIndex` (raw HTML string surgery). It should
contribute a structured row on the `webserver/index-inject` emit
(`docs/subsystems/web-server.md:138-150`), which is what `dsh-client-modules` does with the boot manifest.
`tapIndex` is documented as "the escape hatch for markup no `IndexInjection` row expresses"
(`docs/subsystems/web-server.md:98`). `registerFallback` is effectively reserved: the shipped Web composition
claims it with `dsh-host-frontend-static` (the SPA dist server).

---

## 7. The client (browser) half — build contract

### 7.1 What must be true

1. `package.json` declares `dsh.client` with `platform: 'web'` (§2.4).
2. `exports["./client"]` resolves to the built bundle.
3. The bundle is the **lazy-CJS factory artifact** (§1.4).
4. It exports `apply` (and optionally `inject`, `Config`) via `module.exports`.
5. Every bare specifier it leaves as `require(...)` must be **satisfiable by the module table**.

### 7.2 The in-tree preset — `packages/client/tsdown.client.ts`

`packages/client/tsdown.client.ts:1-10` (module JSDoc):

> "Shared tsdown preset for UI plugin client bundles. Emits a closure-factory artifact: the bundle calls
> `window.__ModuleLoader__.load({id, factory})` and resolves externals through the injected require (loader
> module table — cordis DI entities, no globals, no import map). CSS is compiled by lightningcss inside the
> bundle: `x.module.css` yields its hashed class map and injects a tagged style at factory execution, while
> `x.css?inline` exports compiled text for a plugin-owned lifecycle effect."

The entry point (`:107-124`):

```ts
export function clientBundle(
  id: string,
  libEntry: readonly string[],
  options: ClientBundleOptions = {},
): BuildFaceConfig
```

used in-tree as a three-liner (`docs/cookbook/adding-a-settings-card.md:96-100`):

```ts
import { clientBundle } from '../tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-client-my-plugin', ['lib/types/index.js', 'lib/types/invariant.js'])
```

**What it bundles / externalizes** (`:428-570`):

```ts
function clientConfig(id: string, entry: string): UserConfig {
  const isRequested = (specifier: string): boolean => clientExternals(id).has(specifier)
  return {
    name: `${id}/client`,
    entry: { client: entry },
    outDir: 'lib',
    format: 'cjs',                 // ← the lazy-CJS requirement
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: isRequested,
      // Anything NOT requested from the loader module table must inline
      // (wire/type layers, zod, clsx — every non-shared dep). A require() the
      // table cannot answer is a guaranteed runtime throw, so the rule is the
      // package's own request list: requested specifiers stay imports,
      // everything else is bundled.
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    // …
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapExcludeSources: false,
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}
```

`clientExternals` (`:406-416`) is **baseline ∪ package-specific requests**:

```ts
const externals = new Set([
  ...PLATFORM_MODULES,
  ...PRELOADED_CLIENT_EXTERNALS,
  ...requestedExternals(id, workspaceManifest(id).dsh?.client ?? {}),
])
```

**The purity gate** (`:482-499`) — a build-time mirror of the module-edge rules:

```ts
name: 'dsh-client-bundle-purity',
resolveId(source: string) {
  if (!source.startsWith('@deepseek-ai/')) return null
  if (isRequested(source)) return null              // requested module-table row: external wins
  if (VENDORED_LIBRARY.test(source)) return null    // vendored library: inline, no shared identity
  if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
  throw new Error(
    `client bundle purity: "${source}" is not in the default client externals or ${id}'s dsh.client.external, `
    + 'an inline-safe wire layer, or a generated /remote contribution — '
    + 'cross-plugin value imports are forbidden; declare a non-default module request or collaborate through cordis services '
    + '(type-only imports are erased and never reach this gate)',
  )
}
```

with (`:61`):

```ts
export const INLINE_SAFE = /^(?:@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|deque|output-retention|typert-protocol|util-crypto|util-values|util-workspace-path)(?:\/|$)|@deepseek-ai\/dsh-token-meter\/client$|@deepseek-ai\/dsh-host-open-in-app\/shared$|@deepseek-ai\/dsh-agent-presets\/display$|@deepseek-ai\/dsh-spill-policy\/notice$)/
```

Also in the preset: `define` substitutions for `process.env.NODE_ENV`, `import.meta.env.MODE`, `import.meta.env`,
plus `clientBuildEnvironmentDefines(process.env)` (`:476-481`), and three CSS virtual-id plugins.

### 7.3 **Can an out-of-tree plugin build with plain esbuild/tsup?**

**Yes — and it must, if it wants to use those tools.** `docs/cookbook/adding-a-settings-card.md:102`:

> "No published preset exposes this package, so a package outside this repository has to reproduce the same
> output format itself. The bundle-purity gate also rejects value imports across plugins, so a card cannot
> import this section's card chrome or its staged-form model — it renders its own, and owns its own staging and
> revision fencing."

`packages/client/tsdown.client.ts` is **not published** — it is a repo-level file (`packages/client/`), it
imports from `./modules/src/client/manifest.ts`, `./web/src/platform.ts`, and
`../../scripts/client-build-environment.ts` — all repo-relative paths. There is no `@deepseek-ai/dsh-client-preset`
package on npm. Evidence: every third-party plugin inspected ships its own build pipeline:

| Plugin | Browser bundle built by | Format probe |
|---|---|---|
| `dsh-free-search` | esbuild/rolldown-equivalent; `lib/client.js` is hand-rolled-shape CJS with the `__ModuleLoader__` banner | `lib/client.js:1-9`, `:1817-1821` |
| `dsh-bash-terminal-ts` | `node scripts/build-client.mjs` (esbuild `^0.28.2` in `devDependencies`), emitting `dist/client.js` + `dist/client.core.js` | `package.json` `scripts.build:client`, `exports["./client"] → ./lib/client.js` |
| `dshmarket` | ships TypeScript source (`src/client/index.ts`) and its own client bundle at `client/client.js` | directory listing |

**What an out-of-tree esbuild config must reproduce** (the whole contract):

```js
// build-client.mjs — the four non-negotiables
await esbuild.build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',                 // 1. CJS
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  external: [                    // 2. exactly the baseline + your dsh.client.external
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
  ],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: "window.__ModuleLoader__.load({ id: 'my-plugin', factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;" },   // 3. banner
  footer: { js: 'return module.exports; } });' },                                                                                   // 4. footer
})
```

If you take this route, **reproduce the purity rule by hand**: never `require()` an `@deepseek-ai/dsh-*`
package outside the baseline list and outside your own `dsh.client.external`; use `import type` for
cross-plugin declarations.

### 7.4 Minimal `client.js` source shape

The in-repo authoring shape (TypeScript, before bundling):

```tsx
// src/client/index.tsx
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the keyed slot's declaration. Cross-plugin collaboration goes
// through cordis services; a value import fails the client bundle-purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
    { name: 'settings.plugin.item', key: 'my-plugin' },
    () => <div>hello</div>,
  ))
}
```

`import type {} from '<other-plugin>/client'` is the **required** pattern for pulling in another package's
`SlotMap` declaration merge (`docs/cookbook/adding-a-settings-card.md:53-56`).

The corresponding built artifact is exactly the `dsh-free-search/lib/client.js` shape quoted in §1.4.

### 7.5 Client HMR (development loop)

`docs/subsystems/client-modules.md:103`:

> "In development, [dsh-client-hmr] is the registry's watch driver: its node half stat-polls every graph row's
> bundle from the module host's pre-read baseline, calls `rebuilt(id)` only for a changed or dirty row, resyncs
> its watch set through `onGraphChanged`, and broadcasts rev changes to the browser half over SSE.
> **Source-map changes alone do not trigger a reload**; the current map joins the snapshot when a bundle change
> does. Production graphs omit the HMR row entirely; **the module host itself never watches files.**"

`rebuilt(id)` is the **only** entry point through which changed bundle content reaches the graph
(`docs/subsystems/client-modules.md:101`). In-tree the watcher is `pnpm run dev:web`; the CLI reference
confirms it is a *separate* process (`apps/cli/reference/README.md:70`): *"The client-plugin HMR receiver is
always mounted and stays idle until a separate `pnpm run dev:web` watcher rebuilds client bundles."*

`packages/client/AGENTS.md:142` states the operational consequence plainly:

> "Rebuild the bundle (`pnpm --filter <pkg> bundle`) before probing a live `dsh web` server — **the registry
> serves `lib/client.js`, not sources.**"

---

## 8. Slots / UI contribution

### 8.1 The one API

`packages/client/AGENTS.md:11`:

> "**One API**: a plugin composes UI only through `ctx.slots.register({ name, children?, store?, inject? },
> Component)`. There is no separate slot-definition call, no whitelist face object, no face-minting helper. The
> shell alone renders `'root'`."

`ctx.slots` is declared in `packages/client/ui-renderer/src/client/index.ts:44` (`slots: SlotRegistry`) and
implemented in `packages/client/ui-renderer/src/client/registry.ts`. Import specifier:
`@deepseek-ai/dsh-client-ui-renderer` (declaration) — but in practice a plugin declares
`declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { … } }` and imports the keyed slot's
declaration type-only from its owner package.

### 8.2 `register` options

`packages/client/ui-slots/src/index.ts:565-589`:

```ts
/** Common register options share (see {@link SlotCore.register} for semantics). */
type BaseOptions<K, EntryKey, D, H, M = never, N = undefined> = {
  /** Target slot key (the entry contributes INTO this slot). */
  name: K
  /** Child-slot declaration + render authorization + runtime spec, in one table. */
  children?: D
  /** Store seat: a shared handle (apply-constructed) or an exclusive factory (framework-called per entry x scope). */
  store?: H
  /** Dictionary namespace of this entry's copy. … */
  locale?: N
  /** Registrant identity label for diagnostics … */
  registrant?: string
} & KindOptions<K, EntryKey, M>
```

`KindOptions` supplies the kind-specific fields (`packages/client/ui-slots/src/index.ts:520-548`):
`key` for `keyed`, `id`/`order`/`label` for `list`, `select` for `chain`, and `priority` for
`single`/`list`/`keyed`/`chain` (a shadowing rank; **lower values run/render first**).

Load-time validation (`packages/client/ui-slots/src/index.ts:745-776`): registering into an **undeclared** slot
throws; declaring an already-declared child key throws; mounting one shared store handle under slots of
different scopes throws; **keyed without `key` throws; list without `id` throws; chain without `select`
throws**; a second registration at an occupied cell's exact priority (default `0`) throws naming the occupant.

### 8.3 `inject` — waiting for someone else's declaration

`packages/client/ui-renderer/src/client/registry.ts:157-172`:

> "Install an effect for each declaration lifetime of a slot. The callback runs synchronously when the
> declaration already exists; otherwise it runs inside the declaring `register()` call after the declaration is
> committed. Collapse disposes the effect and a later declaration runs it again."

Use it whenever you contribute into another package's slot:

```ts
ctx.slots.inject('conversation.session.header.actions', () =>
  ctx.slots.register({ name: 'conversation.session.header.actions', id: 'review', order: 100 }, HeaderAction))
```

`packages/client/AGENTS.md:141` adds the transactional variant: *"Return a generator yielding each registration
when several contributions must install and roll back atomically."*

### 8.4 Available slot names

The **generated Client inspect catalog** is the exhaustive contract, and a running dynamic package can query the
live tree (`docs/subsystems/slots.md:170`):

> "The generated Client inspect catalog is the exhaustive contract for each key: cardinality, scope, owner
> props, standard props, current occupants, declaration owner, and replacement risk. A running dynamic package
> can query the live tree and an exact key with `cordis_inspect what:"client"`; the source catalog is generated
> from `SlotMap` declarations and `slots.register()` call sites by `pnpm run gen-client-catalog`."

Source of that catalog: `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`.

The shipped declaration tree (`docs/subsystems/slots.md:110-168`):

```text
root
├─ sidebar
│  ├─ sidebar.brand.mark
│  ├─ sidebar.brand.name
│  ├─ sidebar.footer.action
│  ├─ sidebar.workspaces
│  │  └─ sidebar.workspaces.directoryFlow
│  └─ sidebar.settings
│     ├─ settings.trigger
│     ├─ settings.header
│     ├─ settings.action
│     ├─ settings.close
│     ├─ settings.onboarding
│     └─ settings.section
│        ├─ settings.general.item
│        ├─ settings.models.provider-card
│        ├─ settings.models.footer
│        └─ settings.plugins.tab
│           └─ settings.plugin.item
├─ conversation
│  ├─ conversation.session
│  │  └─ conversation.view
│  │     ├─ conversation.chat.node
│  │     │  ├─ conversation.chat.assistant-actions
│  │     │  ├─ conversation.chat.commandview
│  │     │  ├─ conversation.chat.turnTail
│  │     │  └─ tool.call.toolview
│  │     │     ├─ tool.call.images
│  │     │     └─ tool.view.cordis
│  │     ├─ conversation.message.images
│  │     └─ conversation.trajectory.images
│  ├─ conversation.session.header
│  │  ├─ conversation.session.header.lineage
│  │  ├─ conversation.session.header.actions
│  │  ├─ conversation.session.header.utilities
│  │  └─ conversation.session.header.corner
│  ├─ conversation.composer
│  │  └─ conversation.approval.detail
│  ├─ conversation.composer.bar
│  │  ├─ conversation.input.attachments
│  │  ├─ conversation.input.plan
│  │  └─ conversation.input.model
│  ├─ conversation.input.overlay
│  ├─ conversation.input.dock
│  ├─ conversation.composer.dock
│  ├─ conversation.input.left
│  ├─ conversation.input.right
│  ├─ conversation.hero.brand.mark
│  ├─ conversation.hero.workspace
│  │  └─ conversation.hero.workspace.directoryFlow
│  └─ conversation.hero.agentPreset
├─ rightbar
│  ├─ sidebar.right.pane.tab
│  │  └─ sidebar.right.tab.guide
│  ├─ sidebar.right.pane.tab.title
│  └─ sidebar.right.tab.menu.item
└─ shell.overlay
```

**The four slots a third-party plugin most often wants:**

| Slot | Kind / scope | Use | Evidence |
|---|---|---|---|
| `shell.overlay` | `list`, `root` | **Full-page / frame-wide overlay.** The only `root`-list seat that is additive and safe to register into. | `packages/client/ui-layout/src/client/index.ts:90` `'shell.overlay': { kind: 'list'; scope: 'root' }`; rendered at `packages/client/ui-layout/src/client/AppFrame.tsx:239` |
| `settings.plugin.item` | `keyed`, `root` | One plugin's **settings card**, keyed by the settings namespace it edits. | `packages/client/ui-settings-plugins/src/client/slot-contract.ts:16-21` |
| `sidebar.right.pane.tab` | `keyed`, `session` | A **right-sidebar tab body**, keyed by the tab type's `id`. | `packages/client/ui-sidebar-right/src/client/index.ts:150` |
| `sidebar.right.pane.tab.title` | `keyed`, `session` | Its optional live chip title. | `packages/client/ui-sidebar-right/src/client/index.ts:151` |

`root` itself is a trap, and the catalog says so explicitly
(`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:1407`):

> "DO NOT register here. This is a single slot, so a second entry does not sit beside the frame — it shadows
> it, and a dynamically registered entry is assigned a lower priority than the shipped one, which makes it the
> winner: the page would render your component alone, with every seat the frame declares gone. For a surface of
> your own that floats over the whole app, register into `shell.overlay` instead (a list slot: additive, and
> click-through until your entry opts into pointer events)."

### 8.5 Declaring module augmentation out-of-tree

Two augmentations matter:

**(a) Declaring a NEW slot** — only the component that owns and renders the location may do this
(`docs/subsystems/slots.md:175`). An out-of-tree plugin that wants its own child slot does:

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'my-plugin.panel.header': { kind: 'list'; scope: 'root' }
  }
}
```

…and then declares it in the parent registration's `children` and renders it with `renderSlot`. Declaring is
claiming: the registering entry becomes the only entry allowed to render that key
(`docs/subsystems/ui-slots README:40`).

**(b) Consuming an EXISTING slot's declaration** — import the owner package's `/client` entrypoint
**type-only**:

```ts
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
```

`docs/cookbook/adding-a-settings-card.md:53-56` explains the constraint:

```ts
// Type-only: the keyed slot's declaration. Cross-plugin collaboration goes
// through cordis services; a value import fails the client bundle-purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
```

The same pattern applies to resource protocols
(`docs/subsystems/client-resources.md:32-34`):

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap { note: NoteView }
}
```

**(c) Standard props** — `SessionStandardProps`, `SessionMaybeStandardProps`, `GlobalStandardProps`
(`packages/client/ui-slots/src/index.ts:194-209`) are the framework hook seats. Feature components **must not**
add to them (`docs/subsystems/slots.md:94`): *"A feature component should not create a React hook prop itself or
add a global standard prop for entry-private data."* Entry-private reactive data goes through the registration's
`inject` `hooks` compartment.

### 8.6 Component props — the four shares

`packages/client/AGENTS.md:13`:

> "Component props are the four shares, all derived: `PropsRuntime<K>` (SlotMap: owner params +
> `useSession`/`sessionId` on session scope + global `useSessions`/`useWorkspaces`) & `PropsRenderSlots<S>`
> (children keys) & `PropsStore<H>` (store factory) & the inject face. Never hand-write a member a share
> already derives; never re-type a share locally."

`PropsRuntime` (`packages/client/ui-slots/src/index.ts:222-232`):

```ts
export type PropsRuntime<K extends keyof SlotMap & string, EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>> =
  OwnerOf<K> &
  KeyPropsOf<K, EntryKey> &
  SlotInjectFace<SlotInjectOf<K>> &
  (ScopeOf<K> extends 'session' ? SessionStandardProps
    : ScopeOf<K> extends 'session-maybe' ? SessionMaybeStandardProps
      : object) &
  GlobalStandardProps
```

Framework-provided hooks by scope (`docs/subsystems/slots.md:81-90`): every scope gets `useSessions`,
`useSessionPendingInteraction`, `useWorkspaces`, `useResource`; `session` adds `sessionId`, `useSession`,
`useProjection`, `useConversation`, `useInput`, `inputActions`, `useChat`, `useTrajectory`.

**Components never receive `ctx`** (`packages/client/AGENTS.md:40`; `packages/client/ui-slots/README.md:32`).
All data arrives through the shares; services stay in the `apply` closure and are projected into callbacks or
observable sources via `inject`.

### 8.7 Complete minimal example — a `shell.overlay` panel

```tsx
// src/client/index.tsx
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'

type Props = PropsRuntime<'shell.overlay'>

function MyPanel(_props: Props) {
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    void fetch('/api/my-plugin/stats')
      .then(r => r.json())
      .then((v: { count: number }) => { if (alive) setCount(v.count) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  return (
    <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1000, pointerEvents: 'auto' }}>
      <button type="button" onClick={() => { setOpen(o => !o) }}>
        My panel {count === null ? '' : `(${count})`}
      </button>
      {open && <div role="dialog" aria-label="My panel">hello from my-plugin</div>}
    </div>
  )
}

export const inject = ['slots']

export function apply(ctx: Context): void {
  // inject() waits for the frame to declare the slot; the contribution dies with
  // the frame's declaration AND with this plugin's fiber.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'my-plugin-panel', order: 100, label: 'My panel' },
    MyPanel,
  ))
}
```

Notes that matter:

* `pointerEvents: 'auto'` is required — `shell.overlay` entries are click-through by default (catalog note).
* `id` is required (`list` kind).
* `order` is optional; lower renders earlier.
* A **full-page** panel is the same registration with `position: fixed; inset: 0`.

### 8.8 Complete minimal example — a right-sidebar pane

A right-sidebar tab is **two registrations sharing one `kind`** (`docs/subsystems/sidebar-right.md:13`): a
static definition in `ctx.sidebarRightTabs`, plus a keyed slot registration for its body. Verbatim from
`docs/subsystems/sidebar-right.md:52-71`:

```tsx
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

export const inject = ['sidebarRightTabs', 'slots']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: '@acme/dsh-client-ui-image',
    kind: 'image',
    patterns: ['*.png', '*.jpg', '*.gif', '*.svg'],
    canOpen: address => address.startsWith('dsh-resource://file/'),
    title: address => address.slice(address.lastIndexOf('/') + 1),
  }), 'image type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: '@acme/dsh-client-ui-image' },
    ImageBody,
  )), 'image body')
}
```

`id` is the key the body and title register under; `kind` is what `openTab` names; `priority` is one of
`'extension' | 'builtin' | 'fallback'` (`extension` is the default **and the highest** — an out-of-tree type
outranks every shipped viewer). Bodies read live tab state through the framework-injected `useTabInfo()`
returning `{ sidebar, panel, tab }` (`docs/subsystems/sidebar-right.md:102`).

---

## 9. Settings cards

### 9.1 The two halves and the join key

`docs/cookbook/adding-a-settings-card.md:5`:

> "Nothing in this path needs a change inside this repository: the Host serves every registered settings
> namespace, and the **Plugins** section keys its cards on the namespace they edit, so a plugin that registers
> both halves is paired up automatically."

The namespace is the join key. Spell it in both halves.

### 9.2 Host half — 0.1.3-alpha.2 (the checkout) contract

`docs/cookbook/adding-a-settings-card.md:13-43` (verbatim):

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

declare function assertReachable(endpoint: string | undefined): void
declare function rebuildFromSettings(config: Config): void

export const MY_PLUGIN_NS = 'my-plugin'

export interface Config {
  endpoint?: string
  retries?: number
}

export const Config: z<Config> = z.object({
  endpoint: z.string(),
  retries: z.number().step(1).min(0).default(3),
})

export function apply(ctx: Context, config: Config) {
  let source = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, MY_PLUGIN_NS, Config, config, {
      // Constraints the schema cannot express refuse the write, not the next use.
      validate: value => void assertReachable(value.endpoint),
      setSource: (current) => { source = current },
      onChange: () => { rebuildFromSettings(source()) },
    })
  })
}
```

`installSection` signature (`docs/subsystems/settings.md:205-215`):

```ts
installSection<const Namespace extends string, T>(
  owner: Context,
  ns: Namespace & SettingsNamespaceInput<Namespace>,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void
```

> "Attach one optional-settings consumer to this provider. The consumer registers its composition entry as the
> base layer while this provider is present, then falls back to that entry if the provider detaches."

Also available on the seam (`docs/subsystems/settings.md:182-274`): `register`, `describe`, `get`, `update`,
`replace`, `mutate`. Namespace must be lowercase kebab-case or `TypeError` is thrown.

`role('secret')` keeps a field off every response; `applies: 'restart'` tells a configuration surface the owner
acts on a change only at the next start (`docs/cookbook/adding-a-settings-card.md:46`).

### 9.3 Host half — 0.2.0-rc.2 (the installed runtime) contract

**`installSection` and `register` are gone.** The installed `@deepseek-ai/dsh-settings@0.2.0-rc.2` exposes
`configure`, `describe`, `update`, `mutate` — verified by grep of
`…\@deepseek-ai\dsh-settings\lib\index.js` (only `configure(` at :370, `describe(` at :413, `update(` at :470,
`mutate(` at :488; **no** `installSection`, **no** `register`).

The 0.2.0-rc.2 model, from the shipped `README.zh.md:12, 33, 39` (translated):

> "Edit fields a plugin declares with `.volatile()` and see their actual value. Forms identify a plugin by its
> **profile entry id**, preserve secret values, and refuse stale writes. Changes persist through the current
> profile's Cordis patch."
>
> "The form shows only volatile fields of **active and uniquely locatable profile entries**. Ordinary
> configuration is still edited through the Cordis config files."
>
> "A plugin that ships its own page registers the policy as an effect inside an optional
> `ctx.inject(['settings'], …)` child during `apply`: `configure({ auto: false }, ctx.fiber)`. The child names
> the plugin fiber the policy belongs to, and a late-loaded or replaced Settings service adopts that policy
> too, so a business plugin runs without Settings. The policy does not remove config read/write."

So on 0.2.0-rc.2 the whole host half is: **declare `Config` with `.volatile()` on each editable field**, and
optionally opt out of the auto-generated form.

This is exactly what the installed third-party plugin does
(`dsh-free-search/lib/index.js:3078-3129`):

```js
// rc.1 declares editable fields `.volatile()`: the Loader hands `apply` live
// references and commits profile edits in place without remounting. `resolveConfig`
// unwraps those references so every read sees the latest accepted value.
// `.volatile()` requires the scoped `@deepseek-ai/schemastery` (>= 3.18.2).
const Config = z.object({
  provider: z.string().default("bing").volatile(),
  disabledEngines: z.array(z.string()).default([]).volatile(),
  // …
  exaApiKey: z.string().role("secret").volatile(),
  // …
});
```

and (`dsh-free-search/lib/index.js:3724-3742`):

```js
ctx.inject(["settings"], (sctx) => {
  // rc.1 moved plugin configuration into the profile-owned Config, so the old
  // namespace-registration API is gone. Editable fields are declared `.volatile()`
  // on `Config` (above); this only records that the plugin ships its own settings
  // page (`auto: false`) so the host does not also generate a schema form. Values
  // persist per profile in `cordis.patch.yml` under this entry (`FREE_SEARCH_NS`).
  sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber));
  // …
  sctx.on("settings/document-updated", (ns) => {
    if (String(ns) === FREE_SEARCH_NS && typeof refreshPrompt === "function") refreshPrompt();
  });
});
```

The namespace on 0.2.0-rc.2 is **the composition entry id**, not an independently chosen name
(`dsh-free-search/lib/index.js:84-88`):

```js
// rc.1: settings moved into the profile-owned plugin Config. The namespace is the
// composition entry id (the `web-search-free` row the bundle's cordis.patch.yml
// declares), not the old `$DSH_HOME/settings.yaml` section name.
const FREE_SEARCH_NS = "web-search-free";
```

…and that id is exactly what its bundle patch declares (`dsh-free-search/cordis.patch.yml:28-34`):

```yaml
- insert:
    - id: web-search-free
      name: dsh-free-search
      config:
        provider: bing
        disabledEngines: []
        bingMarket: zh-CN
```

**This is the load-bearing insight for item 9:** *the entry `id` in your `cordis.patch.yml` IS your settings
namespace on 0.2.0-rc.2.* Pick it deliberately.

There is also a one-time legacy import: an early `$DSH_HOME/settings.yaml` is imported once at startup, each
section writing to the entry of the same name (`ui-developer-tools` → `ui-settings`, `ui-onboarding` →
`ui-settings-general`, `shell` → the current platform's shell executor entry), the file renamed to
`settings.yaml.imported` before the first write (installed `dsh-settings/README.zh.md:35`).

### 9.4 Browser half — the card

`docs/cookbook/adding-a-settings-card.md:52-69` (verbatim):

```tsx ignore-check
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the keyed slot's declaration. Cross-plugin collaboration goes
// through cordis services; a value import fails the client bundle-purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const card = new MyPluginCardController(ctx.settingsScope.bind({ namespace: 'my-plugin' }))
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'my-plugin',
    locale: 'settings.myPlugin',
    inject: () => card.inject(),
  }, MyPluginCard),
  )
}
```

The slot declaration (`packages/client/ui-settings-plugins/src/client/slot-contract.ts:16-27`):

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One plugin's card inside the plugin configuration section (see module JSDoc). */
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: SettingsPluginItemOwnerProps }
  }
}

/** Owner share of a plugin card (the section supplies nothing). */
export interface SettingsPluginItemOwnerProps {
  /** Marker field: card owner props are intentionally empty. */
  children?: never
}
```

Scope snapshot (`docs/cookbook/adding-a-settings-card.md:72`):

> "The scope snapshot carries what a form needs: the resolved `value`, the composition `base`, and the raw
> `user` layer, whose key **presence** — not its value — is what marks a field overridden.
> `scope.set(field, value)` stores one field and `scope.unset(field)` clears it back to the composition layer."

Dispatch (`docs/cookbook/adding-a-settings-card.md:74-78`):

> "The **Plugin configuration** tab reads which namespaces the Host serves and dispatches one slot key per
> namespace. A card is rendered when the Host serves its key and skipped when it does not, so a deployment that
> never composed the Host half shows no trace of the card. A served namespace no card claims renders nothing —
> that is how the namespaces owned by other pages (`ui-theme`, `permission`, `llm-*`) stay off this tab. Cards
> appear in the order they registered into the slot; a keyed entry declares no `order` of its own."

An in-repo card for reference — `packages/client/ui-settings-plugins/src/client/AgentLoopCard.tsx:10-13`:

```ts
export type AgentLoopCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<AgentLoopCardFace>
```

### 9.5 The `plugins.row.config` convention — third-party, 0.2.0-rc.2 only

**`plugins.row.config` does not exist in the checkout.** It belongs to
`@deepseek-ai/dsh-client-ui-plugin-manager@0.2.0-rc.2` (in the installed app; the checkout has **no**
`packages/client/ui-plugin-manager` and **no** `packages/boot/plugin-manager`).

The page declares three configuration slots
(installed `dsh-client-ui-plugin-manager/README.zh.md:60`, translated):

> "A plugin with its own configuration renders it on this page rather than in Settings, through the three slots
> this page declares: **`plugins.item`** (list) for official plugins, listed in the official group by their
> `label`; **`plugins.bundle.config`** (keyed by the bundle's package name) for a bundle's own configuration,
> shown on the bundle page between the description and the rows; **`plugins.row.config`** (keyed by
> `<package name>#<row id>`) for a single row's configuration — that row then gains a **Configure** control
> opening its own page. The page renders a form with its own save control via `view: 'page'`."

Verbatim example (`README.zh.md:62-68`):

```tsx ignore-check
ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
  name: 'plugins.row.config',
  key: '@acme/dsh-sidebar#sidebar',
  locale: 'acmeSidebar',
}, ({ t, view }) => view === 'summary' ? t('summary') : <SidebarForm t={t} />))
```

> "The bundle's patch must declare that row with that id; the registration exists only while the bundle is
> enabled, so a disabled bundle shows no Configure control." — `README.zh.md:70`

Confirmed against the installed JavaScript:

* Declaration table — `dsh-client-ui-plugin-manager/lib/client.js:3788-3791`:
  ```js
  "plugins.row.config": { kind: "keyed", scope: "root" },
  ```
  (and `:3784-3787` `"plugins.bundle.config": { kind: "keyed", scope: "root" }`, `:3776-3779`
  `"plugins.item": { kind: "list", scope: "root" }`)
* Key builder — `lib/client.js:27-29`:
  ```js
  function rowConfigKey(bundle, rowId) {
    return `${bundle}#${rowId}`;
  }
  ```
* Owner dispatch — `lib/client.js:2415-2418`:
  ```js
  children: [renderSlot("plugins.row.config", { … }, { entryKey: key }), renderSlot("plugins.detail.section", { subject })]
  ```
* The host-side toggle writes a `disabled` override into the profile's `cordis.patch.yml`
  (`README.zh.md:56`: "The row's switch calls `pluginManager.setPluginEnabled`, writing that row's `disabled`
  override into the profile's `cordis.patch.yml`").

**The real third-party usage** — `dsh-free-search/lib/client.js:1762-1778`:

```js
function apply(ctx) {
  // 挂插件页 slot：侧栏 插件 → 已安装 → free-search → 行配置页。
  // rc.1 废弃了旧版设置页的插件配置 slot，只保留 plugins.row.config；
  // key 规则见 ui-plugin-manager 的 rowConfigKey：<包名>#<patch 里声明的行 id>。
  // 配置读写走自建 bridge（/api/dsh-free-search-settings），不依赖 dsh-web-ui。
  ctx.slots.inject("plugins.row.config", () =>
    ctx.slots.register(
      {
        name: "plugins.row.config",
        key: "dsh-free-search#web-search-free",
      },
      (slotProps) =>
        slotProps && slotProps.view === "summary"
          ? summaryText()
          : react_jsx_runtime.jsx(FreeSearchCard, { page: true })
    )
  );
  // … /free-search-engine command …
}
```

So the key is `dsh-free-search#web-search-free` — package name `dsh-free-search`, row id `web-search-free` from
its `cordis.patch.yml:29`. **The row id must exist in the bundle's own patch**, or the Configure control never
appears.

**Which to use?**

| Target version | Settings card seat |
|---|---|
| 0.1.3-alpha.2 (checkout) | `settings.plugin.item`, plus `ctx.settings.installSection(...)` on the host |
| 0.2.0-rc.2 (installed) | `plugins.row.config` (keyed `<pkg>#<rowId>`) **or** `plugins.bundle.config` (keyed by package name), plus `.volatile()` Config fields on the host; `settings.plugin.item` also still exists in 0.2.0-rc.2 (`packages/client/ui-settings-plugins` is present in both) |

The robust third-party pattern is to register into **both**, guarded by `slots.inject` — because
`slots.inject` waits for the slot to exist, so a host that never declares one simply never runs that
registration. That is precisely what `dshmarket` does, with the reasoning in its source
(`dshmarket/src/client/index.ts:228-230`):

> "Detection is the slot itself: `slots.inject` waits for the slot to exist, so a host that never declares it
> (every release before 0.1.7) never runs this, and no version string is consulted."

---

## 10. Commands

### 10.1 Host side — the registry

`ctx.commands` — `CommandRuntime`, from `@deepseek-ai/dsh-commands`
(`packages/interaction/commands/src/index.ts:112`). Import specifier for the augmentation:
`@deepseek-ai/dsh-commands`. Registry signature (`docs/subsystems/commands.md:134-139`):

```ts
/**
 * Register a global or calling-agent-scoped command.
 * @param definition - discovery metadata and direct UI handler.
 * @returns the exact effect disposer that unregisters this definition.
 */
register(definition: CommandDefinition): () => void
```

Definition (`docs/subsystems/commands.md:33-51`):

```ts
/** Plugin-owned command registration. */
interface CommandDefinition {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery UI. */
  readonly description: string
  /** Optional free-form input hint advertised to capable clients. */
  readonly input?: CommandInputDescriptor
  /**
   * Whether `command/run` records `rawInput`. Defaults to true. A command
   * whose domain event owns the payload sets this false to avoid duplicating
   * that payload in the session log.
   */
  readonly recordInput?: boolean
  /** Execute against the receiving agent without sending the command to the model. */
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}
```

Invocation and result (`docs/subsystems/commands.md:57-89`):

```ts
interface CommandInvocation {
  readonly commandId: CommandId
  readonly agent: Agent
  /** Exact text following the registered command name, including separator whitespace. */
  readonly rawInput: string
  readonly attachments: readonly (ImageBlock | FileBlock)[]
  /** Cancellation signal owned by the dispatching UI request. */
  readonly signal: AbortSignal
}

/** Expected command outcome rendered directly by the dispatching UI. */
type CommandResult =
  | {
    readonly kind: 'success'
    readonly text?: string
    /** Earlier authoritative domain event that owns a richer presentation. */
    readonly sourceEventSeq?: SessionSeq
  }
  | { readonly kind: 'error'; readonly text: string }
```

Key properties (`docs/subsystems/commands.md:1-5, 55`):

* A plugin-owned command for **an exact agent without creating a model message**.
* `rawInput` begins immediately after the parsed name and retains the adapter-delivered separator and suffix.
* Results are **direct UI outcomes, not tool results or session events**.
* Lifecycle: `command/run` is appended **before** the handler is invoked and `command/done` after settlement; a
  thrown or aborted handler settles as `kind: 'error'`. Both are direct log-only appends — no turn wraps them.
  Admission misses (syntax or unknown name) log nothing
  (`docs/subsystems/commands.md:166-175`).
* Registration is scoped: definitions registered through a command-injected child of an agent context shadow
  globals **for that agent** (`docs/subsystems/commands.md:131`).
* Event: `commands/change` (emit, no args) when the registry mutates (`docs/subsystems/commands.md:206`).

### 10.2 Browser side — the popup command UI (third-party convention)

`dsh-free-search` registers its command in the **client** half through the `commandUi` service, not through
`ctx.commands`. `dsh-free-search/lib/client.js:1779-1813`:

```js
// /free-search-engine 弹出式命令：输入 "/" 选中后弹出引擎列表，点选即切换。
// 等效于设置页切换引擎+保存；命令只改 provider 配置，搜索仍走回退链。
// description 必须传函数：ui-commands 读回的是 contribution.description()，
// 传字符串会抛 TypeError: contribution.description is not a function；该异常
// 会让整份 "/" 候选列表一起失败，菜单空白、其他命令也一起点不到。
ctx.inject(["commandUi"], (sctx) => {
  const command = sctx.get("commandUi");
  sctx.effect(() => {
    const dispose = command.register({
      name: "free-search-engine",
      description: () => "切换搜索引擎 / Switch web search engine",
      available: () => true,
      ui: {
        kind: "popupSelect",
        options: async () => { /* … */ },
        onSelect: async (option) => {
          await bridgeMutate({ ns: NS, ops: [{ op: "set", path: ["provider"], value: option.id }] });
        },
      },
    });
    return dispose;
  }, "free-search: /free-search-engine command");
});
```

**The hard-won lesson is in that comment**: `description` **must be a function**. The `ui-commands` package
reads `contribution.description()`, so passing a string throws
`TypeError: contribution.description is not a function` — and that single exception makes the **entire `/`
candidate list fail**, leaving the menu blank and every other command unclickable.

`commandUi` comes from `@deepseek-ai/dsh-client-ui-commands`
(`packages/client/ui-commands/src/index.ts` module JSDoc: *"via exports[\"./client\"], discovered through the
package.json dsh.client declaration"*).

---

## 11. Install & run loop for a third-party (out-of-tree) plugin

### 11.1 Where the plugin goes

```
$DSH_HOME/profiles/<profile-name>/
├── package.json         # profile manifest: dependencies + dsh.profile
├── cordis.patch.yml     # the user's own patch layer (applied after every bundle layer)
├── cordis.yml           # (present but effectively empty in the shipped desktop profile)
├── pnpm-workspace.yaml  # pnpm allowBuilds allowlist lives here
├── pnpm-lock.yaml
└── node_modules/        # pnpm-managed; the plugin itself lands here
```

On this machine: `$DSH_HOME` = `C:\Users\massnote\.dsh`, profile `desktop`, so
`C:\Users\massnote\.dsh\profiles\desktop\node_modules\<your-plugin>\`.

`docs/user/develop/basic/publish.md:14`: *"A **profile** is a directory under `$DSH_HOME/profiles/<name>`
describing one runnable composition."*

### 11.2 Exact user steps (shipped CLI)

`docs/user/develop/basic/publish.md:77-110` + `apps/cli/reference/README.md:44-56`:

```sh
# 1. Install the package into a profile (forwards to pnpm with the profile dir as cwd).
dsh plugin --profile desktop add ./my-plugin            # local checkout
dsh plugin --profile desktop add my-plugin              # from npm
dsh plugin --profile desktop add github:you/my-plugin   # from a git host

# 2. Verify the layer without booting.
dsh --profile desktop --dump-config      # shows a "# == my-plugin" layer

# 3. Boot / restart.
dsh --profile desktop

# 4. Remove (drops both dependency and layer).
dsh plugin --profile desktop remove my-plugin
```

What `dsh plugin` does for you (`apps/cli/reference/README.md:46`):

> "`dsh plugin --profile <name> <args...>` initializes the profile when missing (shipped template, or
> `@deepseek-ai/dsh-base` alone for other names), then forwards `<args...>` to **pnpm with the profile directory
> as working directory** — `add`, `remove`, `why`, `update`, and every other pnpm verb work unchanged; pnpm must
> be on PATH. Relative path specs (`.`, `../plugin`, and their `file:`/`link:` forms) are anchored to the
> invoking directory first, so `add .` from a plugin checkout installs that checkout, not the profile. **After
> every successful run, `dsh.profile.bundles` is reconciled against the installed state**: each dependency
> resolving to a package whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` joins
> the layer stack (so an `update` that gains the declaration activates it), a bundle-less dependency stays plain
> with a one-time warning, and a removed dependency leaves the stack."

**So the user never edits the profile manifest by hand** — `dsh plugin` maintains `dependencies` **and**
`dsh.profile.bundles` (`docs/user/develop/basic/publish.md:73`: *"You never write a profile manifest by hand:
`dsh plugin` creates and maintains it."*). The result of `dsh plugin --profile demo add ./hello-plugin`
(`docs/user/develop/basic/publish.md:86-101`):

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": { "dsh-hello-plugin": "link:/path/to/hello-plugin" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-hello-plugin"] } }
}
```

**`pnpm install` location.** The profile directory. You *can* run pnpm directly there
(`cd $DSH_HOME/profiles/desktop && pnpm add <pkg>`) — that is literally what `dsh plugin` does — but then you
must also append the bundle name to `dsh.profile.bundles` yourself, because the reconciliation runs only inside
`dsh plugin`.

**Git installs need a build allowance** (`docs/user/develop/basic/publish.md:153-173`):

> "But a git install fetches **sources, not built artifacts**: nothing runs your `build` script, so a TypeScript
> package arrives without its `lib/` output and fails to load. … pnpm ≥10 refuses to run a git dependency's
> `prepare` script until it is explicitly allowed, so the first `add` fails; `dsh` points at the fix — copy the
> exact package key pnpm printed into the profile's `pnpm-workspace.yaml`:
>
> ```yaml
> allowBuilds:
>   dsh-hello-plugin: true
> ```
>
> and re-run the `add`. Treat that allowance as **permission to execute the package's code on your machine at
> install time**, outside any sandbox the agent runs under. Only allow packages whose source you trust, and pin
> a commit (`github:you/hello-plugin#<sha>`) so a later push cannot silently change what runs."

Neither npm publication nor a `pnpm pack` tarball needs any build permission
(`docs/user/develop/basic/publish.md:175-178`).

### 11.3 Bundle-set changes vs. patch-file changes — **this is the reload boundary**

| Change | Takes effect |
|---|---|
| Adding / removing / updating a **bundle** (profile `dependencies` + `dsh.profile.bundles`) | **Restart required.** `apps/cli/reference/README.md:58`: *"The successful pnpm operation changes the Profile manifest and Bundle list on disk; a running Profile keeps the Bundle set from its current start. Restart that Profile after adding, removing, or updating a Bundle."* |
| Ordinary edits to the **profile** `cordis.patch.yml` or the **home** `$DSH_HOME/cordis.patch.yml` | **Hot reload** in a `patchReload: live` profile. |
| Editing a **bundle's own** `cordis.patch.yml` | Not watched by the launcher; effectively a restart. |
| Editing a **client** bundle (`lib/client.js`) | Client HMR if `dsh-client-hmr` is mounted **and** a watcher rebuilds the bundle. |
| Editing a **host** plugin source | Host HMR only with `@deepseek-ai/cordis-plugin-hmr` mounted; in the shipped base layer that row is `disabled: true` (`packages/bundle/base/cordis.patch.yml:21-27`). |

### 11.4 What `patchReload: live` actually does

`apps/cli/reference/README.md:84`:

> "A `patchReload: live` profile **watches valid edits of both `cordis.patch.yml` layers (profile and home) and
> reapplies them transactionally**; a `startup` profile applies them once."

`apps/cli/reference/README.md:19` adds the app-argument nuance:

> "In a `patchReload: live` profile, a patch-file edit re-evaluates expressions against services that are still
> up, so **it cannot reset a served port**."

`packages/bundle/base/cordis.patch.yml:20-22`:

```yaml
    # Module reload is opt-in per profile. `patchReload: live` config watching
    # uses the launcher's watch-only fallback and does not require this row.
```

So `patchReload: live` is **config-file** watching, not module reload. It re-applies the patch layers over the
running tree; it does not re-import JavaScript.

This is what makes the plugin manager's per-row enable/disable switch work without a restart
(installed `dsh-client-ui-plugin-manager/README.zh.md:56`):

> "The row's switch calls `pluginManager.setPluginEnabled`, writing that row's `disabled` override into the
> profile's `cordis.patch.yml`. **The tree of an HMR-enabled profile immediately recomposes**, that row's host
> half unloads or mounts, the rest of the bundle keeps running, and the page follows the client module graph
> without a reload."

### 11.5 The development loop

| Step | Command | Notes |
|---|---|---|
| Build host + client halves | your own `pnpm build` (`tsc && esbuild`, `tsdown`, `vite build` …) | `lib/index.js` **and** `lib/client.js` must both exist before launch (`packages/client/modules/README.md:46`). |
| Watch + rebuild client | `pnpm run dev:web` (in-tree only) | `apps/cli/reference/README.md:70`: the HMR receiver "is always mounted and stays idle until a separate `pnpm run dev:web` watcher rebuilds client bundles." For an out-of-tree plugin, use your own watcher (`esbuild --watch`, `vite build --watch`) — see `@liustack/modlens/package.json` `"dev": "vite build --watch"`. |
| Link your checkout into a profile | `dsh plugin --profile desktop add ./my-plugin` (or `link:`) | `dsh-free-search`'s updater refuses to auto-update a linked install and tells the user to `git pull` instead (`dsh-free-search/lib/index.js:2678-2684`, code `local-link-mode`). |
| Reload after a host-half change | restart the profile, **unless** `@deepseek-ai/cordis-plugin-hmr` is enabled in that profile | |
| Reload after a client-half change | rebuild `lib/client.js`; the HMR driver calls `rebuilt(id)` and pushes the new rev over SSE | `docs/subsystems/client-modules.md:101-103` |
| Never | `pnpm run build` of the **DSH repo** — a third-party plugin is not part of it | |

In-repo (for reference, `packages/client/AGENTS.md:128-129`):

```
pnpm run test:gui                                  # inner loop; seconds, no browser, no server
DSH_SNAPSHOT=replay pnpm run test:web              # rebuilds frontend dist then runs browser snapshots
```

### 11.6 Documented `DSH_*` environment variables

From a sweep of `docs/**/*.md` and `apps/cli/reference/README.md`:

| Variable | Meaning | Evidence |
|---|---|---|
| `DSH_HOME` | Harness home; profiles live at `$DSH_HOME/profiles/<name>`; home patch at `$DSH_HOME/cordis.patch.yml`; credentials at `$DSH_HOME/.credentials.yaml`. | `docs/user/develop/basic/publish.md:14`; `apps/cli/reference/README.md:9,92` |
| `DSH_TOOLS_MODE` | Selects `native`, `ptc`, or `both` for the process; another value fails at boot. | `apps/cli/reference/README.md:88` |
| `DSH_PERMISSION_MODE` | Changes the process fallback permission mode. | `apps/cli/reference/README.md:86` |
| `DSH_BUILD_FACE` | Build-face selector (`host` / `client`) consumed by `packages/client/tsdown.client.ts:114`. | `packages/client/tsdown.client.ts:114-119` |
| `DSH_CLIENT_*` | Build-time browser constants. Client business code may **statically** read `process.env.DSH_CLIENT_*`; every referenced value is public artifact content; no dynamic lookup or enumeration. | `packages/client/AGENTS.md:71` |
| `DSH_SNAPSHOT` | `replay` (read-only; CI), `record`, `refresh` for the snapshot/web test lanes. | `docs/testing.md:15`; `packages/client/AGENTS.md:129` |
| `DSH_SNAPSHOT_FILE`, `DSH_SNAPSHOT_OVERRIDE`, `DSH_SNAPSHOT_CHILD_FILES` | Snapshot fixture overrides. | grep of `docs/` |
| `DSH_TELEMETRY_MODE` | `DISABLED` disables OTel delivery; `FULL` is rejected. | `apps/cli/reference/README.md:94` |
| `DSH_TELEMETRY_DISABLED` | Any non-empty value disables the OTel row. | `apps/cli/reference/README.md:94` |
| `DSH_TELEMETRY_OTLP_URL` | Selects the OTel collector. | `apps/cli/reference/README.md:94` |
| `DSH_WEB_URL` | Web URL (shell/desktop integration). | grep of `docs/` |
| `DSH_BUNDLED_SKILL_DIR`, `DSH_AGENTS_HOME` | Bundled skill dir; agents config home. | grep of `docs/` |
| `DEEPSEEK_API_KEY`, `DEEPSEEK_SEARCH_BASE_URL` | Provider credentials / search base URL. | `apps/cli/reference/README.md:92` |
| `HTTP_PROXY` / `HTTPS_PROXY` | Resolved into the outbound proxy snapshot before any entry mounts. | `apps/cli/reference/README.md:101` |

Env vars your plugin can *export* to its own subprocesses go through `ctx.shellEnv` — "Registry
(`ctx.shellEnv`) for trusted, per-execution `DSH_*` variables" (api-catalog `key: 'shellEnv'`).

### 11.7 The desktop shell

The Desktop Electron shell is itself a Cordis plugin: the installed
`…\DSH Desktop\resources\app\package.json` is `dsh-plugin-desktop@2.0.17`, with its own `cordis.patch.yml`.
It is mounted like any other bundle — the live profile patch has
(`C:\Users\massnote\.dsh\profiles\desktop\cordis.patch.yml:31-34`):

```yaml
- id: desktop-shell
  name: dsh-plugin-desktop
  config:
    mode: extended
```

One behavioural difference worth noting (`docs/subsystems/web-server.md:5`): *"It serves browsers only:
**Electron loads the built files over `file://` and sends fetch requests through an IPC bridge instead of this
server.**"* So a `ctx.webServer.register(...)` route is **not** reachable by the desktop renderer in the same
way — a plugin that must work in both should prefer the generated Remote path (§2.8), or tolerate the
`file://` origin.

---

## 12. Testing

### 12.1 Policy (docs/testing.md)

`docs/testing.md:1-2`: *"How this repo tests, tier by tier, and the rules that keep a green suite meaningful.
Commands live in root AGENTS.md; linked Agent Notes carry the rationale."*

The tiers (`docs/testing.md:9-15`):

* **Unit** (`pnpm run test`) — vitest over `tests/**`. *"Every registry gets an HMR-safety test (dispose the
  contributing fiber, assert cleanup)."*
* **Coverage gate** (`pnpm run test:coverage`) — per-file 100% on `packages/*/*/src`.
* **Real-API e2e** (`pnpm run test:e2e`) — with-key tests; each self-skips without its key.
* **Owner-local expected output** (`pnpm run test:expected`) — keyless assembled CLI/process expectations.
* **Performance benchmarks** (`pnpm run test:bench`).
* **Snapshot** (`pnpm run test:snapshot`) — a recorded parent generation supplies user input and model replay.
* **Web browser snapshot** (`pnpm run test:web`) — Chromium against `snapshots/web/`.

The two rules that most affect a third-party plugin author:

> **Test the real entry path** (`docs/testing.md:39`): "Product-visible plugins require a non-unit
> REAL-composition test. Hand-built `ctx.plugin(...)` suites are insufficient: boot test-only `cordis.yml`
> through Loader and app/process, mock only external services or nondeterministic inputs, and assert
> model-visible request/log, durable state, or user-visible output."

> **A guard only guards if the regression fails it** (`docs/testing.md:40`): "For a plugin without `inject`
> (bundle/composition plugins), a Loader smoke stays green when a default export replaces the required named
> exports — add an explicit `expect('default' in mod).toBe(false)` plus an `unwrapExports` round-trip
> assertion, and prove it: introduce the regression, watch red, revert."

> **Prefer the real implementation over a mock** (`docs/testing.md:29`): "Mock only the expensive or
> non-deterministic boundary (LLM adapter, network, clock); keep everything downstream real."

> **When a snapshot test is required** (`docs/testing.md:55`): "Every non-trivial model-, protocol-, or
> human-visible change adds or updates a keyless recorded-session scenario in the same PR."

### 12.2 Test-support packages

`packages/test-support/` (7 packages, each with its own `README.md`):

| Package | Role |
|---|---|
| `agent-loop-testkit` | Drive a real loop with a scripted/mock model. |
| `client-runtime` | The client-side test harness. Module JSDoc (`packages/test-support/client-runtime/src/index.ts:8`): *"Not part of the product plugin graph (no `dsh.client`); feature packages …"*. Exports `RemoteError` and `TestRemote` **as value imports** for client specs — `docs/cookbook/adding-a-remote-api.md:169`: *"take the `RemoteError` and `TestRemote` value imports from `@deepseek-ai/dsh-client-test-runtime`, because a value import from the `api-remotes` facade would load the unbuilt assembly chain. `TestRemote.$host` is a plain field a spec assigns directly."* |
| `llm-mock-server` | A local HTTP model server. |
| `llm-replay` | Replay recorded model streams. |
| `loader-smoke` | Boot a real Loader composition from a test `cordis.yml` — the tool for the "real entry path" rule. |
| `session-snapshot` | Shared storage rules and profile adapters for the recorded-session snapshots. |

**The package READMEs also carry the authoring contract for a test-support-style package** — see
`docs/cookbook/adding-a-package.md:74-106` for the required `## Model Experience` → `### Request context and
condition` → `#### What the model sees` / `#### Token effect` / `#### KV Cache effect` structure and the
`## Known Limitations and Deferred Work` section, both mechanically enforced by
`scripts/verify-package-readme-model-experience.ts` and `scripts/verify-package-readme-limitations.ts`.

### 12.3 Unit-testing a tool

The pieces you need, all real:

```ts
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import myPlugin from '../src/index.ts'

async function mount() {
  const ctx = new Context()
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(myPlugin)
  return ctx
}

it('registers the tool with its description and schema', async () => {
  const ctx = await mount()
  expect(ctx.tools.get('greet')?.description).toBe('Greet someone by name.')
  expect(ctx.tools.schemas().map(s => s.name)).toContain('greet')
})

it('returns the canonical value', async () => {
  const ctx = await mount()
  // ToolRuntime.execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>
  // — packages/core/tools/src/index.ts:1332. The result is the same lossless,
  // frozen snapshot the final `tools/result` observers receive.
  const result = await ctx.tools.execute({
    name: 'greet',
    arguments: { who: 'Ada' },
    agent: ctx.agents.get(/* … */),
    signal: AbortSignal.timeout(5_000),
  } as never)
  expect(result.isError).toBe(false)
})

it('unregisters when the contributing fiber is disposed', async () => {
  const ctx = await mount()
  const fiber = await ctx.plugin(myPlugin)
  await fiber.dispose()
  expect(ctx.tools.get('greet')).toBeUndefined()
})
```

The last test is the mandated **HMR-safety test** (`docs/testing.md:9`). For anything that reaches the model,
add a **real-composition** test that boots a test-only `cordis.yml` through the Loader — `loader-smoke` from
`packages/test-support/loader-smoke` is the harness for that (`docs/testing.md:39`).

### 12.4 Testing a client plugin

* Component specs feed props directly. `packages/client/AGENTS.md:151`: *"Component tests feed props directly
  (`createXXXStore().create()` for the store data; plain stubs for framework hooks) and assert behavior without
  render machinery."*
* jsdom comes from a per-file pragma on the spec's **first line**: `// @vitest-environment jsdom`
  (`packages/client/AGENTS.md:121`).
* Assert user-visible behavior, **not** class names, hook internals, or render counts
  (`packages/client/AGENTS.md:120`).
* `createXXXStore()` is the sanctioned zero-machinery seam: *"Production code never calls the factory or
  `.create()` outside `apply`; **tests do** (that is the sanctioned zero-machinery path)."*
  (`packages/client/AGENTS.md:16`).
* Real client-plugin specs in-tree to copy from:
  `packages/client/ui-settings-plugins/tests/apply.client.spec.ts`,
  `packages/client/ui-sidebar-right/tests/seat.client.spec.tsx`,
  `packages/client/ui-sidebar-files/tests/apply.client.spec.ts`.
* For one registration assertion, `SlotCore` exposes `spec(key)`, `entries(key)`, `getVersion(key)`
  (`packages/client/ui-slots/src/index.ts:998-1009`), which is what the shipped specs use, e.g.
  `expect(slots.spec('settings.plugin.item')).toMatchObject({ kind: 'keyed', scope: 'root' })`.

### 12.5 What an out-of-tree plugin can and cannot reuse

* **Can** copy the shapes: `packages/test-support/*` is published under `@deepseek-ai/dsh-test-*` names (check
  the registry), and the in-tree specs are readable references.
* **Cannot** `pnpm run test:gui` / `test:web` / `test:snapshot` — those drive the DSH repository's own gates and
  need the repo's `vitest.config.ts`, snapshot trees, and `tsconfig.base.json` path mapping
  (`docs/testing.md:45`: *"Every vitest config points vite-tsconfig-paths at `tsconfig.base.json`"*).
* **Should not** import `../src/...` internals of `@deepseek-ai/dsh-*` packages from a spec — that is an
  in-repo-only allowance (`packages/client/AGENTS.md:35`).

---

## Appendix A — copy-paste skeleton

A complete minimal out-of-tree plugin: **one tool, one setting, one HTTP route, one UI panel**. Directory:

```
my-dsh-plugin/
├── package.json
├── cordis.patch.yml
├── tsconfig.json
├── build-client.mjs
└── src/
    ├── index.ts            # host half
    └── client/
        └── index.tsx       # browser half
```

### A.1 `package.json`

```json
{
  "name": "my-dsh-plugin",
  "version": "0.1.0",
  "description": "Example third-party DSH plugin: one tool, one setting, one HTTP route, one UI panel.",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/client.js",
    "cordis.patch.yml"
  ],
  "keywords": ["deepseek-harness", "dsh", "dsh-plugin"],
  "license": "MIT",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json && node build-client.mjs",
    "prepare": "npm run build"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.4"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-client-ui-slots": "*",
    "@deepseek-ai/dsh-host-webserver": "*",
    "@deepseek-ai/dsh-settings": "*",
    "@deepseek-ai/dsh-tools": "*",
    "react": "^18.2.0"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/cordis": { "optional": true },
    "@deepseek-ai/dsh-client-ui-slots": { "optional": true },
    "@deepseek-ai/dsh-host-webserver": { "optional": true },
    "@deepseek-ai/dsh-settings": { "optional": true },
    "@deepseek-ai/dsh-tools": { "optional": true },
    "react": { "optional": true }
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-client-ui-slots": "*",
    "@deepseek-ai/dsh-host-webserver": "*",
    "@deepseek-ai/dsh-settings": "*",
    "@deepseek-ai/dsh-tools": "*",
    "@types/node": "^22.10.0",
    "@types/react": "^18.2.0",
    "esbuild": "^0.24.0",
    "react": "^18.2.0",
    "typescript": "^5.6.0"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

> Adjust the `@deepseek-ai/*` ranges to a real version. `"*"` is a placeholder; the installed runtime here is
> `0.2.0-rc.2`, the checkout is `0.1.3-alpha.2`. Peer deps are `optional: true` so a profile missing one of
> them still installs — the same posture as `dsh-free-search/package.json:79-104`.

### A.2 `cordis.patch.yml`

```yaml
# The bundle layer applied when a profile lists this package in dsh.profile.bundles.
# The row id below (`my-plugin`) IS the settings namespace on DSH 0.2.0-rc.2 and the
# second half of the `plugins.row.config` key (`my-dsh-plugin#my-plugin`).
- insert:
    - id: my-plugin
      name: my-dsh-plugin
      config:
        greeting: Hello
        maxGreets: 5
```

### A.3 `src/index.ts` — the host half

```ts
/**
 * my-dsh-plugin — host half.
 *
 * Registers one agent tool, one settings-editable config, and one HTTP route.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

/**
 * Only `webServer` is a hard requirement — the tool and the settings section are
 * registered through nested `ctx.inject`, so the plugin still mounts (and its
 * tool still works) on a host without a Web server or a settings provider.
 */
export const inject = ['webServer']

export interface Config {
  greeting: string
  maxGreets: number
}

/**
 * Editable fields are marked `.volatile()` (schemastery >= 3.18.2): the Loader
 * hands `apply` live references and commits profile edits in place without
 * remounting. The namespace is this row's `id` in cordis.patch.yml.
 * The same schema is what a configuration surface renders.
 */
export const Config = z.object({
  greeting: z.string().default('Hello').volatile(),
  maxGreets: z.number().step(1).min(1).default(5).volatile(),
})

const ROUTE_PREFIX = '/api/my-plugin'

/** Loopback-only guard: a named route is NOT covered by the /api trust fence. */
function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

const MAX_BODY_BYTES = 64 * 1024

async function readJsonBody(req: IncomingMessage): Promise<unknown | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

export function apply(ctx: Context, config: Config): void {
  // `.volatile()` fields are live references; unwrap on every read so the value
  // tracks profile edits committed while the plugin stays mounted.
  const current = (): Config => {
    const source = config as unknown as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      out[key] = value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
        ? (value as { get: () => unknown }).get()
        : value
    }
    return out as unknown as Config
  }

  let greetCount = 0

  // ── 1. The tool ────────────────────────────────────────────────────────────
  ctx.inject(['tools'], (sctx) => {
    sctx.effect(() => sctx.tools.register(defineTool({
      name: 'greet',
      description: 'Greet someone by name. The greeting text comes from plugin settings.',
      parameters: {
        who: { type: 'string', required: true, description: 'The name to greet' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            count: { type: 'number' },
          },
        },
        // `render` must return ContentBlock[] — NOT a bare string. A later
        // pipeline stage (tools/post-execute consumers such as hooks bridges)
        // receives these blocks and crashes on a raw string.
        render(_args, value) {
          return [{ type: 'text', text: value.text }]
        },
      },
      async execute(args) {
        greetCount += 1
        return { text: `${current().greeting}, ${args.who}!`, count: greetCount }
      },
    })), 'my-plugin: greet tool')
  })

  // ── 2. Settings: opt out of the auto-generated form ────────────────────────
  // Editable fields live on `Config`; this only records that we ship our own
  // page. The namespace is this row's id in cordis.patch.yml.
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => {
      const settings = sctx.get('settings') as {
        configure?: (presentation: { auto: boolean }, owner: unknown) => unknown
      }
      // `configure` exists on 0.2.x; on a 0.1.x host the old
      // `installSection(...)` API is the equivalent. Absent ⇒ nothing to do.
      settings.configure?.({ auto: false }, ctx.fiber)
    }, 'my-plugin: settings presentation')
  })

  // ── 3. The HTTP route ─────────────────────────────────────────────────────
  // A named route owns its full response lifecycle. It is NOT behind the /api
  // trust fence, so the handler guards itself.
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/stats`,
      handler: (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'loopback requests only' })
          return
        }
        if (req.method === 'GET') {
          writeJson(res, 200, { count: greetCount, greeting: current().greeting })
          return
        }
        if (req.method === 'POST') {
          void readJsonBody(req).then((body) => {
            if (body === undefined || typeof (body as { greeting?: unknown }).greeting !== 'string') {
              writeJson(res, 400, { error: 'malformed body: greeting must be a string' })
              return
            }
            writeJson(res, 200, { ok: true })
          })
          return
        }
        writeJson(res, 405, { error: `method not allowed: ${req.method ?? ''}` })
      },
    })
    return () => dispose()
  }, 'my-plugin: stats route')
}
```

### A.4 `src/client/index.tsx` — the browser half

```tsx
/**
 * my-dsh-plugin — browser half.
 *
 * Contributes one floating panel into the additive root list slot `shell.overlay`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useState } from 'react'

type PanelProps = PropsRuntime<'shell.overlay'>

interface Stats { count: number; greeting: string }

function MyPluginPanel(_props: PanelProps) {
  const [open, setOpen] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/my-plugin/stats')
      if (!response.ok) {
        setFailure(`HTTP ${response.status}`)
        return
      }
      setStats(await response.json() as Stats)
      setFailure(null)
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1000, pointerEvents: 'auto' }}>
      <button type="button" onClick={() => { setOpen(value => !value); void refresh() }}>
        My plugin{stats === null ? '' : ` (${stats.count})`}
      </button>
      {open && (
        <div role="dialog" aria-label="My plugin panel" style={{ marginTop: 8, padding: 12, background: 'Canvas', border: '1px solid GrayText', borderRadius: 8 }}>
          {failure !== null
            ? <p role="alert">unavailable: {failure}</p>
            : <p>{stats === null ? 'loading…' : `${stats.greeting} — greeted ${stats.count} time(s)`}</p>}
        </div>
      )}
    </div>
  )
}

/**
 * `slots` is the only hard dependency. `inject` here is Cordis service injection
 * for the CLIENT context — it is unrelated to `dsh.client.inject`, which is an
 * informational package-name edge.
 */
export const inject = ['slots']

export function apply(ctx: Context): void {
  // inject() waits for the frame to declare `shell.overlay`, so this is a no-op
  // on a host whose frame does not declare it. `id` is required for a list slot.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'my-plugin-panel', order: 100, label: 'My plugin' },
    MyPluginPanel,
  ))
}
```

### A.5 `build-client.mjs` — the out-of-tree client bundler

```js
/**
 * Reproduce the lazy-CJS factory artifact without the (unpublished) in-repo preset.
 * Four non-negotiables: format cjs, banner, intro, footer.
 * Externals = the frozen platform baseline ONLY (see PLATFORM_MODULES).
 * Add a specifier here only if you also declare it in dsh.client.external.
 */
import { build } from 'esbuild'

const BASELINE = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  external: BASELINE,
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env.MODE': '"production"',
    'import.meta.env': '{"MODE":"production"}',
  },
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'my-dsh-plugin', factory: (require) => {\n"
      + 'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
})
```

### A.6 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "rootDir": "src",
    "outDir": "lib",
    "declaration": true,
    "declarationDir": "lib/types",
    "strict": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noEmitOnError": true
  },
  "include": ["src/index.ts"]
}
```

`src/client/` is excluded from `tsc` (esbuild handles it); type-check it separately with a second
`tsconfig.client.json` if you want coverage, as `dsh-bash-terminal-ts` does. Note `tsc` emits `lib/index.js`
from `src/index.ts` while `lib/client.js` comes from esbuild — the two halves deliberately land in the same
`lib/` directory, matching the in-tree layout (`packages/client/tsdown.client.ts:433-435`).

### A.7 Install and verify

```sh
# from the directory containing my-dsh-plugin/
dsh plugin --profile desktop add ./my-dsh-plugin
dsh --profile desktop --dump-config | Select-String "my-dsh-plugin"   # expect a "# == my-dsh-plugin" layer
dsh --profile desktop                                                  # restart (bundle set changed)
```

Expected: `/greet` is listed in the tool catalog; the row `my-plugin` shows a Configure page in
Sidebar → Plugins → Installed → my-dsh-plugin (or its card in Settings → Plugins, keyed `my-plugin`); the
floating panel renders bottom-right; `GET /api/my-plugin/stats` answers `{ "count": n, "greeting": "…" }`.

---

## Appendix B — contradiction ledger

| # | Topic | Checkout (0.1.3-alpha.2) says | Installed runtime (0.2.0-rc.2) / real third-party plugin says | Authoritative |
|---|---|---|---|---|
| 1 | **Settings host API** | `ctx.settings.installSection(owner, ns, schema, entry, hooks)` and `ctx.settings.register(ns, schema, options)` — `docs/cookbook/adding-a-settings-card.md:36`, `docs/subsystems/settings.md:202-215` | `dsh-settings@0.2.0-rc.2` exposes `configure(presentation, owner)`, `describe`, `update`, `mutate`; `installSection`/`register` are **absent** (grep of `lib/index.js`). Editable fields are declared `.volatile()` on the exported `Config`; namespace = composition entry id; presentation policy = `settings.configure({ auto: false }, ctx.fiber)`. | **Installed runtime**, for a plugin targeting 0.2.x. `dsh-free-search/lib/index.js:3078-3129` + `:3724-3742` is a working example. The checkout docs are correct only for 0.1.x. |
| 2 | **The `plugins.row.config` slot** | Does not exist. No `packages/client/ui-plugin-manager`, no `packages/boot/plugin-manager`. The docs say the settings tab keys cards on the namespace via `settings.plugin.item` (`docs/cookbook/adding-a-settings-card.md:76`). | `@deepseek-ai/dsh-client-ui-plugin-manager@0.2.0-rc.2` declares `plugins.item` (list), `plugins.bundle.config` (keyed by package name), `plugins.row.config` (keyed `<pkg>#<rowId>`), plus five `plugins.detail.*` list/keyed slots. `dsh-free-search` registers `key: "dsh-free-search#web-search-free"`. | **Installed runtime** for the Plugins page. `settings.plugin.item` still exists in 0.2.0-rc.2 too, so registering both (guarded by `slots.inject`) is the version-robust choice. |
| 3 | **`dsh.engines` / `dsh.compatibility`** | Not declared in `DshManifest` (`packages/util/package-manifest/src/types.ts:8-24`); no reader found by grep. | `dsh-free-search/package.json:121-128` declares both. `dsh-bash-terminal-ts` uses npm's `engines.dsh` instead. | Neither is read by DSH core. **Ecosystem metadata**; the read convention is npm `engines.dsh` + the market's own compatibility data. |
| 4 | **`dsh.plugin.json`** | Absent; `docs/cookbook/adding-a-package.md` (checkout) has no "plugin display metadata" section, though the installed `ui-plugin-manager` README links to `adding-a-package.zh.md#plugin-display-metadata`. | `dsh-bash-terminal-ts/dsh.plugin.json` exists with `{ id, name, version, description: { en, zh }, components: { host, client } }`. | Neither DSH core nor the installed manager reads it (grep). Treat as a **market-side** display file; the manager reads the exported locale `meta`, then the plugin's `package.json`. |
| 5 | **Built client bundle format** | Docs state it clearly: "The bundle must be the loader's lazy-CJS factory artifact" (`docs/cookbook/adding-a-settings-card.md:94`), and `tsdown.client.ts:437` sets `format: 'cjs'`. | `dsh-free-search/lib/client.js:1-9` is exactly that. `dsh-bash-terminal-ts` has `"type": "module"` **and** a CJS `lib/client.js`. | **Both agree.** No conflict — but note `"type": "module"` does not change the browser half's format. |
| 6 | **Rollup-of-truth for `dsh.client.inject`** | `docs/subsystems/client-modules.md:28-29` says "`inject` names package rows whose factories must arrive before this row materializes, **while Cordis separately uses the same package edges to compose entries**", which reads like a sequencing edge. | `packages/client/AGENTS.md:140` says flatly: "**`inject` lists package-name dependency edges — they are informational only** (preflight display, HMR diffing); they do not sequence entry activation or apply order. Activation order is Cordis fiber inject waiting on *services*, nothing else." `dsh-free-search/lib/client.js:1784` reinforces it (`ctx.inject(['commandUi'], …)` is the real gate). | **`packages/client/AGENTS.md:140`** — the strict reading. Do not rely on `dsh.client.inject` for ordering. |
| 7 | **Auth on a plugin's own HTTP route** | `docs/subsystems/web-server.md:47` says the carrier "owns no TLS, authentication, or Origin policy", and that the *Connection plugin* supplies Host/Origin checks "for every Host API route and stream". | `dsh-free-search` does **not** rely on that: it implements `isLoopbackRequest` + method check + body cap in `guard`, and sets `referrer-policy: no-referrer` on every response (`lib/index.js:2699-2719, 2945-2955`). | **The plugin must defend its own route.** A named route is not covered by the `/api` trust fence. |
| 8 | **`settings.plugin.item` in 0.2.0-rc.2** | Documented as "the" settings-card path. | `dshmarket` reports it "went silent with no error anywhere" when `settingsScope` was renamed to `settings` on the 0.1.7 line, and moved to `plugins.bundle.config` + `settings.plugins.tab` (`dshmarket/src/client/index.ts:248-254`). | Both slots exist in 0.2.0-rc.2 (`packages/client/ui-settings-plugins` ships in the installed tree). Register into what exists, detected via `slots.inject`. |
| 9 | **Checkout docs lag the installed manager** | `docs/cookbook/adding-a-package.md` has no `#plugin-display-metadata` anchor. | The installed `ui-plugin-manager` README links to `../../../docs/cookbook/adding-a-package.zh.md#plugin-display-metadata`. | The installed README describes a doc revision that does not exist in this checkout. Do not assume the checkout's `docs/` matches the running product. |

---

## Appendix C — evidence index

**Checkout — docs**
`docs/user/develop/basic/index.md`, `…/tool.md`, `…/config.md`, `…/publish.md`;
`docs/user/develop/framework/index.md`, `service.md`, `events.md`;
`docs/cookbook/adding-a-tool.md`, `adding-a-settings-card.md`, `adding-a-package.md`,
`extension-cookbook.md`, `adding-a-remote-api.md`;
`docs/cordis-tutorial/01…07`;
`docs/subsystems/tools.md`, `settings.md`, `commands.md`, `slots.md`, `client-modules.md`,
`client-resources.md`, `web-server.md`, `web-client.md`, `sidebar-right.md`;
`docs/testing.md`, `docs/config-catalog.md`, `docs/architecture.md`;
`apps/cli/reference/README.md`.

**Checkout — source (file:line)**
`packages/util/package-manifest/src/types.ts:7-57` (`DshManifest`, `DshBundleManifest`, `DshProfileManifest`,
`DshClientManifest`)
`packages/boot/app-boot/src/profile.ts:37, 45, 142, 781-803, 789-798, 793-795`
`vendor/include/src/index.ts:9-25, 58-128, 145-156`
`packages/client/tsdown.client.ts:1-10, 61, 107-124, 392-416, 428-570, 566-568`
`packages/client/web/src/platform.ts:8-18`
`packages/client/modules/src/index.ts:185-200, 444, 743-778, 765-768, 806`
`packages/client/modules/README.md:28-46`
`packages/client/AGENTS.md:11-17, 30-36, 62-66, 71, 75-97, 134-143, 145-154`
`packages/client/ui-slots/src/index.ts:26, 115-232, 565-644, 700-829, 998-1009`
`packages/client/ui-slots/README.md:26-58`
`packages/client/ui-renderer/src/client/registry.ts:130-234`
`packages/client/ui-renderer/src/client/index.ts:33-44`
`packages/client/ui-settings-plugins/src/client/slot-contract.ts:16-27`
`packages/client/ui-settings-plugins/src/client/AgentLoopCard.tsx:10-47`
`packages/client/ui-sidebar-right/src/client/index.ts:150-151, 175-176`
`packages/client/ui-layout/src/client/index.ts:90`; `AppFrame.tsx:239`
`packages/client/ui-settings/src/client/settings-scope.ts:150-249`
`packages/core/tools/src/index.ts:131, 1027, 1050, 1061-1086, 1100, 1194, 1224`
`packages/core/tools/README.md:30-58, 62-89, 103, 130`
`packages/core/system-prompt/src/index.ts:15`
`packages/core/session/src/index.ts:35`
`packages/interaction/commands/src/index.ts:112`
`packages/settings/settings/src/index.ts:145`
`packages/host/webserver/src/index.ts:24`
`packages/fs/fs/src/index.ts:46`; `packages/shell/shell/src/index.ts:41`;
`packages/shell/shell-env/src/index.ts:20`; `packages/jobs/jobs/src/index.ts:31`;
`packages/storage/storage/src/index.ts:32`; `packages/web/web/src/index.ts:37`;
`packages/skill/skill/src/index.ts:287`; `packages/subagent/subagent/src/index.ts:133`;
`packages/credentials/credentials/src/index.ts:150`; `packages/spill/spill/src/index.ts:25`;
`packages/sandbox/sandbox/src/index.ts:148`; `packages/terminal/terminal/src/index.ts:50`;
`packages/interaction/user-approval/src/index.ts:19`;
`packages/interaction/user-questions/src/index.ts:17`;
`packages/goal/goal/src/index.ts:61`
`packages/extensions/tool-cordis/src/api-catalog.ts` (68 service keys + summaries)
`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:1407, 1722-1757, 1890-1930, 2069-2186`
`packages/bundle/base/cordis.patch.yml:1-30`
`packages/test-support/client-runtime/src/index.ts:8`

**Installed runtime — `…\DSH Desktop\resources\app\node_modules\@deepseek-ai\`**
`dsh-client-ui-plugin-manager/README.zh.md:14, 30-32, 50-84, 91-114`
`dsh-client-ui-plugin-manager/lib/client.js:15-64, 27-29, 2404-2418, 3765-3808`
`dsh-settings/README.zh.md:12, 26-39, 47-49`
`dsh-settings/lib/index.js:365-370, 413, 470, 488`
`dsh/package.json` → `0.2.0-rc.2`

**Installed profile — `C:\Users\massnote\.dsh\profiles\desktop\`**
`package.json` (profile manifest, 27 lines)
`cordis.patch.yml` (user layer, 40 lines)
`cordis.yml` (3 bytes)
`node_modules/dsh-free-search/{package.json, cordis.patch.yml, lib/index.js, lib/client.js}`
`node_modules/@liustack/modlens/{package.json, cordis.patch.yml}`
`node_modules/dsh-rewind-plugin/{package.json, cordis.patch.yml, lib/{index.js, client.js}, lib/types/**}`
`node_modules/dsh-context/{package.json, cordis.patch.yml, lib/{index.js, client.js}, lib/index.d.ts}`
`node_modules/dsh-bash-terminal-ts/{package.json, cordis.patch.yml, dsh.plugin.json}`
`node_modules/dshmarket/{package.json, cordis.patch.yml, src/client/index.ts}`
`node_modules/billion-context/dsh.bundle.patch.yml`

**`dsh-rewind-plugin` and `dsh-context` file layout** (requested in the brief):

```
dsh-rewind-plugin/
├── cordis.patch.yml
├── package.json
├── README.md, README.en.md, SECURITY.md, LICENSE
├── assets/icon.svg
├── locale/{en.json, zh.json}
└── lib/
    ├── index.js          # host half
    ├── client.js         # browser half
    └── types/            # .d.ts only
        ├── index.d.ts, locales.d.ts, marker.d.ts, rewind.d.ts,
        ├── session-cwd.d.ts, snapshot-cleanup.d.ts, snapshot.d.ts
        └── client/{build-info,candidates,hidden,index,locales,log,pending,popover,portals,settings-card,styles}.d.ts

dsh-context/
├── cordis.patch.yml
├── package.json
├── README.md, LICENSE, icon.svg
├── locale/{en.json, zh.json}
├── lib/{index.js, index.d.ts, client.js}
└── node_modules/zod/…     # its own nested dependency
```

Both follow the canonical dual-face layout: `cordis.patch.yml` at the package root, `lib/index.js` host half,
`lib/client.js` browser half, `locale/*.json` dictionaries. `dsh-context` ships a **root `lib/index.d.ts`**
(not `lib/types/`), showing the types directory name is not load-bearing — only the `exports` map is.

---

*Report generated by direct source inspection. Every claim carries a `file:line` or an exact path. Where the
checkout and the installed runtime disagree, both are given and the authoritative one is named.*
