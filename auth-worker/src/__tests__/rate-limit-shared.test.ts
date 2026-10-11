// AQU-1843: the shared volumetric limiter (db/shared/rate-limit.ts).
//
// These run against real Postgres (PGlite) through the production shim, because
// every property that matters here is a property of the SQL: the old limiter's
// `SELECT COUNT(*)` + `INSERT` pair was correct in isolation and wrong under
// concurrency, which is exactly what a hand-rolled fake would have missed.
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
  bumpRateLimit,
  enforceRateLimit,
  ipRateLimitIdentifier,
  peekRateLimit,
  pruneRateLimitCounters,
  userRateLimitIdentifier,
} from "../../../db/shared/rate-limit"
import type { AquillaDb } from "../../../db/shim/postgres"

const USER = userRateLimitIdentifier(42)

/** A db handle whose every statement throws, standing in for the limiter
 *  backend being unavailable (a Postgres hiccup, Hyperdrive refusing). */
const brokenDb = {
  prepare() {
    return {
      bind() {
        return this
      },
      async first(): Promise<never> {
        throw new Error("backend down")
      },
      async run(): Promise<never> {
        throw new Error("backend down")
      },
    }
  },
} as unknown as AquillaDb

describe("enforceRateLimit", () => {
  it("allows exactly `limit` calls in a window and refuses the rest", async () => {
    for (let i = 1; i <= 3; i++) {
      const decision = await enforceRateLimit(env.AQUILLA_PG, {
        kind: "test_sequential",
        identifier: USER,
        limit: 3,
        failMode: "closed",
      })
      expect(decision).toMatchObject({ allowed: true, hits: i, limit: 3, degraded: false })
    }
    const over = await enforceRateLimit(env.AQUILLA_PG, {
      kind: "test_sequential",
      identifier: USER,
      limit: 3,
      failMode: "closed",
    })
    expect(over.allowed).toBe(false)
    expect(over.retryAfterSeconds).toBeGreaterThan(0)
  })

  // The regression this issue exists for. The old limiter read the count and
  // then wrote, so N callers in flight at once all read the same pre-burst
  // count and all passed: 50 parallel requests against a limit of 10 let 50
  // through. One atomic upsert hands each caller a distinct ordinal.
  it("lets at most `limit` through when 50 calls run in parallel", async () => {
    const decisions = await Promise.all(
      Array.from({ length: 50 }, () =>
        enforceRateLimit(env.AQUILLA_PG, {
          kind: "test_burst",
          identifier: USER,
          limit: 10,
          failMode: "closed",
        }),
      ),
    )
    expect(decisions.filter((d) => d.allowed)).toHaveLength(10)
    // Every caller got its own ordinal — no two saw the same count.
    expect(new Set(decisions.map((d) => d.hits)).size).toBe(50)
  })

  it("keeps separate buckets per kind and per identifier", async () => {
    await enforceRateLimit(env.AQUILLA_PG, {
      kind: "test_scoped",
      identifier: USER,
      limit: 1,
      failMode: "closed",
    })
    const otherUser = await enforceRateLimit(env.AQUILLA_PG, {
      kind: "test_scoped",
      identifier: userRateLimitIdentifier(43),
      limit: 1,
      failMode: "closed",
    })
    const otherKind = await enforceRateLimit(env.AQUILLA_PG, {
      kind: "test_scoped_other",
      identifier: USER,
      limit: 1,
      failMode: "closed",
    })
    expect(otherUser.allowed).toBe(true)
    expect(otherKind.allowed).toBe(true)
  })

  it("charges `cost` units in one statement, so a fan-out cannot buy N calls for the price of one", async () => {
    const decision = await enforceRateLimit(env.AQUILLA_PG, {
      kind: "test_cost",
      identifier: USER,
      limit: 10,
      failMode: "open",
      cost: 4,
    })
    expect(decision).toMatchObject({ allowed: true, hits: 4 })
    expect(await peekRateLimit(env.AQUILLA_PG, "test_cost", USER)).toBe(4)
  })

  it("refuses a paid route when the limiter backend is unavailable", async () => {
    const decision = await enforceRateLimit(brokenDb, {
      kind: "chat_completions",
      identifier: USER,
      limit: 300,
      failMode: "closed",
    })
    expect(decision).toMatchObject({ allowed: false, degraded: true })
  })

  // AQU-1843 follow-up (found by the PR bot walk on a preview where migration
  // 0158 was unapplied): with the table absent, EVERY fail-closed route refused
  // its first call — chat, agent runs, transcription and TTS all down for
  // everyone until a person ran the migration. Before this module was rewritten
  // the same condition was harmless, because the old limiter always failed open.
  // A missing table is a provisioning state, not an outage to protect against,
  // so it is allowed through regardless of failMode.
  it("lets a PAID route through when the counters table does not exist", async () => {
    const missingTable = {
      prepare() {
        return {
          bind() {
            return this
          },
          async first(): Promise<never> {
            throw Object.assign(
              new Error('relation "rate_limit_counters" does not exist'),
              { code: "42P01" },
            )
          },
          async run(): Promise<never> {
            throw Object.assign(new Error("undefined_table"), { code: "42P01" })
          },
        }
      },
    } as unknown as AquillaDb

    const decision = await enforceRateLimit(missingTable, {
      kind: "chat_completions",
      identifier: USER,
      limit: 300,
      failMode: "closed",
    })
    expect(decision).toMatchObject({ allowed: true, degraded: true, uninstalled: true })
  })

  it("still fails a paid route closed when the backend errors for any other reason", async () => {
    // The carve-out above must not widen into "any error allows spending".
    const decision = await enforceRateLimit(brokenDb, {
      kind: "chat_completions",
      identifier: USER,
      limit: 300,
      failMode: "closed",
    })
    expect(decision).toMatchObject({ allowed: false, degraded: true })
    expect(decision.uninstalled).toBe(false)
  })

  it("keeps a free read working when the limiter backend is unavailable", async () => {
    const decision = await enforceRateLimit(brokenDb, {
      kind: "external_read",
      identifier: USER,
      limit: 300,
      failMode: "open",
    })
    expect(decision).toMatchObject({ allowed: true, degraded: true })
  })
})

