// aquilla-web Worker entry
//
// Phase A (initial deploy): this Worker is in passthrough mode — every
// request is forwarded directly to the static-asset binding. The aq_hint
// cookie check is enabled in Phase B (Task 5) once the hint has had time
// to propagate to existing signed-in users.
//
// See docs/superpowers/specs/2026-05-30-bare-domain-routing-design.md

// Use a structural type instead of `Fetcher` from @cloudflare/workers-types
// so this file compiles under the root tsconfig (which doesn't pull in
// workers-types) and so worker/index.test.ts can call fetch() with a plain
// mock without needing the full ExecutionContext.
export interface Env {
  ASSETS: { fetch(req: Request | string): Promise<Response> }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Phase A: unconditional passthrough — hint check not yet enabled.
    return env.ASSETS.fetch(req)
  },
}
