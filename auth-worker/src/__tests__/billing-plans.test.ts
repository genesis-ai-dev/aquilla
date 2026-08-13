import { describe, expect, it } from "vitest"
import { subscriptionFromStripeObject } from "../lib/billing/apply"
import {
  FIELD_PLAN,
  checkWordAllowance,
  countWords,
  fieldAllowanceWords,
  periodAllowanceWords,
  shouldTalkToUs,
} from "../lib/billing/plans"

describe("Field Plan math", () => {
  it("prices the base period at $500 / 100k words", () => {
    expect(FIELD_PLAN.priceCents).toBe(50_000)
    expect(fieldAllowanceWords(0)).toBe(100_000)
  })

  it("adds $200 / 100k-word packs inside a period", () => {
    expect(FIELD_PLAN.addonPriceCents).toBe(20_000)
    expect(fieldAllowanceWords(1)).toBe(200_000)
  })

  it("does not cap unpaid orgs", () => {
    expect(periodAllowanceWords({ plan: "none", addonPacks: 0, hardCapWords: null })).toBeNull()
    expect(checkWordAllowance(9_999_999, null, "none").ok).toBe(true)
  })

  it("blocks Field at the purchased allowance and Enterprise at the hard cap", () => {
    expect(checkWordAllowance(100_000, 100_000, "field")).toEqual({ ok: false, reason: "allowance" })
    expect(checkWordAllowance(1_000_000, 1_000_000, "enterprise")).toEqual({ ok: false, reason: "hard_cap" })
  })

  it("routes past 25M words/year to talk-to-us", () => {
    expect(shouldTalkToUs({ plan: "field", periodWords: 2_000_000, periodDays: 28 })).toBe(true)
    expect(shouldTalkToUs({ plan: "field", periodWords: 767_000, periodDays: 28 })).toBe(false)
  })

  it("counts words in source text", () => {
    expect(countWords("In the beginning God created the heavens")).toBe(7)
  })
})

describe("subscriptionFromStripeObject", () => {
  it("reads period timestamps from the first item when the subscription root omits them", () => {
    const sub = subscriptionFromStripeObject({
      id: "sub_new",
      customer: "cus_new",
      status: "active",
      items: {
        data: [{ current_period_start: 1_700_000_000, current_period_end: 1_700_000_000 + 28 * 86400 }],
      },
    })
    expect(sub.currentPeriodStart).toBe(new Date(1_700_000_000 * 1000).toISOString())
    expect(sub.currentPeriodEnd).toBe(new Date((1_700_000_000 + 28 * 86400) * 1000).toISOString())
  })
})
