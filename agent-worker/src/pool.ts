// AQU-1848 — sandbox pool admission control.
//
// The container pool is account-wide and small (`max_instances` in
// wrangler.toml, 20 in production). Before this module, nothing counted the
// containers in flight: the 21st concurrent agent run or sandbox import simply
// failed at container-start, and because the import route is open to any
// project lead with a 25MB upload and two LLM program attempts, one tenant
// could hold every slot and lock the pool for the whole platform.
//
// So every route that touches a container now takes a *lease* first. Leases are
// counted two ways — a global cap (the pool) and a per-tenant cap (fairness) —
// and a caller that finds the pool full WAITS for a slot instead of failing
// (see `admitWithWait`). Over the per-tenant cap is different: that is the
// tenant's own doing, so it is refused immediately with a clear message rather
// than parked in a queue behind itself.
//
// This file is deliberately pure — no bindings, no clock, no sleep of its own —
// so the whole admission policy is unit-testable without a container runtime
// (the same reason `sandbox.ts` declares `SandboxLike`). The Durable Object
// that owns the ledger lives in `pool-do.ts`; the binding that talks to it
// lives in `pool-gate.ts`.

/** A single in-flight container, keyed by the session that holds it. */
export interface Lease {
  /** Opaque tenant key supplied by the caller (`user:123`, `org:45`, …). */
  tenant: string
  /** Epoch ms after which the lease is assumed dead and may be reclaimed. */
  expiresAt: number
}

export interface PoolLimits {
  /** Global ceiling — keep at or below wrangler's `max_instances`. */
  maxTotal: number
  /** Per-tenant ceiling, so one org cannot drain the pool. */
  maxPerTenant: number
  /** How long a lease survives without renewal. */
  leaseTtlMs: number
}

/**
 * Why an admission was refused.
 *
 * `pool_full` is transient and worth waiting on — somebody else's container
 * will free up. `tenant_full` is not: the caller is already holding its own
 * cap, so waiting would park it behind itself. Callers must treat them
 * differently (see `admitWithWait`).
 */
export type DenyReason = "pool_full" | "tenant_full"

export type AdmitResult =
  | {
      granted: true
      /** True when the session already held a lease and this call extended it. */
      renewed: boolean
      activeTotal: number
      activeForTenant: number
    }
  | {
      granted: false
      reason: DenyReason
      activeTotal: number
      activeForTenant: number
      /** Hint for how long to wait before retrying. */
      retryAfterMs: number
    }

export interface AdmitRequest {
  sessionId: string
  tenant: string
}

export const DEFAULT_LIMITS: PoolLimits = {
  // Matches `max_instances` in wrangler.toml. Kept as an explicit number rather
  // than read from the container config because the Worker has no way to query
  // it at runtime — if one moves, move the other.
  maxTotal: 20,
  // Three concurrent containers is more than any single UI flow needs (an agent
  // run plus a couple of imports) and still leaves 17 slots for everyone else
  // when one tenant is at its cap.
  maxPerTenant: 3,
  // `/exec` allows up to MAX_TIMEOUT_MS (300s); add headroom so a legitimately
  // long run is never evicted mid-exec, but a crashed caller that never sends
  // DELETE still frees its slot on its own.
  leaseTtlMs: 330_000,
}

/** Clamp for the retry hint, so a caller never spins nor stalls on one poll. */
const MIN_RETRY_MS = 250
const MAX_RETRY_MS = 2_000

/** The tenant recorded when a caller sends no tenant header. */
export const ANONYMOUS_TENANT = "anonymous"

/**
 * The single ledger instance every session shares, so the global cap is
 * actually global. Exported because both the gate and the `/pool/stats` route
 * address the same Durable Object — a second name would silently split the
 * ledger and let the pool overshoot.
 */
export const POOL_DO_NAME = "global"

function clampRetry(ms: number): number {
  if (!Number.isFinite(ms)) return MAX_RETRY_MS
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Math.ceil(ms)))
}

/**
 * The lease ledger. Single-threaded by construction — it is only ever driven
 * from inside one Durable Object, which is what makes the read-then-write in
 * `admit` safe without a lock.
 */
export class PoolLedger {
  private readonly leases = new Map<string, Lease>()

  constructor(private readonly limits: PoolLimits = DEFAULT_LIMITS) {}

  /** Drop leases whose holder died without releasing. Returns how many went. */
  prune(now: number): number {
    let dropped = 0
    for (const [sessionId, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.leases.delete(sessionId)
        dropped++
      }
    }
    return dropped
  }

