/**
 * AQU-1848 — the sandbox pool's admission Durable Object.
 *
 * One singleton instance (name `"global"`) owns the lease ledger for the whole
 * account-wide container pool. A Durable Object is the only primitive that can
 * do this correctly: the check "are 20 containers already running?" is a
 * read-then-write, and every Worker isolate would otherwise race it and
 * over-admit.
 *
 * Like `ProjectSync`, this DO holds **only transient state** and writes nothing
 * to storage. That is safe here rather than merely cheap: leases are renewed by
 * every `/exec` on a live session, so the instance stays warm for exactly as
 * long as containers are in flight. It can only be evicted while idle — and an
 * idle pool has no leases worth remembering. If it is ever evicted mid-flight
 * the ledger fails OPEN (it forgets leases and admits again) rather than
 * deadlocking the pool, which is the right way round for a capacity hint.
 *
 * The policy itself lives in `pool.ts` as a pure class; this file is just the
 * DO host and its tiny HTTP surface.
 */

import { DurableObject } from "cloudflare:workers"
import { limitsFromEnv, PoolLedger, type AdmitRequest } from "./pool"
import type { PoolEnv } from "./types"

export class SandboxPool extends DurableObject<PoolEnv> {
  private ledger: PoolLedger | null = null

  /** Built lazily so an env-var change takes effect on the next cold start. */
  private get pool(): PoolLedger {
    if (!this.ledger) this.ledger = new PoolLedger(limitsFromEnv(this.env))
    return this.ledger
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case "/admit": {
        const body = await request.json<AdmitRequest>().catch(() => null)
        if (!body || typeof body.sessionId !== "string" || !body.sessionId) {
          return Response.json({ error: "sessionId is required" }, { status: 400 })
        }
        const result = this.pool.admit(
          { sessionId: body.sessionId, tenant: typeof body.tenant === "string" ? body.tenant : "" },
          Date.now(),
        )
        return Response.json(result)
      }
      case "/release": {
        const body = await request.json<{ sessionId?: string }>().catch(() => null)
        if (!body || typeof body.sessionId !== "string" || !body.sessionId) {
          return Response.json({ error: "sessionId is required" }, { status: 400 })
        }
        return Response.json({ released: this.pool.release(body.sessionId) })
      }
      case "/stats": {
        const now = Date.now()
        this.pool.prune(now)
        return Response.json({ active: this.pool.size, leases: this.pool.entries() })
      }
      default:
        return Response.json({ error: "not found" }, { status: 404 })
    }
  }
}