describe("peekRateLimit / bumpRateLimit", () => {
  it("peek does not consume budget", async () => {
    expect(await peekRateLimit(env.AQUILLA_PG, "test_peek", USER)).toBe(0)
    await bumpRateLimit(env.AQUILLA_PG, "test_peek", USER)
    expect(await peekRateLimit(env.AQUILLA_PG, "test_peek", USER)).toBe(1)
    expect(await peekRateLimit(env.AQUILLA_PG, "test_peek", USER)).toBe(1)
  })

  it("peek reports an unavailable backend as null rather than as zero", async () => {
    // The caller picks its own fail mode from this; reporting 0 would have been
    // the old module's silent fail-open.
    expect(await peekRateLimit(brokenDb, "test_peek", USER)).toBeNull()
  })

  it("bump never throws when the backend is unavailable", async () => {
    await expect(
      bumpRateLimit(brokenDb, "external_credential_invalid", ipRateLimitIdentifier("10.0.0.1")),
    ).resolves.toBeUndefined()
  })
})

describe("pruneRateLimitCounters", () => {
  it("drops finished windows and keeps the live one", async () => {
    await bumpRateLimit(env.AQUILLA_PG, "test_prune", USER)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO rate_limit_counters (kind, identifier, window_start, hits)
       VALUES ('test_prune', ?, now() - interval '2 hours', 9)`,
    )
      .bind(USER)
      .run()

    await pruneRateLimitCounters(env.AQUILLA_PG)

    const rows = await env.AQUILLA_PG.prepare(
      "SELECT hits FROM rate_limit_counters WHERE kind = 'test_prune'",
    )
      .bind()
      .all<{ hits: number }>()
    expect(rows.results).toHaveLength(1)
    expect(Number(rows.results[0].hits)).toBe(1)
  })
})
