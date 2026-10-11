// Runtime stub for the `cloudflare:workers` built-in module, aliased in by
// vitest.config.ts. Not a test file.
//
// Why it exists: a Durable Object class must be a NAMED EXPORT of the Worker's
// entrypoint for the runtime to find it, so src/index.ts re-exports
// ContextualRunDriver (AQU-1845) — and every route suite imports that same
// index.ts. Without this alias, `import { DurableObject } from
// "cloudflare:workers"` makes the whole auth-worker suite unresolvable, which
// is exactly what happened when the export was first added.
//
// Types still come from @cloudflare/workers-types, which declares the module
// for tsc; this only has to satisfy the module loader and give a DO test a
// base class whose `ctx`/`env` behave like the real one's.

export class DurableObject<E = unknown> {
  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: E,
  ) {}
}

/** Only the entrypoint shape anything here needs. Extend as tests require. */
export class WorkerEntrypoint<E = unknown> {
  constructor(
    protected readonly ctx: ExecutionContext,
    protected readonly env: E,
  ) {}
}
