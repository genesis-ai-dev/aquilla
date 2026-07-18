/**
 * AQU-243: Product tour persistence logic.
 *
 * Persistence key: `codex:productTourDone` (localStorage "1").
 * Auto-start condition: onboarding wizard completed (`codex:onboardingComplete`)
 * AND tour not yet done. This fires once per browser profile, user-wide (not
 * per-project like AQU-244's setup checklist flag).
 *
 * The hook is pure — no React state, so it can be called deterministically in
 * tests without a render cycle.
 */

const TOUR_DONE_KEY = "codex:productTourDone"
const ONBOARDING_DONE_KEY = "codex:onboardingComplete"

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
    const onboardingDone = localStorage.getItem(ONBOARDING_DONE_KEY) === "true"
    return onboardingDone && !wasProductTourDone()
  } catch {
    return false
  }
}
