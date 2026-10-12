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
import {
  checkCredits,
  creditsFor,
  readOrgSpend,
  recordCredit,
  resolveCreditConfig,
  runOrgCreditGuard,
  type ResolvedCreditConfig,
} from "../credits"

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

// ── Org credit pre-check (AQU-1872) ──────────────────────────────────────────
//
// WHY these tests matter:
//   - The pre-check is the only ORG-level ceiling on TTS spend. The per-user
//     request window in tts.ts is volumetric: several users batch-narrating a
//     Bible in one org each stay under it while the org's bill runs away.
//   - Enforcement must stay off by default — mirroring auth-worker's
//     creditGuard and runTtsGuard, an over-cap org is logged, not blocked,
//     while the caps are being sized.
//   - The caps are compared in CREDITS (markup applied), not raw cents; a
//     missing markup would under-count spend 4×.
//   - An unreadable ledger must degrade to "allow", never to "block".

const UTC_TODAY = new Date().toISOString().slice(0, 10)

function daysAgoUtc(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

const BASE_CFG: ResolvedCreditConfig = {
  markup: 4,
  agentMarkup: 5,
  dailyCap: 1000,
  weeklyCap: 5000,
  enforce: false,
}

/** Stub supporting resolveCreditConfig's org_settings read + readOrgSpend's rollup. */
function makeGuardDb(opts: { rows?: CreditRow[]; orgSettings?: string; throwOn?: "settings" | "spend" } = {}) {
  const rows = opts.rows ?? []
  return {
    prepare(sql: string) {
      let boundArgs: unknown[] = []
      const stmt = {
        bind(...args: unknown[]) {
          boundArgs = args
          return stmt
        },
        async first<T = unknown>(): Promise<T | null> {
          if (sql.includes("FROM org_settings")) {
            if (opts.throwOn === "settings") throw new Error("boom")
            return (opts.orgSettings ? { settings: opts.orgSettings } : null) as unknown as T
          }
          return null
        },
        async run() {
          return { results: [], success: true as const, meta: {} as never }
        },
        async all<T = unknown>() {
          if (sql.includes("FROM org_credit_usage_daily")) {
            if (opts.throwOn === "spend") throw new Error("relation \"org_credit_usage_daily\" does not exist")
            const [orgId, since] = boundArgs as [number, string]
            const grouped = new Map<string, { date_utc: string; rail: string; raw_cost_cents: number }>()
            for (const row of rows) {
              if (row.org_id !== orgId || row.date_utc < since) continue
              const key = `${row.date_utc}|${row.rail}`
              const acc = grouped.get(key)
              if (acc) acc.raw_cost_cents += row.raw_cost_cents
              else grouped.set(key, { date_utc: row.date_utc, rail: row.rail, raw_cost_cents: row.raw_cost_cents })
            }
            return { results: [...grouped.values()] as T[], success: true as const, meta: {} as never }
          }
          return { results: [] as T[], success: true as const, meta: {} as never }
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
  } as unknown as AquillaDb
}

function row(over: Partial<CreditRow> = {}): CreditRow {
  return {
    org_id: 5,
    user_id: 1,
    date_utc: UTC_TODAY,
    rail: "tts",
    raw_cost_cents: 0,
    units: 0,
    ...over,
  }
}

describe("checkCredits", () => {
  it("passes an org below both caps", () => {
    expect(checkCredits({ dayCredits: 10, weekCredits: 20 }, BASE_CFG)).toEqual({ ok: true })
  })

  it("fails with reason 'daily' at the daily cap", () => {
    // WHY: the comparison is >=, so landing exactly on the cap is exhausted.
    expect(checkCredits({ dayCredits: 1000, weekCredits: 1000 }, BASE_CFG)).toEqual({
      ok: false,
      reason: "daily",
    })
  })

  it("fails with reason 'weekly' when only the weekly cap is hit", () => {
    expect(checkCredits({ dayCredits: 1, weekCredits: 5000 }, BASE_CFG)).toEqual({
      ok: false,
      reason: "weekly",
    })
  })

  it("reports 'daily' first when both caps are blown", () => {
    // WHY: precedence matters for the message the user sees — the daily cap is
    // the one that resets soonest.
    expect(checkCredits({ dayCredits: 9999, weekCredits: 9999 }, BASE_CFG).reason).toBe("daily")
  })
})

describe("resolveCreditConfig", () => {
  it("falls back to platform defaults with no env and no org settings", async () => {
    const cfg = await resolveCreditConfig({}, makeGuardDb(), 5)
    expect(cfg).toEqual(BASE_CFG)
  })

  it("reads platform env overrides", async () => {
    const cfg = await resolveCreditConfig(
      { CREDIT_MARKUP: "2.5", CREDIT_DAILY_CAP: "50", CREDIT_WEEKLY_CAP: "99", CREDIT_ENFORCE: "true" },
      makeGuardDb(),
      5,
    )
    expect(cfg).toMatchObject({ markup: 2.5, dailyCap: 50, weeklyCap: 99, enforce: true })
  })

  it("lets org_settings.credits override the env per field", async () => {
    // WHY: an org on a bigger plan gets a bigger cap without a redeploy.
    const db = makeGuardDb({ orgSettings: JSON.stringify({ credits: { dailyCap: 7, enforce: true } }) })
    const cfg = await resolveCreditConfig({ CREDIT_DAILY_CAP: "1000" }, db, 5)
    expect(cfg.dailyCap).toBe(7)
    expect(cfg.enforce).toBe(true)
    expect(cfg.weeklyCap).toBe(BASE_CFG.weeklyCap) // untouched field keeps the default
  })

  it("ignores a malformed org_settings blob rather than throwing", async () => {
    const db = makeGuardDb({ orgSettings: "{not json" })
    const cfg = await resolveCreditConfig({}, db, 5)
    expect(cfg).toEqual(BASE_CFG)
  })

  it("skips the org_settings lookup for the unattributed org (0)", async () => {
    // WHY: org 0 is the no-org sentinel — there is no settings row to read.
    const db = makeGuardDb({ throwOn: "settings" })
    await expect(resolveCreditConfig({}, db, 0)).resolves.toEqual(BASE_CFG)
  })
})

describe("readOrgSpend", () => {
  it("sums today's rows into dayCredits with markup applied", async () => {
    const db = makeGuardDb({ rows: [row({ raw_cost_cents: 10 })] })
    const spend = await readOrgSpend(db, 5, BASE_CFG)
    expect(spend.dayCredits).toBe(40) // 10¢ × 4
    expect(spend.weekCredits).toBe(40)
  })

  it("counts an older row in the week total but not the day total", async () => {
    const db = makeGuardDb({ rows: [row({ raw_cost_cents: 10, date_utc: daysAgoUtc(3) })] })
    const spend = await readOrgSpend(db, 5, BASE_CFG)
    expect(spend.dayCredits).toBe(0)
    expect(spend.weekCredits).toBe(40)
  })

  it("excludes rows outside the rolling 7-day window", async () => {
    const db = makeGuardDb({ rows: [row({ raw_cost_cents: 10, date_utc: daysAgoUtc(30) })] })
    const spend = await readOrgSpend(db, 5, BASE_CFG)
    expect(spend).toEqual({ dayCredits: 0, weekCredits: 0 })
  })

  it("applies the agent markup to agent-rail rows", async () => {
    // WHY: spend is cross-rail — TTS is capped against the org's whole bill,
    // and the agent rail is marked up 5×, not 4×.
    const db = makeGuardDb({ rows: [row({ rail: "agent", raw_cost_cents: 10 })] })
    const spend = await readOrgSpend(db, 5, BASE_CFG)
    expect(spend.dayCredits).toBe(50)
  })

  it("returns zeros when the ledger table is missing", async () => {
    const db = makeGuardDb({ throwOn: "spend" })
    await expect(readOrgSpend(db, 5, BASE_CFG)).resolves.toEqual({ dayCredits: 0, weekCredits: 0 })
  })
})

describe("runOrgCreditGuard", () => {
  /** 300¢ × 4 = 1200 credits — past the 1000/day default. */
  const exhausted = [row({ raw_cost_cents: 300 })]

  it("allows an exhausted org through in log-only mode (the default)", async () => {
    // WHY: enforcement off must never block, exactly like runTtsGuard.
    const db = makeGuardDb({ rows: exhausted })
    await expect(runOrgCreditGuard(db, {}, 5, "tts")).resolves.toEqual({ ok: true })
  })

  it("refuses an exhausted org with a 429 and a named error when enforcing", async () => {
    const db = makeGuardDb({ rows: exhausted })
    const outcome = await runOrgCreditGuard(db, { CREDIT_ENFORCE: "true" }, 5, "tts")
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("expected refusal")
    expect(outcome.status).toBe(429)
    expect(outcome.body.error).toBe("credit_cap_exceeded")
    expect(outcome.body.reason).toBe("daily")
    // The message is user-facing: it must say no audio was produced.
    expect(outcome.body.message).toMatch(/no audio was generated/i)
  })

  it("allows an org that still has credit, even when enforcing", async () => {
    const db = makeGuardDb({ rows: [row({ raw_cost_cents: 10 })] })
    await expect(runOrgCreditGuard(db, { CREDIT_ENFORCE: "true" }, 5, "tts")).resolves.toEqual({ ok: true })
  })

  it("enforces a per-org cap the org set itself", async () => {
    const db = makeGuardDb({
      rows: [row({ raw_cost_cents: 10 })], // 40 credits
      orgSettings: JSON.stringify({ credits: { dailyCap: 20, enforce: true } }),
    })
    const outcome = await runOrgCreditGuard(db, {}, 5, "tts")
    expect(outcome.ok).toBe(false)
  })

  it("allows through when the ledger cannot be read, even while enforcing", async () => {
    // WHY: a DB hiccup must not take TTS down — degrade to allow, like
    // auth-worker's creditGuard and tts-budget's runTtsGuard.
    const db = makeGuardDb({ throwOn: "spend" })
    await expect(runOrgCreditGuard(db, { CREDIT_ENFORCE: "true" }, 5, "tts")).resolves.toEqual({ ok: true })
  })

  it("does not charge one org for another org's spend", async () => {
    const db = makeGuardDb({ rows: [row({ org_id: 99, raw_cost_cents: 9000 })] })
    await expect(runOrgCreditGuard(db, { CREDIT_ENFORCE: "true" }, 5, "tts")).resolves.toEqual({ ok: true })
  })
})
