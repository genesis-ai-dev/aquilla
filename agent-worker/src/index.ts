import { createApp } from "./app"
import { resolveSandbox } from "./resolve-sandbox"
import { durableObjectPoolGate } from "./pool-gate"
import type { Env } from "./types"

// wrangler binds both Durable Object classes by name; they are re-exported here
// because the Worker's entry module is what Cloudflare looks in for them.
// `Sandbox` (sandbox-do.ts) is the container-backed sandbox, one per agent
// session; `SandboxPool` (pool-do.ts, AQU-1848) is the admission ledger.
export { Sandbox } from "./sandbox-do"
export { SandboxPool } from "./pool-do"

const app = createApp({ resolveSandbox, pool: durableObjectPoolGate })

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
}
