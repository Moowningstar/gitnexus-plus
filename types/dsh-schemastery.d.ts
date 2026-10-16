/**
 * Ambient types for `@deepseek-ai/schemastery`.
 *
 * The package declares `"types": "lib/types/index.d.ts"` in its manifest and ships
 * no such file, so every DSH plugin author has to write this. Only the surface this
 * plugin actually uses is declared — `object`, the scalar constructors, and
 * `default` — because a wider declaration would be a guess about a package whose
 * real schema DSL is much larger.
 *
 * `object` is generic so the config type is **inferred from the shape** rather than
 * asserted separately. That is the whole point: a plugin's `Config` and the type its
 * `apply` receives must not be able to drift apart.
 */
declare module '@deepseek-ai/schemastery' {
  /**
   * A schema for `T`. Callable, because Schemastery schemas can also be used to
   * validate or coerce a value directly.
   */
  export interface SchemaLike<T> {
    (value?: unknown): T;
    /** Attaches a default, returning a schema of the same type. */
    default(value: T): SchemaLike<T>;
    optional(): SchemaLike<T | undefined>;
    description(text: string): SchemaLike<T>;
  }

  export interface SchemaFactory {
    /**
     * Declares an object schema. `T` is inferred from the shape, so the resulting
     * schema carries the config type without a second declaration to keep in sync.
     */
    object<T extends Record<string, unknown>>(shape: {
      [K in keyof T]: SchemaLike<T[K]>;
    }): SchemaLike<T>;

    natural(): SchemaLike<number>;
    number(): SchemaLike<number>;
    boolean(): SchemaLike<boolean>;
    string(): SchemaLike<string>;
    array<T>(inner: SchemaLike<T>): SchemaLike<T[]>;
  }

  const Schema: SchemaFactory;
  export default Schema;
}
