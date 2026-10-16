/**
 * Ambient types for `@deepseek-ai/cordis`.
 *
 * Declared because the manifest points at `lib/types/index.d.ts`, which is not
 * shipped. Only the context surface this plugin touches is described.
 *
 * `inject` is typed with a `Services` map so that a callback receives the service
 * it asked for. An earlier version of this file typed the callback parameter as
 * `any`, which silently removed the check that matters most in this file: that
 * `svcCtx.webServer` is a real service and not a typo in the dependency list.
 */
declare module '@deepseek-ai/cordis' {
  /** A route handler: an HTTP request/response pair, exactly as Node's server gives. */
  export type RequestHandler = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void | Promise<void>;

  /** A route the web server carrier knows how to dispatch. */
  export interface RouteSpec {
    /** `prefix` matches by path prefix; other kinds are carrier-defined. */
    kind: string;
    path: string;
    handler: RequestHandler;
  }

  /** The HTTP carrier, present only on profiles that serve a UI. */
  export interface WebServerService {
    register(route: RouteSpec): () => void;
  }

  /** The tool registry. */
  export interface ToolsService {
    register(definition: unknown): () => void;
  }

  /** Services this plugin can name in `ctx.inject`. */
  export interface Services {
    tools: ToolsService;
    webServer: WebServerService;
  }

  export interface Context {
    tools: ToolsService;

    /**
     * Runs a callback once the named services exist, and disposes its registrations
     * with the plugin. Used for `webServer` because a headless profile never
     * provides it, and naming it in `inject` would leave the plugin pending forever.
     */
    inject<K extends keyof Services>(
      deps: readonly K[],
      callback: (ctx: Context & Pick<Services, K>) => void,
    ): void;

    /**
     * Read an optional service by name, without waiting for it.
     *
     * The counterpart to `inject`: `shell` is mounted per profile, and `inject` would
     * leave this plugin pending forever on a deployment that has none. Returns
     * `unknown` rather than a typed service because these packages ship no
     * declarations — the caller narrows, and says in one place what it checked.
     */
    get(name: string): unknown;

    /** Registers a teardown callback; the returned function runs on unload. */
    effect(callback: () => () => void, label?: string): void;

    on(event: string, listener: (...args: unknown[]) => void): () => void;
    logger: { info(message: string): void; warn(message: string): void; error(message: string): void };
  }

  export class Service {
    constructor(ctx: Context, name: string);
  }
}
