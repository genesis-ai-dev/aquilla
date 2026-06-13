// Tests for tts-budget.ts — intent-encoding per Rule 9.
//
// WHY these tests matter:
//   - The budget guard is the only mechanism preventing runaway GPU spend.
//   - Log-only mode MUST pass all requests through so we don't block users
//     while limits are being sized.
//   - Enforce mode MUST block over-budget users to protect the platform.
//   - recordTtsUsage MUST write to the correct per-user AND global sentinel
//     rows so that org rollups and platform totals are accurate.
//   - A DB error during the pre-check MUST degrade gracefully (allow through)
//     so infra hiccups don't block users who are within budget.

import { describe, it, expect } from "vitest"
import { checkTtsBudget, recordTtsUsage, runTtsGuard } from "../tts-budget"

// ── Minimal AquillaDb stub ──────────────────────────────────────────────────

interface Row {
  user_id: number
  org_id: number
  date_utc: string
  request_count: number
  audio_seconds: number
}

/**
 * Build a stub AquillaDb that backs tts_usage_daily with an in-memory array.
 * Supports the exact SQL patterns tts-budget.ts uses:
 *   - SUM(audio_seconds) WHERE user_id = ? AND date_utc = ?  (pre-check)
 *   - INSERT … ON CONFLICT … DO UPDATE (upsert)
 */