  /**
   * Take or renew a lease.
   *
   * Renewal matters as much as acquisition: one session calls `/exec` several
   * times (inspect, then up to two parser attempts, then a stat), and each of
   * those is the SAME container. Counting them as separate leases would have a
   * single import exhaust its own per-tenant cap.
   */
  admit(req: AdmitRequest, now: number): AdmitResult {
    this.prune(now)
    const tenant = req.tenant || ANONYMOUS_TENANT
    const existing = this.leases.get(req.sessionId)
    if (existing) {
      existing.expiresAt = now + this.limits.leaseTtlMs
      return {
        granted: true,
        renewed: true,
        activeTotal: this.leases.size,
        activeForTenant: this.countForTenant(existing.tenant),
      }
    }

    const activeTotal = this.leases.size
    const activeForTenant = this.countForTenant(tenant)

    // Per-tenant first: a tenant at its own cap gets a definitive answer even
    // when the pool happens to be full too, so the message names the real cause
    // and the caller does not sit in a queue it can never leave.
    if (activeForTenant >= this.limits.maxPerTenant) {
      return {
        granted: false,
        reason: "tenant_full",
        activeTotal,
        activeForTenant,
        retryAfterMs: clampRetry(this.msUntilNextFree(tenant, now)),
      }
    }
    if (activeTotal >= this.limits.maxTotal) {
      return {
        granted: false,
        reason: "pool_full",
        activeTotal,
        activeForTenant,
        retryAfterMs: clampRetry(this.msUntilNextFree(null, now)),
      }
    }

    this.leases.set(req.sessionId, { tenant, expiresAt: now + this.limits.leaseTtlMs })
    return {
      granted: true,
      renewed: false,
      activeTotal: this.leases.size,
      activeForTenant: activeForTenant + 1,
    }
  }

  /** Give the slot back. Idempotent — a double DELETE is not an error. */
  release(sessionId: string): boolean {
    return this.leases.delete(sessionId)
  }

  countForTenant(tenant: string): number {
    let n = 0
    for (const lease of this.leases.values()) if (lease.tenant === tenant) n++
    return n
  }

  get size(): number {
    return this.leases.size
  }

  /** Occupancy detail for `/pool/stats`. */
  entries(): Array<{ sessionId: string } & Lease> {
    return [...this.leases].map(([sessionId, lease]) => ({ sessionId, ...lease }))
  }

  /**
   * How long until a slot could plausibly free up — the soonest lease expiry,
   * optionally restricted to one tenant's own leases. Only a hint: a holder
   * usually releases well before its TTL.
   */
  private msUntilNextFree(tenant: string | null, now: number): number {
    let soonest = Number.POSITIVE_INFINITY
    for (const lease of this.leases.values()) {
      if (tenant !== null && lease.tenant !== tenant) continue
      soonest = Math.min(soonest, lease.expiresAt - now)
    }
    return soonest
  }
}

/** Read the limits out of env vars, falling back to `DEFAULT_LIMITS`. */
export function limitsFromEnv(env: {
  SANDBOX_MAX_TOTAL?: string
  SANDBOX_MAX_PER_TENANT?: string
  SANDBOX_LEASE_TTL_MS?: string
}): PoolLimits {
  return {
    maxTotal: positiveIntOr(env.SANDBOX_MAX_TOTAL, DEFAULT_LIMITS.maxTotal),
    maxPerTenant: positiveIntOr(env.SANDBOX_MAX_PER_TENANT, DEFAULT_LIMITS.maxPerTenant),
    leaseTtlMs: positiveIntOr(env.SANDBOX_LEASE_TTL_MS, DEFAULT_LIMITS.leaseTtlMs),
  }
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

// ── The gate the route layer talks to ───────────────────────────────────────

/**
 * How the routes reach the ledger. Injected into `createApp` exactly like
 * `ResolveSandbox`, so route tests run against an in-memory gate and never
 * need a Durable Object.
 */
export interface PoolGate {
  admit(env: unknown, req: AdmitRequest): Promise<AdmitResult>
  release(env: unknown, sessionId: string): Promise<void>
}

export interface WaitOptions {
  /** Total budget for waiting on a full pool before giving up. */
  maxWaitMs: number
  /** Injected so tests advance time instead of sleeping. */
  sleep: (ms: number) => Promise<void>
  /** Injected for the same reason. */
  now: () => number
}

/** What `admitWithWait` settles on, plus how long it actually waited. */
export type WaitedAdmitResult = AdmitResult & { waitedMs: number }

/**
 * Admit, waiting out a full pool rather than failing the caller.
 *
 * This is the behaviour the ticket's first acceptance criterion describes: with
 * the pool artificially shrunk, the run that arrives third *waits and then
 * completes* instead of erroring. We re-poll until the budget is spent, using
 * the ledger's own `retryAfterMs` hint so a near-expiry lease is picked up
 * promptly and a far-off one does not cost a busy loop.
 *
 * `tenant_full` is returned immediately and never waited on — the caller is at
 * its own cap, so the only thing that would free a slot is the caller itself.
 */
export async function admitWithWait(
  gate: PoolGate,
  env: unknown,
  req: AdmitRequest,
  opts: WaitOptions,
): Promise<WaitedAdmitResult> {
  const startedAt = opts.now()
  let result = await gate.admit(env, req)
  for (;;) {
    if (result.granted || result.reason === "tenant_full") {
      return { ...result, waitedMs: opts.now() - startedAt }
    }
    const elapsed = opts.now() - startedAt
    const remaining = opts.maxWaitMs - elapsed
    if (remaining <= 0) return { ...result, waitedMs: elapsed }
    await opts.sleep(Math.min(result.retryAfterMs, remaining))
    result = await gate.admit(env, req)
  }
}
