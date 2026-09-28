import { describe, expect, it } from "vitest"
import { subscriptionFromStripeObject } from "../lib/billing/apply"
import {
  FIELD_PLAN,
  checkWordAllowance,
  countDistinctTargetLanes,
  countWords,
  creditsToWords,
  enterpriseCycleCredits,
  fieldAllowanceWords,
  normalizeBillingPlan,
  periodAllowanceCredits,
  periodAllowanceWords,
  shouldTalkToUs,
  wordsToCredits,
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

  it("gives Explore a 10,000-word cycle allowance and still allows unpaid math through a null cap", () => {
    expect(periodAllowanceWords({ plan: "none", addonPacks: 0, hardCapWords: null })).toBe(10_000)
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

describe("agent credits (APW is internal)", () => {
  it("converts at 100 agent-processed words per credit", () => {
    expect(wordsToCredits(100)).toBe(1)
    expect(wordsToCredits(10_000)).toBe(100)
    expect(creditsToWords(1_000)).toBe(100_000)
  })

  it("gives Explore 100 credits/cycle, Field 1,000, Enterprise 769 per language", () => {
    expect(normalizeBillingPlan("none")).toBe("explore")
    expect(periodAllowanceCredits({ plan: "explore", addonPacks: 0, languageCount: 1 })).toBe(100)
    expect(periodAllowanceCredits({ plan: "field", addonPacks: 1, languageCount: 1 })).toBe(2_000)
    expect(enterpriseCycleCredits(1)).toBe(769)
    expect(periodAllowanceCredits({ plan: "enterprise", addonPacks: 0, languageCount: 2 })).toBe(1_538)
  })

  it("honors a per-org included-credits override", () => {
    expect(
      periodAllowanceCredits({
        plan: "field",
        addonPacks: 0,
        languageCount: 1,
        includedCreditsOverride: 50,
      }),
    ).toBe(50)
  })

  it("counts distinct active target-language lanes", () => {
    expect(
      countDistinctTargetLanes([
        { targetLanguage: "fr", targetLanes: ["es"], archivedLanes: ["es"] },
        { targetLanguage: "fr", targetLanes: ["pt"] },
      ]),
    ).toBe(2)
  })

  it("does not double-count when the primary appears in both targetLanguage and targetLanes", () => {
    // AQU-1240 slice 1: the complete registry lists the primary in targetLanes
    // as well as targetLanguage. Billing must stay invoice-neutral via Set-dedupe.
    expect(
      countDistinctTargetLanes([
        { targetLanguage: "French", targetLanes: ["French", "es"] },
      ]),
    ).toBe(2)
    expect(
      countDistinctTargetLanes([
        { targetLanguage: "fr", targetLanes: ["FR", "es"] },
      ]),
    ).toBe(2)
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
