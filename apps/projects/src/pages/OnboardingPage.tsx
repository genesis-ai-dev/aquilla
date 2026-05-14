// Onboarding wizard — first-time user setup.
//
// Phase 3c stub. The source surface is
// src/components/onboarding/OnboardingWizard.tsx + its child steps
// (NameStep, PrivacyStep, ProjectStep, SignInStep, …). Porting the full
// wizard requires moving the brand context, useAccounts hook, and the
// posthog opt-in flow — Phase 3a / Phase 3b's domain.

import { Link } from "react-router-dom"
import { Button } from "@aquilla/ui"

export function OnboardingPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Welcome to Aquilla</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Phase 3c scaffold. The full onboarding wizard ports from
        src/components/onboarding/ once Phase 3a packages the brand context
        + useAccounts hook.
      </p>
      <div className="mt-6">
        <Link to="/">
          <Button>Skip to projects</Button>
        </Link>
      </div>
    </div>
  )
}
