import { describe, expect, it } from "vitest"
import {
  FIELD_PLAN,
  annualizedWords,
  checkWordAllowance,
  countDistinctTargetLanes,
  countWords,
  creditsToWords,
  enterpriseCycleCredits,
  fieldAllowanceWords,
  formatAgentCredits,
  formatUsdFromCents,
  normalizeBillingPlan,
  periodAllowanceCredits,
  periodAllowanceWords,
  remainingWords,
  shouldTalkToUs,
  wordsToCredits,
} from "./plans"

describe("fieldAllowanceWords", () => {
  it("includes 100k with no add-ons — the Field Plan base", () => {
    expect(fieldAllowanceWords(0)).toBe(100_000)
  })

  it("adds 100k per purchased pack", () => {
    expect(fieldAllowanceWords(1)).toBe(200_000)
    expect(fieldAllowanceWords(3)).toBe(400_000)
  })

  it("ignores negative or fractional packs", () => {
    expect(fieldAllowanceWords(-2)).toBe(100_000)
    expect(fieldAllowanceWords(1.9)).toBe(200_000)
  })
})

describe("periodAllowanceWords", () => {
  it("gives Explore (formerly unpaid) a 10,000-word / 100-credit cycle allowance", () => {
    expect(periodAllowanceWords({ plan: "none", addonPacks: 0, hardCapWords: null })).toBe(10_000)
  })

  it("uses included + add-ons for Field", () => {
    expect(periodAllowanceWords({ plan: "field", addonPacks: 2, hardCapWords: null })).toBe(300_000)
  })

  it("adds complimentary words on top of the purchased allowance", () => {
    expect(
      periodAllowanceWords({ plan: "field", addonPacks: 0, hardCapWords: null, complimentaryWords: 50_000 }),
    ).toBe(150_000)
  })

  it("uses the configured hard cap for Enterprise, otherwise credits × languages", () => {
    expect(periodAllowanceWords({ plan: "enterprise", addonPacks: 0, hardCapWords: 5_000_000 })).toBe(5_000_000)
    expect(periodAllowanceWords({ plan: "enterprise", addonPacks: 99, hardCapWords: null, languageCount: 1 })).toBe(
      76_900,
    )
  })
})

describe("checkWordAllowance", () => {
  it("allows unpaid orgs through", () => {
    expect(checkWordAllowance(999_999, null, "none")).toEqual({ ok: true })
  })

  it("blocks Field at the purchased allowance", () => {
    expect(checkWordAllowance(100_000, 100_000, "field")).toEqual({ ok: false, reason: "allowance" })
    expect(checkWordAllowance(99_999, 100_000, "field")).toEqual({ ok: true })
  })

  it("blocks Enterprise at the hard cap", () => {
    expect(checkWordAllowance(5_000_000, 5_000_000, "enterprise")).toEqual({ ok: false, reason: "hard_cap" })
  })
})

describe("shouldTalkToUs", () => {
  it("routes a Field org past 25M words/year (the sheet's live calculator flag)", () => {
    // 2M words in a 28-day period annualizes to ~26.1M.
    expect(shouldTalkToUs({ plan: "field", periodWords: 2_000_000, periodDays: 28 })).toBe(true)
  })

  it("stays self-serve at the 10M-words/year worked example", () => {
    // 10M / (365/28) ≈ 767k words in a 4-week period.
    expect(shouldTalkToUs({ plan: "field", periodWords: 767_000, periodDays: 28 })).toBe(false)
  })

  it("never routes an Enterprise org — they already talked to us", () => {
    expect(shouldTalkToUs({ plan: "enterprise", periodWords: 9_000_000, periodDays: 28 })).toBe(false)
  })
})

describe("annualizedWords / remainingWords / countWords", () => {
  it("annualizes a 4-week window to a 365-day year", () => {
    expect(annualizedWords(100_000, 28)).toBe(1_303_571)
  })

  it("clamps remaining at zero", () => {
    expect(remainingWords(120_000, 100_000)).toBe(0)
    expect(remainingWords(40_000, 100_000)).toBe(60_000)
    expect(remainingWords(0, null)).toBeNull()
  })

  it("counts whitespace-separated words and ignores empty text", () => {
    expect(countWords("  In the beginning God created  ")).toBe(5)
    expect(countWords("")).toBe(0)
    expect(countWords("   ")).toBe(0)
  })

  it("formats the Field Plan price as dollars", () => {
    expect(formatUsdFromCents(FIELD_PLAN.priceCents)).toBe("$500")
    expect(formatUsdFromCents(FIELD_PLAN.addonPriceCents)).toBe("$200")
  })
})

describe("agent credits (APW is internal)", () => {
  it("converts at 100 agent-processed words per credit", () => {
    expect(wordsToCredits(100)).toBe(1)
    expect(wordsToCredits(1)).toBe(1)
    expect(wordsToCredits(10_000)).toBe(100)
    expect(creditsToWords(100)).toBe(10_000)
    expect(creditsToWords(1_000)).toBe(100_000)
  })

  it("retunes when the words-per-credit rate changes", () => {
    expect(wordsToCredits(10_000, 50)).toBe(200)
    expect(creditsToWords(100, 50)).toBe(5_000)
  })

  it("treats unpaid none as Explore", () => {
    expect(normalizeBillingPlan("none")).toBe("explore")
    expect(normalizeBillingPlan("explore")).toBe("explore")
  })

  it("gives Explore 100 credits per cycle and Field 1,000", () => {
    expect(periodAllowanceCredits({ plan: "none", addonPacks: 0, languageCount: 1 })).toBe(100)
    expect(periodAllowanceCredits({ plan: "explore", addonPacks: 0, languageCount: 1 })).toBe(100)
    expect(periodAllowanceCredits({ plan: "field", addonPacks: 0, languageCount: 1 })).toBe(1_000)
    expect(periodAllowanceCredits({ plan: "field", addonPacks: 1, languageCount: 1 })).toBe(2_000)
  })

  it("multiplies Enterprise by target-language lanes, 10,000 credits/year each", () => {
    expect(enterpriseCycleCredits(1)).toBe(769)
    expect(enterpriseCycleCredits(2)).toBe(1_538)
    expect(periodAllowanceCredits({ plan: "enterprise", addonPacks: 0, languageCount: 2 })).toBe(1_538)
  })

  it("lets a per-org included-credits override replace the tier formula", () => {
    expect(
      periodAllowanceCredits({
        plan: "explore",
        addonPacks: 0,
        languageCount: 1,
        includedCreditsOverride: 250,
      }),
    ).toBe(250)
    expect(
      periodAllowanceCredits({
        plan: "enterprise",
        addonPacks: 0,
        languageCount: 9,
        includedCreditsOverride: 400,
      }),
    ).toBe(400)
  })

  it("counts distinct active target-language lanes across projects", () => {
    expect(
      countDistinctTargetLanes([
        { targetLanguage: "fr", targetLanes: ["es", "pt-BR"], archivedLanes: ["es"] },
        { targetLanguage: "fr", targetLanes: ["pt-br"] },
        { targetLanguage: "", targetLanes: [] },
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

  it("formats agent credits for people, never APW", () => {
    expect(formatAgentCredits(1300)).toBe("1,300")
  })
})
