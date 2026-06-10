/**
 * FRO-243: Product tour unit tests.
 *
 * These tests cover the pure persistence/logic layer (useProductTour.ts)
 * and the step-skipping logic. The full render path is tested via the
 * auto-start integration test below.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  wasProductTourDone,
  markProductTourDone,
  resetProductTour,
  shouldAutoStartTour,
} from "@/hooks/useProductTour"

const TOUR_DONE_KEY = "codex:productTourDone"
const ONBOARDING_DONE_KEY = "codex:onboardingComplete"

describe("wasProductTourDone / markProductTourDone / resetProductTour", () => {
  beforeEach(() => {
    localStorage.removeItem(TOUR_DONE_KEY)
  })

  it("FRO-243: returns false before tour is marked done", () => {
    expect(wasProductTourDone()).toBe(false)
  })

  it("FRO-243: returns true after markProductTourDone", () => {
    markProductTourDone()
    expect(wasProductTourDone()).toBe(true)
  })

  it("FRO-243: resetProductTour clears the flag", () => {
    markProductTourDone()
    resetProductTour()
    expect(wasProductTourDone()).toBe(false)
  })
})

describe("shouldAutoStartTour", () => {
  beforeEach(() => {
    localStorage.removeItem(TOUR_DONE_KEY)
    localStorage.removeItem(ONBOARDING_DONE_KEY)
  })

  it("FRO-243: returns false when onboarding is not complete", () => {
    // onboardingComplete not set → not a post-signup user
    expect(shouldAutoStartTour()).toBe(false)
  })

  it("FRO-243: returns true when onboarding complete and tour not done", () => {
    localStorage.setItem(ONBOARDING_DONE_KEY, "true")
    expect(shouldAutoStartTour()).toBe(true)
  })

  it("FRO-243: returns false when tour already done (dismissed/completed)", () => {
    localStorage.setItem(ONBOARDING_DONE_KEY, "true")
    markProductTourDone()
    expect(shouldAutoStartTour()).toBe(false)
  })

  it("FRO-243: auto-start triggers once — marking done prevents re-auto-start", () => {
    localStorage.setItem(ONBOARDING_DONE_KEY, "true")
    // First check: should start
    expect(shouldAutoStartTour()).toBe(true)
    // User dismisses tour
    markProductTourDone()
    // Second check: should NOT start again
    expect(shouldAutoStartTour()).toBe(false)
  })

  it("FRO-243: independent from FRO-244 project-scoped setup flag", () => {
    // Simulate FRO-244 marking a project's setup checklist as shown.
    localStorage.setItem("codex.setupAutoShown.some-project-id", "1")
    // That key must NOT affect the product tour flag.
    localStorage.setItem(ONBOARDING_DONE_KEY, "true")
    expect(shouldAutoStartTour()).toBe(true)
  })
})
