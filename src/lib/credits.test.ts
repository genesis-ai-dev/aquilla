/**
 * Unit tests for the credits display-helper library.
 *
 * WHY these tests matter:
 *   - The spec defines the formula as the single source of truth for all three
 *     workers + the frontend. Any drift here means the admin console shows the
 *     wrong numbers compared to what the backend enforces.
 *   - capUsagePct must clamp — an unclamped percentage would render bars wider
 *     than 100%, which is a visible bug AND signals a budget overrun to admins.
 *   - formatCredits must never show raw $ amounts — credits are the only unit
 *     exposed to org admins (spec: "No raw provider $; credits only").
 */

import { describe, it, expect } from "vitest"
import { creditsFor, formatCredits, capUsagePct } from "./credits"
import type { CreditConfig } from "./credits"

const DEFAULT_CFG: CreditConfig = {
  markup: 4,
  agentMarkup: 5,
  dailyCap: 1000,
  weeklyCap: 5000,
  agentDailyCap: 600,
  agentWeeklyCap: 3000,
  enforce: false,
}

describe("creditsFor", () => {
  it("applies markup× for llm rail", () => {
    // 1¢ provider cost × 4× markup = 4 credits
    expect(creditsFor(1, "llm", DEFAULT_CFG)).toBe(4)
  })

  it("applies agentMarkup× for agent rail (higher than llm)", () => {
    // WHY: agent is the dangerous rail; 5× markup surfaces higher cost to admins
    expect(creditsFor(1, "agent", DEFAULT_CFG)).toBe(5)
  })

  it("applies markup× for tts rail (same as llm, not agent)", () => {
    // TTS is the cheap rail — same markup as llm, not the elevated agent rate
    expect(creditsFor(1, "tts", DEFAULT_CFG)).toBe(4)
  })

  it("ceils fractional results (never rounds down)", () => {
    // WHY: Math.ceil ensures the org is never undercharged in display. Spec
    // says "credits = ceil(rawCents × markup)".
    expect(creditsFor(0.3, "llm", DEFAULT_CFG)).toBe(2) // 0.3 × 4 = 1.2 → ceil = 2
    expect(creditsFor(0.1, "agent", DEFAULT_CFG)).toBe(1) // 0.1 × 5 = 0.5 → ceil = 1
  })

  it("returns 0 for zero raw cost", () => {
    expect(creditsFor(0, "llm", DEFAULT_CFG)).toBe(0)
    expect(creditsFor(0, "agent", DEFAULT_CFG)).toBe(0)
  })

  it("uses custom markup values from config", () => {
    const cfg = { markup: 3, agentMarkup: 6 }
    expect(creditsFor(2, "llm", cfg)).toBe(6) // 2 × 3
    expect(creditsFor(2, "agent", cfg)).toBe(12) // 2 × 6
  })
})

describe("formatCredits", () => {
  it("formats zero", () => {
    expect(formatCredits(0)).toBe("0 cr")
  })

  it("formats small values", () => {
    expect(formatCredits(42)).toBe("42 cr")
  })

  it("formats large values with thousand separators", () => {
    // The exact separator is locale-dependent; we check the numeric parts
    const result = formatCredits(1500)
    expect(result).toContain("1")
    expect(result).toContain("500")
    expect(result).toMatch(/cr$/)
  })

  it("rounds floats (credits are display-integer)", () => {
    expect(formatCredits(4.7)).toBe("5 cr")
    expect(formatCredits(4.2)).toBe("4 cr")
  })

  it("never shows $ or 'cent' — credits only (not provider cost)", () => {
    // WHY: spec is explicit — "No raw provider $; credits only"
    const result = formatCredits(1000)
    expect(result).not.toContain("$")
    expect(result).not.toContain("cent")
    expect(result).not.toContain("dollar")
  })

  it("never renders 'NaN cr' for non-finite input (AQU-671)", () => {
    // WHY: a missing/not-yet-loaded/malformed agentCredits value used to reach
    // Math.round(NaN) → "NaN cr" on the CreditsDial. Non-finite input must
    // degrade to 0, never leak "NaN" into the UI.
    expect(formatCredits(NaN)).toBe("0 cr")
    expect(formatCredits(undefined as unknown as number)).toBe("0 cr")
    expect(formatCredits(Infinity)).toBe("0 cr")
    expect(formatCredits(-Infinity)).toBe("0 cr")
    expect(formatCredits(NaN)).not.toContain("NaN")
  })
})

describe("capUsagePct", () => {
  it("returns 0% when used is 0", () => {
    expect(capUsagePct(0, 1000)).toBe(0)
  })

  it("returns 50% at half the cap", () => {
    expect(capUsagePct(500, 1000)).toBe(50)
  })

  it("returns 100% at the cap exactly", () => {
    expect(capUsagePct(1000, 1000)).toBe(100)
  })

  it("clamps to 100% when over cap (enforce=false lets budgets exceed cap)", () => {
    // WHY: when enforce=false, spend can exceed cap. The bar must not render
    // >100% wide. This is the clamping invariant — critical for visual correctness.
    expect(capUsagePct(1500, 1000)).toBe(100)
  })

  it("returns 0% when cap is 0 (unconfigured)", () => {
    // WHY: division by zero guard — a cap of 0 means disabled/unconfigured.
    expect(capUsagePct(100, 0)).toBe(0)
  })

  it("returns 0% for negative cap", () => {
    expect(capUsagePct(100, -1)).toBe(0)
  })

  it("never returns a negative percentage", () => {
    expect(capUsagePct(-50, 1000)).toBe(0)
  })

  it("returns 0% for non-finite used (AQU-671 — keeps the ring dasharray finite)", () => {
    // WHY: the CreditsDial derives its ring strokeDasharray from this pct. A
    // NaN/undefined spend must not propagate into an invalid SVG dasharray.
    expect(capUsagePct(NaN, 1000)).toBe(0)
    expect(capUsagePct(undefined as unknown as number, 1000)).toBe(0)
    expect(capUsagePct(Infinity, 1000)).toBe(0)
  })
})
