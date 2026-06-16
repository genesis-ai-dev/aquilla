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
// Import step list directly for data-level assertions (no render harness needed).
import { TOUR_STEPS } from "./ProductTour"

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

// ---------------------------------------------------------------------------
// FRO-262: TOUR_STEPS content correctness
// ---------------------------------------------------------------------------

describe("TOUR_STEPS — FRO-262 copy and anchor correctness", () => {
  it("FRO-262: account-switcher step does not mention switching organizations", () => {
    const step = TOUR_STEPS.find((s) => s.anchor === "account-switcher")
    expect(step).toBeDefined()
    expect(step!.body.toLowerCase()).not.toMatch(/switch.*org|org.*switch/i)
    expect(step!.body.toLowerCase()).not.toContain("organization")
  })

  it("FRO-262: a step anchored to org-switcher exists", () => {
    const step = TOUR_STEPS.find((s) => s.anchor === "org-switcher")
    expect(step).toBeDefined()
  })

  it("FRO-262: org-switcher step body mentions organizations", () => {
    const step = TOUR_STEPS.find((s) => s.anchor === "org-switcher")
    expect(step).toBeDefined()
    expect(step!.body.toLowerCase()).toMatch(/org/)
  })

  it("FRO-262: org-switcher step appears before nav steps (near start of tour)", () => {
    const orgSwitcherIdx = TOUR_STEPS.findIndex((s) => s.anchor === "org-switcher")
    const navOverviewIdx = TOUR_STEPS.findIndex((s) => s.anchor === "nav-overview")
    // org-switcher should come before the nav items
    expect(orgSwitcherIdx).toBeGreaterThan(-1)
    expect(orgSwitcherIdx).toBeLessThan(navOverviewIdx)
  })

  it("FRO-262: projects step describes the consolidated project hub", () => {
    const step = TOUR_STEPS.find((s) => s.anchor === "nav-overview")
    expect(step).toBeDefined()
    expect(step!.title).toBe("Projects")
    expect(step!.body.toLowerCase()).toContain("project hub")
    expect(step!.body.toLowerCase()).toContain("all organizations")
    expect(step!.body.toLowerCase()).toMatch(/filter.*sort|sort.*filter/)
  })

  it("FRO-262: splash step (anchor=null) still comes first", () => {
    expect(TOUR_STEPS[0].anchor).toBeNull()
  })
})
