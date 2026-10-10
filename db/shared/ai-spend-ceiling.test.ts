// Unit tests for the platform AI spend ceiling — AQU-1869.
//
// Each test states WHY the behaviour matters: this module is the one control
// on the shared vendor keys that reads dollars, and every other guard around it
// is log-only in deployed environments, so a wrong default or a silently
// swallowed configuration value here is an open budget.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { AquillaDb } from "../shim/postgres"
import {
  AI_SPEND_CEILING_ERROR,
  DEFAULT_AI_DAILY_SPEND_CEILING_USD,
  __resetAiSpendCeilingStateForTests,
  checkAiSpendCeiling,
  isOverAiSpendCeiling,
  resolveAiSpendCeilingUsd,
  utcDayKey,
} from "./ai-spend-ceiling"

/** Minimal AquillaDb stand-in: one row back from one `first()`. */
function stubDb(row: unknown, onQuery?: (sql: string, binds: unknown[]) => void): AquillaDb {
  return {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          onQuery?.(sql, binds)
          return { first: async () => row }
        },
      }
    },
  } as unknown as AquillaDb
}

function throwingDb(): AquillaDb {
  return {
    prepare() {
      return {
        bind() {
          return {
            first: async () => {
              throw new Error('relation "org_credit_usage_daily" does not exist')
            },
          }
        },
      }
    },
  } as unknown as AquillaDb
}

