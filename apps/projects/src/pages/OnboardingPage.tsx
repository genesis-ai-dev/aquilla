// First-time onboarding wizard.
//
// The full wizard (NameStep / PrivacyStep / ProjectStep / SignInStep /
// posthog opt-in) is deferred until the workspace SPA's brand context +
// useAccounts hook are extracted into shared packages — see
// src/components/onboarding/OnboardingWizard.tsx for the source surface.
//
// Until then, the route just bounces to the project list. Surfacing a
// half-finished placeholder confuses real users more than no route at
// all; the hard navigation also clears any stale wizard URL the user
// might have bookmarked.

import { Navigate } from "react-router-dom"

export function OnboardingPage() {
  return <Navigate to="/" replace />
}
