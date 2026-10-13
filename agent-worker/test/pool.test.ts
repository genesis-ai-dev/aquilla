import { describe, it, expect } from "vitest"
import {
  admitWithWait,
  ANONYMOUS_TENANT,
  DEFAULT_LIMITS,
  limitsFromEnv,
  PoolLedger,
  type PoolGate,
} from "../src/pool"

// ---------------------------------------------------------------------------
// AQU-1848 — the container pool is account-wide and small (`max_instances`,
// 20 in production). Before this, nothing counted the containers in flight: the
// 21st concurrent run failed at container-start, and one tenant hammering the
// sandbox-import route could hold every slot. These tests pin the policy:
//   * a global cap, so the pool is never oversubscribed;
//   * a per-tenant cap, so one tenant cannot drain it;
//   * renewal, so a multi-exec session holds ONE slot, not one per call;
//   * TTL reclaim, so a caller that dies without releasing frees its slot;
//   * waiting on a full pool, but never on your own cap.
// ---------------------------------------------------------------------------

const LIMITS = { maxTotal: 3, maxPerTenant: 2, leaseTtlMs: 1_000 }

describe("PoolLedger", () => {
  it("admits up to the global cap and then reports pool_full", () => {
    const pool = new PoolLedger(LIMITS)
    // Three different tenants so the per-tenant cap is never the binding one.
    expect(pool.admit({ sessionId: "a", tenant: "user:1" }, 0).granted).toBe(true)
    expect(pool.admit({ sessionId: "b", tenant: "user:2" }, 0).granted).toBe(true)
    expect(pool.admit({ sessionId: "c", tenant: "user:3" }, 0).granted).toBe(true)

    const denied = pool.admit({ sessionId: "d", tenant: "user:4" }, 0)
    expect(denied.granted).toBe(false)
    if (denied.granted) throw new Error("unreachable")
    expect(denied.reason).toBe("pool_full")
    expect(denied.activeTotal).toBe(3)
  })

  it("caps one tenant well below the pool, leaving slots for everyone else", () => {
    const pool = new PoolLedger(LIMITS)
    expect(pool.admit({ sessionId: "a", tenant: "user:1" }, 0).granted).toBe(true)
    expect(pool.admit({ sessionId: "b", tenant: "user:1" }, 0).granted).toBe(true)

    const denied = pool.admit({ sessionId: "c", tenant: "user:1" }, 0)
    expect(denied.granted).toBe(false)
    if (denied.granted) throw new Error("unreachable")
    expect(denied.reason).toBe("tenant_full")

    // The slot that tenant 1 was refused is still available to anyone else —
    // that is the whole point of the per-tenant cap.
    expect(pool.admit({ sessionId: "c", tenant: "user:2" }, 0).granted).toBe(true)
  })

  it("reports tenant_full (not pool_full) when the caller is at its own cap and the pool is also full", () => {
    // Otherwise the caller would be told to wait for a slot that its own
    // containers are holding — a queue it can never leave.
    const pool = new PoolLedger({ maxTotal: 2, maxPerTenant: 2, leaseTtlMs: 1_000 })
    pool.admit({ sessionId: "a", tenant: "user:1" }, 0)
    pool.admit({ sessionId: "b", tenant: "user:1" }, 0)
    const denied = pool.admit({ sessionId: "c", tenant: "user:1" }, 0)
    if (denied.granted) throw new Error("unreachable")
    expect(denied.reason).toBe("tenant_full")
  })

  it("renews an existing session instead of taking a second slot", () => {
    // One import calls /exec several times (inspect, parse attempts, stat) on
    // the SAME container. Counting each as a new lease would have a single
    // import exhaust its own per-tenant cap.
    const pool = new PoolLedger(LIMITS)
    const first = pool.admit({ sessionId: "s1", tenant: "user:1" }, 0)
    expect(first.granted && first.renewed).toBe(false)

    for (let i = 0; i < 5; i++) {
      const again = pool.admit({ sessionId: "s1", tenant: "user:1" }, 10)
      expect(again.granted).toBe(true)
      if (!again.granted) throw new Error("unreachable")
      expect(again.renewed).toBe(true)
    }
    expect(pool.size).toBe(1)
    expect(pool.countForTenant("user:1")).toBe(1)
  })

  it("extends the lease on renewal so a long run is not evicted mid-exec", () => {
    const pool = new PoolLedger(LIMITS)
    pool.admit({ sessionId: "s1", tenant: "user:1" }, 0)
    // At t=900 the original lease (ttl 1000) has not expired; renewing pushes
    // expiry to 1900, so a prune at 1500 must NOT reclaim it.
    pool.admit({ sessionId: "s1", tenant: "user:1" }, 900)
    expect(pool.prune(1_500)).toBe(0)
    expect(pool.size).toBe(1)
  })

  it("reclaims a lease whose holder died without releasing", () => {
    const pool = new PoolLedger(LIMITS)
    pool.admit({ sessionId: "a", tenant: "user:1" }, 0)
    pool.admit({ sessionId: "b", tenant: "user:2" }, 0)
    pool.admit({ sessionId: "c", tenant: "user:3" }, 0)
    expect(pool.admit({ sessionId: "d", tenant: "user:4" }, 0).granted).toBe(false)

    // Past the TTL the pool must not stay wedged just because nobody sent
    // DELETE — a crashed Worker must not cost a slot forever.
    expect(pool.admit({ sessionId: "d", tenant: "user:4" }, 1_001).granted).toBe(true)
  })

  it("releases idempotently", () => {
    const pool = new PoolLedger(LIMITS)
    pool.admit({ sessionId: "a", tenant: "user:1" }, 0)
    expect(pool.release("a")).toBe(true)
    expect(pool.release("a")).toBe(false)
    expect(pool.size).toBe(0)
  })

  it("buckets callers that send no tenant under one shared budget", () => {
    const pool = new PoolLedger(LIMITS)
    expect(pool.admit({ sessionId: "a", tenant: "" }, 0).granted).toBe(true)
    expect(pool.admit({ sessionId: "b", tenant: "" }, 0).granted).toBe(true)
    const denied = pool.admit({ sessionId: "c", tenant: "" }, 0)
    if (denied.granted) throw new Error("unreachable")
    expect(denied.reason).toBe("tenant_full")
    expect(pool.countForTenant(ANONYMOUS_TENANT)).toBe(2)
  })

  it("clamps the retry hint into a band that neither spins nor stalls", () => {
    const pool = new PoolLedger({ maxTotal: 1, maxPerTenant: 1, leaseTtlMs: 600_000 })
    pool.admit({ sessionId: "a", tenant: "user:1" }, 0)
    const denied = pool.admit({ sessionId: "b", tenant: "user:2" }, 0)
    if (denied.granted) throw new Error("unreachable")
    // A 10-minute lease must not produce a 10-minute retry hint.
    expect(denied.retryAfterMs).toBeLessThanOrEqual(2_000)
    expect(denied.retryAfterMs).toBeGreaterThanOrEqual(250)
  })
})

