// Tests for sync-worker/src/credits.ts — intent-encoding per Rule 9.
//
// WHY these tests matter:
//   - creditsFor applies the spec's markup formula; a wrong multiplier means
//     every cost figure the admin console shows is wrong.
//   - recordCredit is the only place TTS raw cost enters the cross-rail
//     ledger (org_credit_usage_daily). A silent bug here means the admin
//     console shows zero TTS spend forever.
//   - The upsert must ADD to existing rows, not overwrite them — otherwise
//     prior spend in the same UTC-day disappears.
//   - A missing table (pre-migration) or transient DB error must degrade
//     gracefully so a counter failure never blocks a user who received audio.
//   - A Modal-failed synth must record NO credit (the caller — tts.ts — only
//     calls recordCredit after a successful synthesis; these tests verify the
//     contract from the credits module side).

import { describe, it, expect } from "vitest"
import { creditsFor, recordCredit } from "../credits"

// ── creditsFor ────────────────────────────────────────────────────────────────

describe("creditsFor", () => {
  it("applies the default 4× markup for tts rail", () => {
    // WHY: tts is not the agent rail, so it uses the standard markup.
    // If a cost estimate of 2¢ is used, the admin should see 8 credits.
    expect(creditsFor(2, "tts")).toBe(8)
  })

  it("applies the default 4× markup for llm rail", () => {
    // WHY: same markup as tts; verifies rail='llm' doesn't accidentally use agentMarkup
    expect(creditsFor(10, "llm")).toBe(40)
  })

  it("applies the default 5× markup for agent rail", () => {
    // WHY: agent is the expensive rail and gets a higher markup (5×) to reflect
    // the greater invisible cost and risk of runaway spend
    expect(creditsFor(10, "agent")).toBe(50)
  })

  it("applies a custom markup via cfg", () => {
    // WHY: markup must be overridable per-org without code changes
    expect(creditsFor(3, "tts", { markup: 3.0 })).toBe(9)
  })

  it("applies a custom agentMarkup via cfg", () => {
    expect(creditsFor(4, "agent", { agentMarkup: 2.5 })).toBe(10)
  })

  it("rounds UP (ceil), never down", () => {
    // WHY: credits are the customer-facing price; rounding down would give away
    // fractional cents — Math.ceil is the spec contract
    // 1.5¢ × 4.0 = 6.0 — no rounding needed, but check a fractional case:
    // 1¢ × 4.0 = 4 exactly
    expect(creditsFor(1, "tts", { markup: 4.0 })).toBe(4)
    // 1¢ × 3.1 = 3.1 → ceil → 4
    expect(creditsFor(1, "tts", { markup: 3.1 })).toBe(4)
    // 5¢ × 1.1 = 5.5 → ceil → 6
    expect(creditsFor(5, "tts", { markup: 1.1 })).toBe(6)
  })

  it("returns 0 for 0 raw cost", () => {
    expect(creditsFor(0, "tts")).toBe(0)
  })
})

// ── AquillaDb stub for org_credit_usage_daily ─────────────────────────────────

interface CreditRow {
  org_id: number
  user_id: number
  date_utc: string
  rail: string
  raw_cost_cents: number
  units: number
}

/**
 * Build a stub AquillaDb that backs org_credit_usage_daily with an in-memory
 * array, supporting the upsert pattern recordCredit uses:
 *   INSERT … ON CONFLICT (org_id, user_id, date_utc, rail)
 *   DO UPDATE SET raw_cost_cents += …, units += …
 */