function makeStubDb(initial: Row[] = []): AquillaDb {
  const rows: Row[] = [...initial]

  return {
    prepare(sql: string) {
      let boundArgs: unknown[] = []
      const stmt = {
        bind(...args: unknown[]) {
          boundArgs = args
          return stmt
        },
        async first<T = unknown>(): Promise<T | null> {
          if (sql.includes("SUM(audio_seconds)")) {
            // Pre-check: SUM for (user_id, date_utc)
            const [userId, dateUtc] = boundArgs as [number, string]
            const total = rows
              .filter((r) => r.user_id === userId && r.date_utc === dateUtc)
              .reduce((s, r) => s + r.audio_seconds, 0)
            return { total_seconds: total } as unknown as T
          }
          return null
        },
        async run() {
          if (sql.includes("INSERT INTO tts_usage_daily")) {
            // Bind params: (user_id, org_id, date_utc, audio_seconds)
            // request_count is a literal 1 in the SQL — NOT a bind param.
            const [userId, orgId, dateUtc, audioSeconds] = boundArgs as [
              number,
              number,
              string,
              number,
            ]
            const existing = rows.find(
              (r) => r.user_id === userId && r.org_id === orgId && r.date_utc === dateUtc,
            )
            if (existing) {
              existing.request_count += 1
              existing.audio_seconds += audioSeconds
            } else {
              rows.push({
                user_id: userId,
                org_id: orgId,
                date_utc: dateUtc,
                request_count: 1,
                audio_seconds: audioSeconds,
              })
            }
          }
          return { results: [], success: true as const, meta: {} as never }
        },
        async all() {
          return { results: [], success: true as const, meta: {} as never }
        },
        async raw() {
          return []
        },
      }
      return stmt
    },
    async batch() {
      return []
    },
    async exec() {
      return { count: 0, duration: 0 }
    },
    async close() {},
    _rows() {
      return rows
    },
  } as unknown as AquillaDb & { _rows(): Row[] }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// ── checkTtsBudget ────────────────────────────────────────────────────────────

describe("checkTtsBudget", () => {
  it("returns over=false and seconds=0 for a user with no prior usage", async () => {
    const db = makeStubDb()
    const result = await checkTtsBudget(db, 42, { TTS_USER_DAILY_SECONDS_LIMIT: "3600" })
    expect(result.over).toBe(false)
    // WHY: a fresh user must never be pre-emptively blocked
    expect(result.seconds).toBe(0)
    expect(result.limit).toBe(3600)
  })

  it("returns over=false when usage is below the limit", async () => {
    const db = makeStubDb([
      { user_id: 1, org_id: 5, date_utc: today(), request_count: 3, audio_seconds: 299 },
    ])
    const result = await checkTtsBudget(db, 1, { TTS_USER_DAILY_SECONDS_LIMIT: "300" })
    expect(result.over).toBe(false)
    expect(result.seconds).toBe(299)
  })

  it("returns over=true when usage meets or exceeds the limit", async () => {
    const db = makeStubDb([
      { user_id: 1, org_id: 5, date_utc: today(), request_count: 5, audio_seconds: 300 },
    ])
    const result = await checkTtsBudget(db, 1, { TTS_USER_DAILY_SECONDS_LIMIT: "300" })
    // WHY: enforcement is >=; exactly at limit must be over so the NEXT
    // request is blocked (pre-check+post-record pattern: one overshoot allowed)
    expect(result.over).toBe(true)
  })

  it("sums across multiple org rows for the same user", async () => {
    // WHY: a user in two orgs has ONE combined quota; all rows contribute
    const db = makeStubDb([
      { user_id: 7, org_id: 1, date_utc: today(), request_count: 1, audio_seconds: 200 },
      { user_id: 7, org_id: 2, date_utc: today(), request_count: 1, audio_seconds: 150 },
    ])
    const result = await checkTtsBudget(db, 7, { TTS_USER_DAILY_SECONDS_LIMIT: "300" })
    expect(result.seconds).toBe(350)
    expect(result.over).toBe(true)
  })

  it("uses default limit of 36000 when env var is absent", async () => {
    const db = makeStubDb()
    const result = await checkTtsBudget(db, 1, {})
    expect(result.limit).toBe(36000)
  })
})

// ── recordTtsUsage ────────────────────────────────────────────────────────────

describe("recordTtsUsage", () => {
  it("writes the correct seconds to the per-user row", async () => {
    const db = makeStubDb() as AquillaDb & { _rows(): Row[] }
    await recordTtsUsage(db, 3, 9, 42.5)
    const rows = (db as unknown as { _rows(): Row[] })._rows()
    const userRow = rows.find((r) => r.user_id === 3 && r.org_id === 9)
    expect(userRow).toBeDefined()
    // WHY: the per-user+org row is what org rollup queries aggregate
    expect(userRow!.audio_seconds).toBeCloseTo(42.5)
    expect(userRow!.request_count).toBe(1)
  })

  it("writes the correct seconds to the global sentinel (user_id=0, org_id=0)", async () => {
    const db = makeStubDb() as AquillaDb & { _rows(): Row[] }
    await recordTtsUsage(db, 3, 9, 42.5)
    const rows = (db as unknown as { _rows(): Row[] })._rows()
    const sentinelRow = rows.find((r) => r.user_id === 0 && r.org_id === 0)
    // WHY: the global sentinel gives an O(1) platform total without a table scan
    expect(sentinelRow).toBeDefined()
    expect(sentinelRow!.audio_seconds).toBeCloseTo(42.5)
  })

  it("accumulates seconds across multiple calls for the same user+org", async () => {
    const db = makeStubDb() as AquillaDb & { _rows(): Row[] }
    await recordTtsUsage(db, 1, 5, 10)
    await recordTtsUsage(db, 1, 5, 20)
    const rows = (db as unknown as { _rows(): Row[] })._rows()
    const userRow = rows.find((r) => r.user_id === 1 && r.org_id === 5)
    expect(userRow!.audio_seconds).toBeCloseTo(30)
    expect(userRow!.request_count).toBe(2)
  })

  it("attributes seconds to the org_id passed in (org rollup is correct)", async () => {
    const db = makeStubDb() as AquillaDb & { _rows(): Row[] }
    await recordTtsUsage(db, 1, 10, 15) // org 10
    await recordTtsUsage(db, 2, 20, 25) // org 20
    const rows = (db as unknown as { _rows(): Row[] })._rows()
    // WHY: the org Overview dashboard aggregates WHERE org_id = ?;
    // wrong org attribution would miscount per-org usage
    const org10Total = rows
      .filter((r) => r.org_id === 10 && r.user_id !== 0)
      .reduce((s, r) => s + r.audio_seconds, 0)
    const org20Total = rows
      .filter((r) => r.org_id === 20 && r.user_id !== 0)
      .reduce((s, r) => s + r.audio_seconds, 0)
    expect(org10Total).toBeCloseTo(15)
    expect(org20Total).toBeCloseTo(25)
  })

  it("degrades gracefully — does NOT throw — when the DB errors", async () => {
    // WHY: a counter failure must never surface to a user who already received audio
    const brokenDb = {
      prepare() {
        return {
          bind() {
            return this
          },
          async run() {
            throw new Error("DB connection lost")
          },
        }
      },
    } as unknown as AquillaDb
    // Must resolve without throwing.
    await expect(recordTtsUsage(brokenDb, 1, 5, 10)).resolves.toBeUndefined()
  })
})

// ── runTtsGuard ───────────────────────────────────────────────────────────────

describe("runTtsGuard", () => {
  it("passes (ok=true) in LOG-ONLY mode even when the user is over budget", async () => {
    // WHY: log-only is the default while limits are being sized; blocking here
    // would unexpectedly cut off users before limits are calibrated
    const db = makeStubDb([
      { user_id: 1, org_id: 1, date_utc: today(), request_count: 99, audio_seconds: 99999 },
    ])
    const result = await runTtsGuard(db, 1, {
      TTS_USER_DAILY_SECONDS_LIMIT: "1",
      TTS_BUDGET_ENFORCE: undefined, // omitted → log-only
    })
    expect(result.ok).toBe(true)
  })

  it("passes (ok=true) in LOG-ONLY mode when TTS_BUDGET_ENFORCE='false'", async () => {
    const db = makeStubDb([
      { user_id: 1, org_id: 1, date_utc: today(), request_count: 99, audio_seconds: 99999 },
    ])
    const result = await runTtsGuard(db, 1, {
      TTS_USER_DAILY_SECONDS_LIMIT: "1",
      TTS_BUDGET_ENFORCE: "false",
    })
    expect(result.ok).toBe(true)
  })

  it("blocks (ok=false, 429) in ENFORCE mode when the user is over budget", async () => {
    // WHY: enforcement must produce a 429 with the exact error key the client
    // expects ("tts_daily_limit_exceeded") so the UI can show the right message
    const db = makeStubDb([
      { user_id: 1, org_id: 1, date_utc: today(), request_count: 5, audio_seconds: 500 },
    ])
    const result = await runTtsGuard(db, 1, {
      TTS_USER_DAILY_SECONDS_LIMIT: "100",
      TTS_BUDGET_ENFORCE: "true",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(429)
      expect(result.body.error).toBe("tts_daily_limit_exceeded")
    }
  })

  it("passes (ok=true) in ENFORCE mode when the user is under budget", async () => {
    const db = makeStubDb([
      { user_id: 1, org_id: 1, date_utc: today(), request_count: 1, audio_seconds: 50 },
    ])
    const result = await runTtsGuard(db, 1, {
      TTS_USER_DAILY_SECONDS_LIMIT: "3600",
      TTS_BUDGET_ENFORCE: "true",
    })
    expect(result.ok).toBe(true)
  })

  it("degrades gracefully (ok=true) when the DB pre-check throws", async () => {
    // WHY: infra hiccups must not block users who are within budget
    const brokenDb = {
      prepare() {
        return {
          bind() {
            return this
          },
          async first() {
            throw new Error("timeout")
          },
        }
      },
    } as unknown as AquillaDb
    const result = await runTtsGuard(brokenDb, 1, {
      TTS_USER_DAILY_SECONDS_LIMIT: "3600",
      TTS_BUDGET_ENFORCE: "true",
    })
    expect(result.ok).toBe(true)
  })
})
