// AQU-2068: which state the meter is in. Why these tests matter: the state
// decides whether AI actions stop, so an off-by-one at 80/100%, a fake 0% on
// a ledger outage, or a metered bar on an Enterprise org is a real billing
// bug, not a cosmetic one.
import { describe, expect, it } from "vitest"
import { meterView, type AiMeterData } from "./ai-meter"

const free = (percentUsed: number | null): AiMeterData =>
  ({ orgId: 1, plan: "free", mode: "metered", percentUsed, resetsAt: "2026-10-26T00:00:00Z" })

describe("meterView", () => {
  it("is quiet below 80%, warns from 80%, and stops AI only at 100%", () => {
    expect(meterView(free(79))).toMatchObject({ kind: "metered", level: "ok", percent: 79 })
    expect(meterView(free(80))).toMatchObject({ level: "warning" })
    expect(meterView(free(99))).toMatchObject({ level: "warning" })
    expect(meterView(free(100))).toMatchObject({ level: "exhausted" })
  })

  it("clamps an in-flight overrun (≤105%) to a full bar, not a broken one", () => {
    expect(meterView(free(104))).toMatchObject({ percent: 100, level: "exhausted" })
  })

  it("never turns a failed ledger read into 0%", () => {
    // 0% would tell a Free org it has a full week left while AI is refused.
    expect(meterView(free(null))).toEqual({ kind: "unavailable" })
    expect(meterView(null)).toEqual({ kind: "unavailable" })
    expect(meterView(undefined)).toEqual({ kind: "loading" })
  })

  it("shows Enterprise as Unlimited, even with its own key", () => {
    expect(meterView({ orgId: 1, plan: "enterprise", mode: "unmetered", percentUsed: null, resetsAt: null })).toEqual({ kind: "unlimited" })
    expect(meterView({ orgId: 1, plan: "enterprise", mode: "byok", percentUsed: null, resetsAt: null })).toEqual({ kind: "unlimited" })
  })

  it("greys out a BYOK org instead of counting it", () => {
    expect(meterView({ orgId: 1, plan: "team", mode: "byok", percentUsed: 97, resetsAt: null })).toEqual({ kind: "byok" })
  })
})
