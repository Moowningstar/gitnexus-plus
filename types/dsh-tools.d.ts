/**
 * Ambient types for `@deepseek-ai/dsh-tools`.
 *
 * Declared because the package's manifest points at `lib/types/index.d.ts`, which
 * is not shipped. The signatures below are read off the installed implementation
 * (`lib/index.js`, `function defineTool(options)`) rather than inferred from prose:
 * it reads `options.execute`, `options.output.render`, `options.output.schema`,
 * `options.presentCall`, `options.presentResult`, `options.isConcurrencySafe`,
 * `options.deferLoading`, `options.finalizeContent`, `options.projectContent` and
 * `options.timeoutMs`, and validates `timeoutMs` as a positive finite number.
 *
 * `defineTool` is generic in the argument and result types so `execute` gets a typed
 * `args` instead of `any` — which is the difference between the type checker being
 * able to catch a tool that reads a parameter it never declared, and not.
 */
declare module '@deepseek-ai/dsh-tools' {
  /** A parameter declaration, in the SDK's own schema-spec form. */
  export interface ParameterSpec {
    type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
    /**
     * Only the literal `true`. Read off the installed compiler
     * (`lib/index.js`, `runSchemaCompiler`): it rejects any other value with
     * "required must be true when present", then collects the marked properties
     * into the emitted JSON Schema `required` array itself.
     */
    required?: true;
    description?: string;
    items?: ParameterSpec;
    properties?: Record<string, ParameterSpec>;
    enum?: readonly unknown[];
  }

  /**
   * A value-schema fragment, as accepted by `output.schema`.
   *
   * `required` is per property and only ever `true`. Writing the JSON Schema array by
   * hand is the mistake this type exists to prevent: `assertAuthorKeys` rejects the
   * unknown key at author time and the plugin throws as it loads. An earlier version
   * of this declaration typed it as `readonly string[]`, which is what let that
   * mistake through the type checker and into a build.
   */
  export interface JsonSchemaSpec {
    type?: string;
    additionalProperties?: boolean | JsonSchemaSpec;
    /** Per property, and only the literal `true`. Never an array. */
    required?: true;
    properties?: Record<string, JsonSchemaSpec>;
    items?: JsonSchemaSpec;
    description?: string;
    enum?: readonly unknown[];
  }

  /** One rendered content part, as returned by `output.render`. */
  export interface RenderedPart {
    type: string;
    text?: string;
    [key: string]: unknown;
  }

  /**
   * The slice of the host's `ToolRunContext` a tool body may rely on.
   *
   * The host passes call identity, the calling agent, nesting tokens and a cancellation
   * signal. Only one of those is a *contract* on the body: `ctx.tools.execute` requires
   * a body to "observe or forward `exec.signal` and settle only after its owned work
   * reaches quiescence", and declaring `timeoutMs` on a definition asserts that the
   * body does so. Typed as a structural slice, like `ShellLike`, because the rest of
   * the runtime context is host-owned detail this plugin never reads.
   *
   * Optional, not required: 0.2.0 hosts in the declared peer range may call a body with
   * arguments only. A body therefore reads `exec?.signal` rather than assuming it.
   */
  export interface ToolExecContext {
    signal: AbortSignal;
  }

  export interface ToolDefinition<Args, Result> {
    name: string;
    description: string;
    parameters?: Record<string, ParameterSpec>;
    output: {
      schema: JsonSchemaSpec;
      render: (args: Args, value: Result) => RenderedPart[];
      presentationMeta?: (args: Args, value: Result) => unknown;
    };
    execute: (args: Args, exec?: ToolExecContext) => Promise<Result> | Result;
    presentCall?: (args: Args) => unknown;
    presentResult?: (args: Args, value: Result) => unknown;
    isConcurrencySafe?: boolean | ((args: Args) => boolean);
    deferLoading?: boolean;
    timeoutMs?: number;
  }

  export function defineTool<Args, Result>(options: ToolDefinition<Args, Result>): ToolDefinition<Args, Result>;

  export class JsonSchemaError extends Error {}
  export class ToolArgsError extends Error {}
  export class ToolNotFoundError extends Error {}
  export class ToolOutputError extends Error {}

  export function parameterSchemaSpecToJsonSchema(spec: Record<string, ParameterSpec>): JsonSchemaSpec;
  export function assertObjectJsonSchema(schema: unknown): void;
  export function assertSupportedJsonSchema(schema: unknown): void;
}
