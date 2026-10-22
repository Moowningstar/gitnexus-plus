/**
 * Turn three environment variables into the GitNexus web UI's AI settings.
 *
 * WHY ENVIRONMENT VARIABLES
 * -------------------------
 * The embedded SPA keeps its LLM provider, key and model in `sessionStorage`
 * (`gitnexus-llm-settings`), which means every fresh tab asks for the key again — and an
 * iframe the panel creates is, by definition, a fresh tab. Re-typing a key on each visit
 * is the single most annoying part of using the embedded UI, and it is the one thing the
 * host can fix without touching the SPA.
 *
 * The host deliberately does not hold a key of its own. DSH's own credentials are account
 * grants (`deepseek-account-platform`), not provider keys, and the provider definitions in
 * `settings.yaml` only name an `apiKeyEnv`. So the operator names the three things the SPA
 * needs — provider, key, model — in the environment, and this module maps them onto the
 * settings object the SPA already understands.
 *
 * WHAT THE SPA EXPECTS
 * --------------------
 * `{ activeProvider: <provider id>, <storage key>: { apiKey, model, baseUrl? } }`, merged
 * over its defaults on load, so a partial object is enough. Two wrinkles the mapping
 * exists to absorb:
 *
 * 1. `azure-openai` is stored under the key `azureOpenAI`, and its builder wants
 *    `endpoint` + `deploymentName` rather than `baseUrl` + `model`.
 * 2. `ollama` is local and takes no key at all, only a host and a model.
 */

/** The provider ids the SPA's settings dialog offers. */
export type AiProvider =
  | 'openai'
  | 'azure-openai'
  | 'gemini'
  | 'anthropic'
  | 'ollama'
  | 'openrouter'
  | 'minimax'
  | 'glm'
  | 'deepseek';

export const AI_PROVIDERS: readonly AiProvider[] = [
  'openai',
  'azure-openai',
  'gemini',
  'anthropic',
  'ollama',
  'openrouter',
  'minimax',
  'glm',
  'deepseek',
];

/** The variables this module reads. All are optional; all three that matter are named. */
export const AI_ENV = {
  provider: 'GITNEXUS_PLUS_AI_PROVIDER',
  apiKey: 'GITNEXUS_PLUS_AI_API_KEY',
  model: 'GITNEXUS_PLUS_AI_MODEL',
  baseUrl: 'GITNEXUS_PLUS_AI_BASE_URL',
} as const;

export interface AiSettings {
  provider: AiProvider;
  /** Empty for `ollama`, which is local and needs no key. */
  apiKey: string;
  model: string;
  /** Provider-specific endpoint override, when the operator set one. */
  baseUrl: string | null;
}

/**
 * What the environment said.
 *
 * `absent` and `invalid` are different states on purpose: absent is the normal case (the
 * panel just does not mention AI) while invalid means someone typed a variable name
 * slightly wrong, which is worth a sentence in the UI rather than silence.
 */
export type AiSettingsRead =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ready'; settings: AiSettings };

/** Accepted spellings, so an obvious alias does not silently do nothing. */
const PROVIDER_ALIASES: Record<string, AiProvider> = {
  openai: 'openai',
  'open-ai': 'openai',
  'openai-compatible': 'openai',
  openrouter: 'openrouter',
  'open-router': 'openrouter',
  gemini: 'gemini',
  google: 'gemini',
  'google-gemini': 'gemini',
  'google-ai': 'gemini',
  anthropic: 'anthropic',
  claude: 'anthropic',
  'azure-openai': 'azure-openai',
  azure: 'azure-openai',
  azureopenai: 'azure-openai',
  'azure-open-ai': 'azure-openai',
  ollama: 'ollama',
  'ollama-local': 'ollama',
  local: 'ollama',
  minimax: 'minimax',
  'mini-max': 'minimax',
  glm: 'glm',
  zai: 'glm',
  'z.ai': 'glm',
  zhipu: 'glm',
  deepseek: 'deepseek',
  'deep-seek': 'deepseek',
};

/** Where each provider's settings live inside the SPA's stored object. */
const STORAGE_KEY: Record<AiProvider, string> = {
  openai: 'openai',
  'azure-openai': 'azureOpenAI',
  gemini: 'gemini',
  anthropic: 'anthropic',
  ollama: 'ollama',
  openrouter: 'openrouter',
  minimax: 'minimax',
  glm: 'glm',
  deepseek: 'deepseek',
};