describe("limitsFromEnv", () => {
  it("falls back to the defaults when unset or nonsense", () => {
    expect(limitsFromEnv({})).toEqual(DEFAULT_LIMITS)
    expect(limitsFromEnv({ SANDBOX_MAX_TOTAL: "nope", SANDBOX_MAX_PER_TENANT: "0" })).toEqual(DEFAULT_LIMITS)
    expect(limitsFromEnv({ SANDBOX_MAX_TOTAL: "-5" }).maxTotal).toBe(DEFAULT_LIMITS.maxTotal)
  })

  it("reads overrides, which is how dev shrinks the pool to reproduce saturation", () => {
    expect(limitsFromEnv({ SANDBOX_MAX_TOTAL: "2", SANDBOX_MAX_PER_TENANT: "1", SANDBOX_LEASE_TTL_MS: "5000" }))
      .toEqual({ maxTotal: 2, maxPerTenant: 1, leaseTtlMs: 5_000 })
  })

  it("defaults the global cap to the configured container max_instances", () => {
    // If `max_instances` in wrangler.toml moves, this must move with it.
    expect(DEFAULT_LIMITS.maxTotal).toBe(20)
  })
})

describe("admitWithWait", () => {
  /** A gate over a real ledger, with a clock the test advances by sleeping. */
  function gateOver(pool: PoolLedger, clock: { now: number }): PoolGate {
    return {
      async admit(_env, req) {
        return pool.admit(req, clock.now)
      },
      async release(_env, sessionId) {
        pool.release(sessionId)
      },
    }
  }

  it("waits out a full pool and then succeeds — the third run completes rather than failing", async () => {
    // The ticket's first acceptance criterion, with the pool shrunk to 2.
    const pool = new PoolLedger({ maxTotal: 2, maxPerTenant: 2, leaseTtlMs: 1_000 })
    const clock = { now: 0 }
    pool.admit({ sessionId: "a", tenant: "user:1" }, 0)
    pool.admit({ sessionId: "b", tenant: "user:2" }, 0)

    const sleeps: number[] = []
    const result = await admitWithWait(
      gateOver(pool, clock),
      {},
      { sessionId: "c", tenant: "user:3" },
      {
        maxWaitMs: 10_000,
        now: () => clock.now,
        // Sleeping advances the clock; at t>1000 the two leases above expire
        // and the waiting caller is admitted.
        sleep: async (ms) => {
          sleeps.push(ms)
          clock.now += ms
        },
      },
    )

    expect(result.granted).toBe(true)
    expect(sleeps.length).toBeGreaterThan(0)
    expect(result.waitedMs).toBeGreaterThan(0)
  })

  it("gives up with pool_full once the wait budget is spent", async () => {
    const pool = new PoolLedger({ maxTotal: 1, maxPerTenant: 1, leaseTtlMs: 600_000 })
    const clock = { now: 0 }
    pool.admit({ sessionId: "a", tenant: "user:1" }, 0)

    const result = await admitWithWait(
      gateOver(pool, clock),
      {},
      { sessionId: "b", tenant: "user:2" },
      { maxWaitMs: 1_000, now: () => clock.now, sleep: async (ms) => { clock.now += ms } },
    )

    expect(result.granted).toBe(false)
    if (result.granted) throw new Error("unreachable")
    expect(result.reason).toBe("pool_full")
    // Bounded: it must not have waited past its budget.
    expect(clock.now).toBeLessThanOrEqual(1_000)
  })

  it("never waits on the caller's own cap", async () => {
    // Waiting here would park the caller behind its own containers.
    const pool = new PoolLedger({ maxTotal: 10, maxPerTenant: 1, leaseTtlMs: 600_000 })
    const clock = { now: 0 }
    pool.admit({ sessionId: "a", tenant: "user:1" }, 0)

    const sleeps: number[] = []
    const result = await admitWithWait(
      gateOver(pool, clock),
      {},
      { sessionId: "b", tenant: "user:1" },
      { maxWaitMs: 60_000, now: () => clock.now, sleep: async (ms) => { sleeps.push(ms) } },
    )

    expect(result.granted).toBe(false)
    if (result.granted) throw new Error("unreachable")
    expect(result.reason).toBe("tenant_full")
    expect(sleeps).toEqual([])
  })

  it("does not sleep past the remaining budget", async () => {
    const pool = new PoolLedger({ maxTotal: 1, maxPerTenant: 1, leaseTtlMs: 600_000 })
    const clock = { now: 0 }
    pool.admit({ sessionId: "a", tenant: "user:1" }, 0)
    const sleeps: number[] = []
    await admitWithWait(
      gateOver(pool, clock),
      {},
      { sessionId: "b", tenant: "user:2" },
      { maxWaitMs: 700, now: () => clock.now, sleep: async (ms) => { sleeps.push(ms); clock.now += ms } },
    )
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(700)
  })
})
