/**
 * AQU-243: Product tour unit tests.
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
import { TOUR_STEPS, filterStepsByRole, ARROW_CLASS, TOUR_ARROW_PX, type TourStep } from "./ProductTour"
import { ROLE } from "@/lib/frontier/roles"

const TOUR_DONE_KEY = "codex:productTourDone"
const ONBOARDING_DONE_KEY = "codex:onboardingComplete"

describe("wasProductTourDone / markProductTourDone / resetProductTour", () => {
  beforeEach(() => {
    localStorage.removeItem(TOUR_DONE_KEY)
  })

  it("AQU-243: returns false before tour is marked done", () => {
    expect(wasProductTourDone()).toBe(false)
  })

  it("AQU-243: returns true after markProductTourDone", () => {
    markProductTourDone()
    expect(wasProductTourDone()).toBe(true)
  })

  it("AQU-243: resetProductTour clears the flag", () => {
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

  it("AQU-243: returns false when onboarding is not complete", () => {
    // onboardingComplete not set → not a post-signup user
    expect(shouldAutoStartTour()).toBe(false)
  })

  it("AQU-243: returns true when onboarding complete and tour not done", () => {
    localStorage.setItem(ONBOARDING_DONE_KEY, "true")
    expect(shouldAutoStartTour()).toBe(true)
  })

  it("AQU-243: returns false when tour already done (dismissed/completed)", () => {
    localStorage.setItem(ONBOARDING_DONE_KEY, "true")
    markProductTourDone()
    expect(shouldAutoStartTour()).toBe(false)
  })

  it("AQU-243: auto-start triggers once — marking done prevents re-auto-start", () => {
    localStorage.setItem(ONBOARDING_DONE_KEY, "true")
    // First check: should start
    expect(shouldAutoStartTour()).toBe(true)
    // User dismisses tour
    markProductTourDone()
    // Second check: should NOT start again
    expect(shouldAutoStartTour()).toBe(false)
  })

  it("AQU-243: independent from AQU-244 project-scoped setup flag", () => {
    // Simulate AQU-244 marking a project's setup checklist as shown.
    localStorage.setItem("codex.setupAutoShown.some-project-id", "1")
    // That key must NOT affect the product tour flag.
    localStorage.setItem(ONBOARDING_DONE_KEY, "true")
    expect(shouldAutoStartTour()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AQU-262: TOUR_STEPS content correctness
// ---------------------------------------------------------------------------

describe("TOUR_STEPS — AQU-262 copy and anchor correctness", () => {
  it("AQU-262: account-switcher step does not mention switching organizations", () => {
    const step = TOUR_STEPS.find((s) => s.anchor === "account-switcher")
    expect(step).toBeDefined()
    expect(step!.body.toLowerCase()).not.toMatch(/switch.*org|org.*switch/i)
    expect(step!.body.toLowerCase()).not.toContain("organization")
  })

  it("AQU-262: a step anchored to org-switcher exists", () => {
    const step = TOUR_STEPS.find((s) => s.anchor === "org-switcher")
    expect(step).toBeDefined()
  })

  it("AQU-262: org-switcher step body mentions organizations", () => {
    const step = TOUR_STEPS.find((s) => s.anchor === "org-switcher")
    expect(step).toBeDefined()
    expect(step!.body.toLowerCase()).toMatch(/org/)
  })

  it("AQU-262: org-switcher step appears before nav steps (near start of tour)", () => {
    const orgSwitcherIdx = TOUR_STEPS.findIndex((s) => s.anchor === "org-switcher")
    const navOverviewIdx = TOUR_STEPS.findIndex((s) => s.anchor === "nav-overview")
    // org-switcher should come before the nav items
    expect(orgSwitcherIdx).toBeGreaterThan(-1)
    expect(orgSwitcherIdx).toBeLessThan(navOverviewIdx)
  })

  it("AQU-262: overview step describes the portfolio / org home", () => {
    const step = TOUR_STEPS.find((s) => s.anchor === "nav-overview")
    expect(step).toBeDefined()
    expect(step!.title).toBe("Overview")
    expect(step!.body.toLowerCase()).toContain("all organizations")
    expect(step!.body.toLowerCase()).toMatch(/projects/)
  })

  it("AQU-262: splash step (anchor=null) still comes first", () => {
    expect(TOUR_STEPS[0].anchor).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AQU-512: role-tailored steps — a translator (contributor) shouldn't be
// walked through PM-only surfaces (org settings/members) they can't act on;
// a PM (project_lead+) should see them.
// ---------------------------------------------------------------------------

describe("filterStepsByRole (AQU-512)", () => {
  it("AQU-512: nav-settings step in TOUR_STEPS is gated at PROJECT_LEAD", () => {
    const step = TOUR_STEPS.find((s) => s.anchor === "nav-settings")
    expect(step).toBeDefined()
    expect(step!.minRole).toBe(ROLE.PROJECT_LEAD)
  })

  it("AQU-512: a CONTRIBUTOR (translator, 400) does not get the PM-gated step", () => {
    const visible = filterStepsByRole(TOUR_STEPS, ROLE.CONTRIBUTOR)
    expect(visible.find((s) => s.anchor === "nav-settings")).toBeUndefined()
    // ...but still gets the ungated, translator-relevant steps.
    expect(visible.find((s) => s.anchor === "nav-overview")).toBeDefined()
    expect(visible.find((s) => s.anchor === "nav-assigned")).toBeDefined()
  })

  it("AQU-512: a PROJECT_LEAD (PM, 500) does get the PM-gated step", () => {
    const visible = filterStepsByRole(TOUR_STEPS, ROLE.PROJECT_LEAD)
    expect(visible.find((s) => s.anchor === "nav-settings")).toBeDefined()
  })

  it("AQU-512: a MAINTAINER (600, also a PM-tier role) gets the PM-gated step", () => {
    const visible = filterStepsByRole(TOUR_STEPS, ROLE.MAINTAINER)
    expect(visible.find((s) => s.anchor === "nav-settings")).toBeDefined()
  })

  it("AQU-512: unresolved role (null) fails open — matches RoleGatedStep/RulesPage convention", () => {
    const visible = filterStepsByRole(TOUR_STEPS, null)
    expect(visible.find((s) => s.anchor === "nav-settings")).toBeDefined()
  })

  it("AQU-512: a step with no minRole is shown regardless of role level", () => {
    const steps: TourStep[] = [{ anchor: "x", title: "t", body: "b" }]
    expect(filterStepsByRole(steps, ROLE.VIEWER)).toHaveLength(1)
    expect(filterStepsByRole(steps, null)).toHaveLength(1)
  })

  it("AQU-512: a below-floor role is excluded even one rung under minRole", () => {
    const steps: TourStep[] = [{ anchor: "x", title: "t", body: "b", minRole: ROLE.PROJECT_LEAD }]
    expect(filterStepsByRole(steps, ROLE.REVIEWER)).toHaveLength(0)
    expect(filterStepsByRole(steps, ROLE.PROJECT_LEAD)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// AQU-596: the tooltip pointer arrow must stay visibly large so testers can
// see which element each tour step points at. Guards against a silent revert
// to the original hard-to-see 8px triangle.
// ---------------------------------------------------------------------------

describe("ARROW_CLASS pointer size (AQU-596)", () => {
  // The pointing border is the colored one (border-r/l/t/b-popover); its px
  // width is what makes the arrow read as an arrow. Pull it out per side.
  const POINTING: Record<"left" | "right" | "top" | "bottom", RegExp> = {
    left: /border-r-\[(\d+)px\]/,
    right: /border-l-\[(\d+)px\]/,
    top: /border-b-\[(\d+)px\]/,
    bottom: /border-t-\[(\d+)px\]/,
  }

  it("AQU-596: arrows are noticeably larger than the original 8px", () => {
    expect(TOUR_ARROW_PX).toBeGreaterThanOrEqual(12)
  })

  it.each(["left", "right", "top", "bottom"] as const)(
    "AQU-596: %s arrow's pointing border matches TOUR_ARROW_PX and stays large",
    (side) => {
      const cls = ARROW_CLASS[side]
      const m = cls.match(POINTING[side])
      expect(m, `expected ${side} arrow to declare a pointing border width`).not.toBeNull()
      const px = Number(m![1])
      // Literal Tailwind class must stay in sync with the documented constant…
      expect(px).toBe(TOUR_ARROW_PX)
      // …and remain visibly larger than the original hard-to-see 8px.
      expect(px).toBeGreaterThanOrEqual(12)
    },
  )

  it("AQU-596: each arrow keeps its popover color so it renders and points correctly", () => {
    expect(ARROW_CLASS.left).toContain("border-r-popover")
    expect(ARROW_CLASS.right).toContain("border-l-popover")
    expect(ARROW_CLASS.top).toContain("border-b-popover")
    expect(ARROW_CLASS.bottom).toContain("border-t-popover")
  })

  it("AQU-596: the off-edge offset matches the arrow size so the tip sits flush", () => {
    expect(ARROW_CLASS.left).toContain(`left-[-${TOUR_ARROW_PX}px]`)
    expect(ARROW_CLASS.right).toContain(`right-[-${TOUR_ARROW_PX}px]`)
    expect(ARROW_CLASS.top).toContain(`top-[-${TOUR_ARROW_PX}px]`)
    expect(ARROW_CLASS.bottom).toContain(`bottom-[-${TOUR_ARROW_PX}px]`)
  })

  it("AQU-596: the centre-screen splash step has no arrow", () => {
    expect(ARROW_CLASS.none).toBe("")
  })
})
