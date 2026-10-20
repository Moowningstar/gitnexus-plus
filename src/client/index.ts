/**
 * dsh-gitnexus-plus — browser half.
 *
 * Several ESM modules compiled by `tsc` (AMD, `outFile`) into one CommonJS artifact
 * on purpose. The in-tree client preset (`packages/client/tsdown.client.ts`) is
 * unpublished, so an out-of-tree plugin must reproduce its output format with its
 * own toolchain — and the honest minimum here is no bundler at all: `tsc` emits one
 * `define(...)` block per source file and `scripts/build-client.mjs` resolves them
 * with a small registry, with no bundler and no node_modules in the loop.
 *
 * UI COMES FROM THE SHARED PRIMITIVES PACKAGE
 * -------------------------------------------
 * An earlier revision hand-rolled every control with inline styles, on the
 * reasoning that `@deepseek-ai/dsh-client-ui-primitives` ships no JS in the
 * installed runtime and its exports therefore could not be verified. That
 * reasoning was wrong twice over. The package's own README states the rule —
 * "plugins cannot import another plugin's components, so this package is the one
 * place controls can be shared; reuse them" — and the installed plugin
 * `dsh-context` declares it as a peer dependency, which is exactly how a plugin is
 * meant to get a native look.
 *
 * Every prop used below was read off a real call site in an installed plugin
 * bundle rather than inferred from prose, because a wrong prop name fails
 * silently: React renders the component with its defaults and nothing throws.
 *
 *   Button        variant: "ghost" | "outline" | "primary" | "toolbar"
 *   StateDot      state: "done" | "warning" | "error" | "idle" | "ongoing"
 *   Tag           tone: "neutral" | "solid" | "outline" | "info"
 *   PathLabel     path
 *   FileTypeIcon  path | kind (from classifyFileType) , size, className
 *   Tooltip       label, side, delayMs, portal — wraps a single child
 *
 * WHAT THE PANEL SHOWS, AND WHY
 * -----------------------------
 * GitNexus prints skipped files once, to stderr, and never exposes them again. The
 * panel keeps that visible: the bar answers "how much of this repository does the
 * index actually represent?", the warning block says what was dropped, and the
 * file list says whether what was dropped is source or build output.
 */

import {
  capabilityRows,
  compactNumber,
  coverageRatio,
  fileSize,
  formatBytes,
  graphQualitySummary,
  healthState,
  percent,
  splitWarnings,
  stackSegments,
  stalenessView,
  summaryLine,
} from './format';
import {
  bindSidebarRight,
  contextDiagnostic,
  fileResourceAddress,
  routeUrl,
  useProjectPath,
} from './navigation';
import {
  Histogram,
  IconRefreshOutlineRegular,
  MetricGrid,
  Ring,
  Section,
  classifyFileType,
} from './primitives';
import { GitActivitySection, activityView } from './sections/activity';
import { CapabilityStrip, ProvenanceBlock } from './sections/capabilities';
import { FileHistorySection } from './sections/file-history';
import { LanguageBar, LanguageSection } from './sections/languages';
import { LargeFileList } from './sections/large-files';
import { MaintenanceSection } from './sections/maintenance';
import { SidebarRightApi } from './types';
import { CoveragePanel, CoverageTitle, CoverageView } from './views/panel';

/** Must match the `id` in the loader factory written by scripts/build-client.mjs. */
const PLUGIN_ID = 'dsh-gitnexus-plus';

/** The sidebar-right tab type this plugin contributes. */
const TAB_KIND = 'gitnexus';

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Declared, not guessed: the loader hands `apply` a context carrying exactly
 * these, and reading anything else off `ctx` throws.
 *
 * `sidebarRightTabs` is deliberately absent and reached through `ctx.inject`
 * instead — it is an optional capability (a headless or TUI profile has no right
 * sidebar at all), and naming it here would leave this plugin permanently pending
 * on those profiles rather than simply contributing nothing.
 */
const inject = ['slots'];

