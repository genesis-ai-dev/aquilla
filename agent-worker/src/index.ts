import { createApp } from "./app"
import { resolveSandbox } from "./resolve-sandbox"
import { durableObjectPoolGate } from "./pool-gate"
import type { Env } from "./types"
import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox"

// AQU-1848: wrangler binds this class by name; re-exported here because the
// Worker's entry module is what Cloudflare looks in for Durable Object classes.
export { SandboxPool } from "./pool-do"

// The container-backed Durable Object class. Internet access defaults ON in
// Cloudflare Containers, so re-exporting the SDK class directly would let
// untrusted import code exfiltrate uploaded content. Keep the class name that
// wrangler.toml binds, but make the documented default-deny policy real.
export class Sandbox extends CloudflareSandbox<Env> {
  override enableInternet = false

  /**
   * AQU-1848: how long an idle container lives before it is put to sleep.
   *
   * The SDK already defaults this to "10m"; stating it here makes the pool's
   * slot-recycling behaviour explicit at the one place that governs it, so the
   * number is reviewed alongside `max_instances` and the lease TTL in
   * `pool.ts` rather than inherited silently from a dependency. It must outlive
   * the longest legitimate gap between two `/exec` calls in one session (an
   * import pauses for a model round trip between them), which 10m comfortably
   * does; the lease TTL is what reclaims a slot whose holder actually died.
   */
  override sleepAfter = "10m"
}

const app = createApp({ resolveSandbox, pool: durableObjectPoolGate })

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
}