beforeEach(() => {
  __resetAiSpendCeilingStateForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("resolveAiSpendCeilingUsd", () => {
  it("defaults to a finite ceiling when nothing configures one", () => {
    // An unset variable in a new environment must not mean "unlimited", or the
    // protection would exist only where someone remembered to switch it on.
    expect(resolveAiSpendCeilingUsd(undefined)).toBe(DEFAULT_AI_DAILY_SPEND_CEILING_USD)
    expect(resolveAiSpendCeilingUsd("  ")).toBe(DEFAULT_AI_DAILY_SPEND_CEILING_USD)
  })

  it("reads a dollar amount from the env var, including fractional cents", () => {
    // The ticket's own test checklist sets the ceiling to $0.01 on dev.
    expect(resolveAiSpendCeilingUsd("0.01")).toBe(0.01)
    expect(resolveAiSpendCeilingUsd("250")).toBe(250)
  })

  it("treats 0 as a real ceiling, not as 'off'", () => {
    // Zero is the panic position — no paid AI at all. Reading it as "off"
    // would turn the strongest setting into the weakest one.
    expect(resolveAiSpendCeilingUsd("0")).toBe(0)
  })

  it("switches off on an explicit sentinel or a negative number", () => {
    expect(resolveAiSpendCeilingUsd("off")).toBeNull()
    expect(resolveAiSpendCeilingUsd("None")).toBeNull()
    expect(resolveAiSpendCeilingUsd("unlimited")).toBeNull()
    // A misconfigured -1 degrades to today's behaviour rather than blocking
    // every AI feature in the product.
    expect(resolveAiSpendCeilingUsd("-1")).toBeNull()
  })

  it("falls back to the default (loudly) on an unparseable value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(resolveAiSpendCeilingUsd("five dollars")).toBe(DEFAULT_AI_DAILY_SPEND_CEILING_USD)
    expect(warn).toHaveBeenCalledOnce()
  })

  it("lets the admin-set platform setting win over the env var", () => {
    expect(resolveAiSpendCeilingUsd("500", 25)).toBe(25)
    expect(resolveAiSpendCeilingUsd("500", 0)).toBe(0)
    expect(resolveAiSpendCeilingUsd("500", -1)).toBeNull()
    // A non-finite stored value must not shadow a usable env var.
    expect(resolveAiSpendCeilingUsd("500", Number.NaN)).toBe(500)
  })
})

describe("isOverAiSpendCeiling", () => {
  const day = "2026-10-10"

  it("blocks at the ceiling, not only past it", () => {
    // Matches checkCredits' own >= semantics, so the two guards don't disagree
    // about what "the cap is reached" means.
    expect(isOverAiSpendCeiling({ spendCents: 100, ceilingUsd: 1, day })).toBe(true)
    expect(isOverAiSpendCeiling({ spendCents: 99, ceilingUsd: 1, day })).toBe(false)
  })

  it("never blocks when the ceiling is switched off", () => {
    expect(isOverAiSpendCeiling({ spendCents: 9_999_999, ceilingUsd: null, day })).toBe(false)
  })

  it("blocks every paid call at a $0 ceiling", () => {
    expect(isOverAiSpendCeiling({ spendCents: 0, ceilingUsd: 0, day })).toBe(true)
  })
})

describe("checkAiSpendCeiling", () => {
  const env = { AI_DAILY_SPEND_CEILING_USD: "1", ENVIRONMENT: "test" }

  it("refuses the call with a 503 and a plain-language message once the ceiling is reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const outcome = await checkAiSpendCeiling(
      stubDb({ spend_cents: 150, platform_settings: null }),
      env,
      "chat",
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.status).toBe(503)
    expect(outcome.body.error).toBe(AI_SPEND_CEILING_ERROR)
    // The copy must read as a platform pause, not as the user's own quota.
    expect(outcome.body.message).toContain("AI is temporarily unavailable")
    expect(outcome.body.message).toContain("midnight UTC")
  })

  it("lets the call through below the ceiling", async () => {
    const outcome = await checkAiSpendCeiling(
      stubDb({ spend_cents: 50, platform_settings: null }),
      env,
      "chat",
    )
    expect(outcome.ok).toBe(true)
  })

  it("sums only the current UTC day, so the ceiling resets at the day boundary", async () => {
    let bound: unknown[] = []
    await checkAiSpendCeiling(
      stubDb({ spend_cents: 0, platform_settings: null }, (_sql, binds) => {
        bound = binds
      }),
      env,
      "chat",
    )
    expect(bound).toEqual([utcDayKey()])
  })

  it("honours an admin-lowered ceiling stored in platform_settings", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    // $5 env ceiling, admin drops it to 1¢: the stored value decides. This is
    // the path that makes sync-worker's TTS/voice paths obey the admin console.
    const outcome = await checkAiSpendCeiling(
      stubDb({
        spend_cents: 20,
        platform_settings: JSON.stringify({ aiDailySpendCeilingUsd: 0.01 }),
      }),
      { AI_DAILY_SPEND_CEILING_USD: "5", ENVIRONMENT: "test" },
      "tts",
    )
    expect(outcome.ok).toBe(false)
  })

  it("alerts once per UTC day, not once per refused request", async () => {
    // The whole point of the alert is that it is findable. One line per blocked
    // request would bury the signal inside the flood it is reporting.
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const db = stubDb({ spend_cents: 10_000, platform_settings: null })
    for (let i = 0; i < 5; i++) await checkAiSpendCeiling(db, env, "chat")
    const alerts = error.mock.calls.filter((call) => String(call[0]).includes("ALERT"))
    expect(alerts).toHaveLength(1)
    expect(String(alerts[0][0])).toContain("[ai-spend-ceiling]")
  })

  it("fails open with an error log when the ledger cannot be read", async () => {
    // A Postgres blip must not take every AI feature in the product down; the
    // operator still gets a logged error. (AQU-1843 revisits fail-closed.)
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const outcome = await checkAiSpendCeiling(throwingDb(), env, "chat")
    expect(outcome.ok).toBe(true)
    expect(error).toHaveBeenCalledOnce()
  })

  it("passes through when the worker has no database handle", async () => {
    // voice-convert and diarization are reachable in environments with no
    // Postgres binding; the ceiling must not become a 503 for all of them.
    expect((await checkAiSpendCeiling(undefined, env, "voice-convert")).ok).toBe(true)
  })
})
