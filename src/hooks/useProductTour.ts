/**
 * AQU-243: Product tour persistence logic.
 *
 * Persistence key: `aquilla:productTourDone` (localStorage "1").
 * Auto-start condition: onboarding wizard completed (`aquilla:productTourEligible`)
 * AND tour not yet done. This fires once per browser profile, user-wide (not
 * per-project like AQU-244's setup checklist flag).
 *
 * The hook is pure — no React state, so it can be called deterministically in
 * tests without a render cycle.
 */

import {
  ONBOARDING_COMPLETE_KEY,
  PRODUCT_TOUR_ELIGIBLE_KEY,
} from "@/lib/onboarding/completion"

const TOUR_DONE_KEY = "aquilla:productTourDone"

export function wasProductTourDone(): boolean {
  try {
    return localStorage.getItem(TOUR_DONE_KEY) === "1"
  } catch {
    return false
  }
}

export function markProductTourDone(): void {
  try {
    localStorage.setItem(TOUR_DONE_KEY, "1")
  } catch {
    /* ignore quota/private-browsing errors */
  }
}

export function resetProductTour(): void {
  try {
    localStorage.removeItem(TOUR_DONE_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Returns true when the tour should auto-start: the account-creation wizard
 * was completed and the tour hasn't been shown/dismissed yet.
 *
 * Intentionally NOT gated on a React effect so callers can read this
 * synchronously at first render (avoids a "flash then start" cycle).
 */
export function shouldAutoStartTour(): boolean {
  try {
    // The old local-only key remains a backward-compatible eligibility signal
    // for profiles that completed onboarding before the dedicated key existed.
    const onboardingDone =
      localStorage.getItem(PRODUCT_TOUR_ELIGIBLE_KEY) === "true" ||
      localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true"
    return onboardingDone && !wasProductTourDone()
  } catch {
    return false
  }
}