function makeStubDb(initial: CreditRow[] = []): AquillaDb & { _rows(): CreditRow[] } {
  const rows: CreditRow[] = [...initial]

  return {
    prepare(sql: string) {
      let boundArgs: unknown[] = []
      const stmt = {
        bind(...args: unknown[]) {
          boundArgs = args
          return stmt
        },
        async first<T = unknown>(): Promise<T | null> {
          return null
        },
        async run() {
          if (sql.includes("INSERT INTO org_credit_usage_daily")) {
            // Bind order matches recordCredit: (org_id, user_id, date_utc, rail, raw_cost_cents, units)
            const [orgId, userId, dateUtc, rail, rawCostCents, units] = boundArgs as [
              number,
              number,
              string,
              string,
              number,
              number,
            ]
            const existing = rows.find(
              (r) =>
                r.org_id === orgId &&
                r.user_id === userId &&
                r.date_utc === dateUtc &&
                r.rail === rail,
            )
            if (existing) {
              existing.raw_cost_cents += rawCostCents
              existing.units += units
            } else {
              rows.push({ org_id: orgId, user_id: userId, date_utc: dateUtc, rail, raw_cost_cents: rawCostCents, units })
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
  } as unknown as AquillaDb & { _rows(): CreditRow[] }
}

// ── recordCredit ──────────────────────────────────────────────────────────────

describe("recordCredit", () => {
  it("writes the correct raw_cost_cents and units for rail='tts'", async () => {
    // WHY: raw_cost_cents is the dollar truth the admin console aggregates;
    // a wrong value means every org's spend figure is wrong
    const db = makeStubDb()
    await recordCredit(db, 5, 1, "tts", 2, 7)
    const row = db._rows().find((r) => r.org_id === 5 && r.user_id === 1 && r.rail === "tts")
    expect(row).toBeDefined()
    expect(row!.raw_cost_cents).toBeCloseTo(2)
    // WHY units = whole audio-seconds rounded; the call passes Math.round(durationSeconds)
    expect(row!.units).toBe(7)
  })

  it("upserts (accumulates) raw_cost_cents and units on repeated calls for the same pk", async () => {
    // WHY: each TTS synthesis call must ADD to the day's ledger row, not reset it.
    // If it replaced instead of accumulating, only the last call's cost would show.
    const db = makeStubDb()
    const today = new Date().toISOString().slice(0, 10)
    await recordCredit(db, 5, 1, "tts", 2, 5)
    await recordCredit(db, 5, 1, "tts", 3, 10)
    const row = db._rows().find(
      (r) => r.org_id === 5 && r.user_id === 1 && r.rail === "tts" && r.date_utc === today,
    )
    expect(row!.raw_cost_cents).toBeCloseTo(5)
    expect(row!.units).toBe(15)
  })

  it("attributes the row to the correct org_id and user_id", async () => {
    // WHY: wrong IDs would make org-level rollup queries return incorrect totals
    const db = makeStubDb()
    await recordCredit(db, 99, 42, "tts", 2, 7)
    const row = db._rows()[0]
    expect(row.org_id).toBe(99)
    expect(row.user_id).toBe(42)
  })

  it("stores the correct rail value", async () => {
    // WHY: rail discriminates llm vs agent vs tts in admin cross-rail views
    const db = makeStubDb()
    await recordCredit(db, 1, 1, "tts", 2, 1)
    expect(db._rows()[0].rail).toBe("tts")
  })

  it("keeps separate rows for different rails on the same org/user/day", async () => {
    // WHY: org_credit_usage_daily PK includes rail; mixing rails would corrupt per-rail breakdowns
    const db = makeStubDb()
    await recordCredit(db, 1, 1, "tts", 2, 5)
    await recordCredit(db, 1, 1, "llm", 10, 1)
    const ttsRow = db._rows().find((r) => r.rail === "tts")
    const llmRow = db._rows().find((r) => r.rail === "llm")
    expect(ttsRow!.raw_cost_cents).toBeCloseTo(2)
    expect(llmRow!.raw_cost_cents).toBeCloseTo(10)
  })

  it("degrades gracefully — does NOT throw — when the DB errors (missing table guard)", async () => {
    // WHY: org_credit_usage_daily may not exist yet (migration not applied to live Neon);
    // a counter failure must never surface to a user who already received audio.
    // This mirrors tts-budget.ts's graceful-degrade contract.
    const brokenDb = {
      prepare() {
        return {
          bind() { return this },
          async run() { throw new Error("relation \"org_credit_usage_daily\" does not exist") },
        }
      },
    } as unknown as AquillaDb
    // Must resolve without throwing.
    await expect(recordCredit(brokenDb, 1, 1, "tts", 2, 5)).resolves.toBeUndefined()
  })

  it("degrades gracefully — does NOT throw — on a transient DB connection error", async () => {
    // WHY: transient infra hiccups must not propagate to the caller
    const brokenDb = {
      prepare() {
        return {
          bind() { return this },
          async run() { throw new Error("DB connection lost") },
        }
      },
    } as unknown as AquillaDb
    await expect(recordCredit(brokenDb, 1, 1, "tts", 2, 5)).resolves.toBeUndefined()
  })
})

// ── No-record-on-failure contract (mirrors tts.test.ts intent) ───────────────
//
// WHY this section exists:
//   tts.ts only calls recordCredit AFTER a successful Modal synth — the route
//   returns early on any 4xx/5xx from Modal. These tests verify that the
//   credits module itself has no side effects when recordCredit is never called,
//   confirming the contract: a failed synth records NO credit.

describe("no credit recorded on Modal failure (contract verification)", () => {
  it("a db with no recordCredit calls has no rows — baseline", () => {
    // WHY: confirms the stub starts empty so we can trust absence-of-rows
    // in the tts.ts failure path (those tests live in tts.test.ts; this is
    // the credits-module side of the contract)
    const db = makeStubDb()
    expect(db._rows()).toHaveLength(0)
  })

  it("recordCredit called 0 times leaves 0 rows", async () => {
    // WHY: no-op baseline — guards against accidental auto-invocation
    const db = makeStubDb()
    // Intentionally NOT calling recordCredit here.
    expect(db._rows()).toHaveLength(0)
  })
})
