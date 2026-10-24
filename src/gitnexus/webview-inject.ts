/**
 * Turn the operator's AI settings into a page the server will serve.
 *
 * The settings live in the SPA's `sessionStorage`, and no other origin can write
 * there — so the only honest lever is the page itself. This module owns that one job:
 * prepare the generated `index.html` under a directory the caller points the server at,
 * and say plainly what happened when it could not.
 */

import path from 'node:path';
import { llmSettingsSeed } from './ai-settings.js';
import type { AiSettingsRead } from './ai-settings.js';
import { defaultWebDistRoot, locateWebDist, prepareWebDist } from './webdist.js';
import type { WebViewAiStatus } from './webview.js';

export interface InjectionOptions {
  /** What the environment says; `absent` and `invalid` never get here. */
  read: AiSettingsRead;
  /** The status to degrade: what the panel would have said without an injection. */
  base: WebViewAiStatus;
  cliPath: string;
  packageRoot: string | null;
  port: number;
  webDistRoot?: string;
  webDistSource?: string | null;
}

export interface InjectionResult {
  ai: WebViewAiStatus;
  /** The generated directory, or null when nothing was produced. */
  webDist: string | null;
}

/**
 * Build the seeded page.
 *
 * Every failure is a sentence on the card, never an exception: the server is still
 * worth starting without the seed, and a stack trace in place of a view would be worse
 * than a settings dialog the operator fills in by hand.
 */
export async function prepareInjection(options: InjectionOptions): Promise<InjectionResult> {
  let ai = options.base;
  if (options.read.kind !== 'ready') return { ai, webDist: null };
  const settings = options.read.settings;
  const outDir = path.join(options.webDistRoot ?? defaultWebDistRoot(), String(options.port));
  try {
    const source =
      options.webDistSource === undefined
        ? await locateWebDist({ cliPath: options.cliPath, packageRoot: options.packageRoot })
        : options.webDistSource;
    if (source === null) {
      return {
        ai: { ...ai, reason: '没找到 GitNexus 的 web 目录，AI 设置不会被注入（服务照常启动）。' },
        webDist: null,
      };
    }
    const prepared = await prepareWebDist({ sourceDir: source, outDir, seed: llmSettingsSeed(settings) });
    if (prepared === null) {
      return { ai: { ...ai, reason: 'GitNexus 的 index.html 结构与预期不同，跳过 AI 设置注入。' }, webDist: null };
    }
    ai = {
      injected: true,
      provider: settings.provider,
      model: settings.model,
      baseUrl: settings.baseUrl,
      reason: null,
    };
    return { ai, webDist: prepared.dir };
  } catch (error) {
    return {
      ai: { ...ai, reason: `生成注入页面失败：${error instanceof Error ? error.message : String(error)}` },
      webDist: null,
    };
  }
}
