/**
 * AQU-1848 — the production `PoolGate`: routes → the singleton `SandboxPool`.
 *
 * Isolated in its own module for the same reason as `resolve-sandbox.ts`: the
 * route layer takes the gate as an injected dependency, so `app.ts` stays
 * loadable (and the admission policy stays testable) without a Durable Object
 * host. See `pool.ts` for the policy and `pool-do.ts` for the DO.
 */

import { DEFAULT_LIMITS, POOL_DO_NAME, type AdmitRequest, type AdmitResult, type PoolGate } from "./pool"
import type { PoolEnv } from "./types"

function stub(env: PoolEnv) {
  const ns = env.SANDBOX_POOL
  return ns.get(ns.idFromName(POOL_DO_NAME))
}

/**
 * A ledger that cannot be reached must not take the pool down with it: the
 * container start will still fail loudly on its own if the pool really is
 * exhausted, so a broken gate degrades to today's behaviour (admit, and let
 * Cloudflare enforce `max_instances`) rather than refusing every request.
 */
function failOpen(reason: unknown): AdmitResult {
  console.warn(
    `[sandbox-pool] admission ledger unavailable, admitting without a lease: ${
      reason instanceof Error ? reason.message : String(reason)
    }`,
  )
  return { granted: true, renewed: false, activeTotal: 0, activeForTenant: 0 }
}

export const durableObjectPoolGate: PoolGate = {
  async admit(env: unknown, req: AdmitRequest): Promise<AdmitResult> {
    try {
      const res = await stub(env as PoolEnv).fetch("https://sandbox-pool/admit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      })
      if (!res.ok) return failOpen(`pool DO returned HTTP ${res.status}`)
      return (await res.json()) as AdmitResult
    } catch (err) {
      return failOpen(err)
    }
  },

  async release(env: unknown, sessionId: string): Promise<void> {
    try {
      await stub(env as PoolEnv).fetch("https://sandbox-pool/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })
    } catch (err) {
      // A lease we fail to release expires on its own TTL
      // (`DEFAULT_LIMITS.leaseTtlMs`), so this is a delay, never a leak.
      console.warn(
        `[sandbox-pool] release failed for ${sessionId}; lease expires in ${DEFAULT_LIMITS.leaseTtlMs}ms: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  },
}