/**
 * The client-side context this half is applied with.
 *
 * Narrowed to exactly what is used. The real context is the platform's, whose full
 * surface is much larger and is not published with types — declaring only these
 * members keeps the check meaningful instead of `any`.
 */
interface SlotsContext {
  slots: {
    inject(name: string, callback: () => unknown): void;
    register(spec: { name: string; key: string }, component: unknown): unknown;
  };
  effect(callback: () => () => void, label?: string): void;
  inject(deps: readonly string[], callback: (svcCtx: InjectedServices) => void): void;
}

/** Services this plugin optionally reaches for; absent ones are a normal profile shape. */
interface InjectedServices {
  sidebarRightTabs?: SidebarRightTabs;
  sidebarRight?: SidebarRightApi;
}

/** The sidebar-right tab registry service. */
interface SidebarRightTabs {
  register(spec: {
    id: string;
    kind: string;
    title: () => string;
    guide: Array<{ id: string; order: number; title: () => string; description: () => string }>;
  }): () => void;
}

function apply(ctx: SlotsContext): void {
  const safe = (tag: string, fn: () => void): void => {
    try {
      fn();
    } catch (cause) {
      // One unknown slot name must not take the rest of the surface down with it.
      console.warn(`[${PLUGIN_ID}] client surface '${tag}' failed:`, cause);
    }
  };

  safe('sidebarRightTabs', () => {
    ctx.inject(['sidebarRightTabs'], (svcCtx) => {
      const tabs = svcCtx.sidebarRightTabs;
      if (tabs === undefined) return;
      ctx.effect(
        () =>
          tabs.register({
            id: PLUGIN_ID,
            kind: TAB_KIND,
            title: () => 'GitNexus',
            // The guide page is how a user discovers a contributed page type: it
            // renders one entry box per `guide` entry, and picking one opens this
            // kind. Without it the panel would be reachable only by a caller that
            // already knew the kind name.
            guide: [
              {
                id: `${PLUGIN_ID}:coverage`,
                order: 40,
                title: () => 'GitNexus 索引',
                description: () => '查看索引覆盖：被跳过的超大文件与语言分布',
              },
            ],
          }),
        `${PLUGIN_ID}: tab type`,
      );
    });
  });

  // The navigation controller the chat and the file strip already use. Optional:
  // a profile without a right column simply leaves the module-level openers null,
  // and a search-result click falls back to copying `path:line`.
  safe('sidebarRight', () => {
    ctx.inject(['sidebarRight'], (svcCtx) => {
      bindSidebarRight(svcCtx.sidebarRight);
    });
  });

  safe('sidebar.right.pane.tab', () => {
    ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PLUGIN_ID }, CoveragePanel),
    );
  });

  safe('sidebar.right.pane.tab.title', () => {
    ctx.slots.inject('sidebar.right.pane.tab.title', () =>
      ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: PLUGIN_ID }, CoverageTitle),
    );
  });
}

// Named exports rather than `module.exports = {…}`: the browser half is compiled as
// AMD (`tsconfig.client.json`), which supplies an `exports` object per module and no
// `module`. The loader's contract is unchanged — it takes the entry module's exports
// — so `inject` and `apply` still land at the top level of what it receives.
export { inject, apply };

/** Named for tests: the loader never reads anything under this key. */
export const __internals = {
    PLUGIN_ID,
    TAB_KIND,
    routeUrl,
    fileResourceAddress,
    formatBytes,
    fileSize,
    percent,
    stackSegments,
    splitWarnings,
    summaryLine,
    coverageRatio,
    healthState,
    stalenessView,
    capabilityRows,
    graphQualitySummary,
    activityView,
    compactNumber,
    useProjectPath,
    contextDiagnostic,
    CoveragePanel,
    CoverageView,
    CoverageTitle,
    LanguageBar,
    LanguageSection,
    LargeFileList,
    Ring,
    MetricGrid,
    Histogram,
    GitActivitySection,
    FileHistorySection,
    ProvenanceBlock,
    MaintenanceSection,
    CapabilityStrip,
    Section,
    classifyFileType,
    IconRefreshOutlineRegular,
};