/** `google gemini` → `gemini`. Case, spaces and underscores are noise. */
export function normalizeAiProvider(raw: string): AiProvider | null {
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (key === '') return null;
  const direct = PROVIDER_ALIASES[key];
  if (direct !== undefined) return direct;
  const collapsed = key.replace(/-/g, '');
  return PROVIDER_ALIASES[collapsed] ?? null;
}

function readVar(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read the three variables.
 *
 * Kept pure — it takes the environment as an argument — because the interesting cases
 * (a provider with no model, an unknown provider, the key-free ollama) are exactly the
 * ones that are awkward to reach by exporting real variables in a test.
 */
export function readAiSettings(env: NodeJS.ProcessEnv = process.env): AiSettingsRead {
  const rawProvider = readVar(env, AI_ENV.provider);
  const rawKey = readVar(env, AI_ENV.apiKey);
  const rawModel = readVar(env, AI_ENV.model);
  const rawBaseUrl = readVar(env, AI_ENV.baseUrl);

  if (rawProvider === '' && rawKey === '' && rawModel === '' && rawBaseUrl === '') return { kind: 'absent' };

  if (rawProvider === '') {
    return {
      kind: 'invalid',
      reason: `设置了 ${AI_ENV.apiKey} 或 ${AI_ENV.model}，但没有设置 ${AI_ENV.provider}，无法判断要填哪个供应商。`,
    };
  }
  const provider = normalizeAiProvider(rawProvider);
  if (provider === null) {
    return {
      kind: 'invalid',
      reason:
        `${AI_ENV.provider}=${rawProvider} 不是 GitNexus 认识的供应商。` +
        `可选：${AI_PROVIDERS.join('、')}（也接受 google、claude、azure、z.ai 这样的别名）。`,
    };
  }
  if (rawModel === '') {
    return { kind: 'invalid', reason: `缺少 ${AI_ENV.model}：供应商 ${provider} 需要模型 id。` };
  }
  // Ollama is the one provider whose "key" is a local socket, not a secret.
  if (provider !== 'ollama' && rawKey === '') {
    return { kind: 'invalid', reason: `缺少 ${AI_ENV.apiKey}：供应商 ${provider} 需要 API Key。` };
  }
  if (provider === 'azure-openai' && rawBaseUrl === '') {
    return {
      kind: 'invalid',
      reason: `供应商 azure-openai 需要 ${AI_ENV.baseUrl}（Azure 的 endpoint 地址）。`,
    };
  }

  return {
    kind: 'ready',
    settings: {
      provider,
      apiKey: rawKey,
      model: rawModel,
      baseUrl: rawBaseUrl === '' ? null : rawBaseUrl.replace(/\/+$/, ''),
    },
  };
}

/**
 * The object to store under `gitnexus-llm-settings`.
 *
 * Only the active provider is filled in: the SPA merges this over its defaults, so the
 * other eight providers keep whatever they had. Writing them empty would erase a key the
 * operator pasted by hand for a second provider.
 */
export function llmSettingsSeed(settings: AiSettings): Record<string, unknown> {
  const key = STORAGE_KEY[settings.provider];
  if (settings.provider === 'azure-openai') {
    return {
      activeProvider: settings.provider,
      [key]: {
        apiKey: settings.apiKey,
        endpoint: settings.baseUrl ?? '',
        deploymentName: settings.model,
        model: settings.model,
      },
    };
  }
  const entry: Record<string, unknown> = { model: settings.model };
  if (settings.provider === 'ollama') {
    if (settings.baseUrl !== null) entry.baseUrl = settings.baseUrl;
  } else {
    entry.apiKey = settings.apiKey;
    if (settings.baseUrl !== null) entry.baseUrl = settings.baseUrl;
  }
  return { activeProvider: settings.provider, [key]: entry };
}

/** One line for the panel. Never includes the key. */
export function describeAiSettings(settings: AiSettingsRead): string {
  if (settings.kind === 'absent') return '未配置';
  if (settings.kind === 'invalid') return '配置有误';
  const endpoint = settings.settings.baseUrl === null ? '' : ` · ${settings.settings.baseUrl}`;
  return `${settings.settings.provider} · ${settings.settings.model}${endpoint}`;
}
