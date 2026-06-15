import { useState, useCallback, useEffect, useRef } from "react"
import { useNavigate } from "react-router-dom"
import type { ProjectRecord } from "@/lib/parsers/types"
import { hasAnalyticsConsentBeenSet } from "@/lib/analytics-consent"
import { useActiveOrg } from "@/context/OrgContext"
import { WelcomeStep } from "./steps/WelcomeStep"
import { PrivacyStep } from "./steps/PrivacyStep"
import { SignInStep } from "./steps/SignInStep"
import { NameStep } from "./steps/NameStep"
import { ProjectStep } from "./steps/ProjectStep"
import { ReadyStep } from "./steps/ReadyStep"
import posthog from "@/lib/posthog"
import {
  ONBOARDING_STEP_VIEWED,
  ONBOARDING_RETURNING_USER_SKIP,
} from "@/lib/analytics-events"

// Human-readable label for each wizard step number.
const STEP_LABELS: Record<number, string> = {
  1: "welcome",
  2: "privacy",
  3: "sign-in",
  4: "name",
  5: "project",
  6: "ready",
}

const TOTAL_STEPS = 6

export function OnboardingWizard() {
  const navigate = useNavigate()
  const { refresh: refreshOrgs } = useActiveOrg()
  const [step, setStep] = useState(1)
  const [displayName, setDisplayName] = useState("")
  const [createdProject, setCreatedProject] = useState<ProjectRecord | null>(null)

  // The privacy step (2) is skipped in both directions once the user has made
  // an analytics choice on a previous run.
  const [skipPrivacy] = useState(() => hasAnalyticsConsentBeenSet())

  // Track the previous step so we can detect direction for the analytics event.
  const prevStepRef = useRef(step)

  // Emit a step-viewed event whenever the wizard advances to a new step.
  useEffect(() => {
    const prev = prevStepRef.current
    prevStepRef.current = step
    if (step === prev) return // initial mount — skip (step was just set to 1)
    posthog.capture(ONBOARDING_STEP_VIEWED, {
      step,
      step_label: STEP_LABELS[step] ?? `step-${step}`,
      direction: step > prev ? "forward" : "back",
      privacy_skipped: skipPrivacy,
    })
  }, [step, skipPrivacy])

  const next = useCallback(() => setStep((s) => {
    const n = Math.min(s + 1, TOTAL_STEPS)
    return n === 2 && skipPrivacy ? 3 : n
  }), [skipPrivacy])
  const back = useCallback(() => setStep((s) => {
    const p = Math.max(s - 1, 1)
    return p === 2 && skipPrivacy ? 1 : p
  }), [skipPrivacy])

  /**
   * FRO-282: called when the user completes a LOGIN (not signup) in SignInStep.
   * If they already have orgs, skip Name + Project steps and land on dashboard.
   * refreshOrgs() now returns the freshly loaded list so we don't race against
   * a stale closure (the `orgs` state value captured at callback creation time
   * may not reflect the post-login server state).
   */
  const handleLoginComplete = useCallback(async () => {
    // Force a fresh fetch; the return value is the authoritative post-login list.
    const freshOrgs = await refreshOrgs()
    const alreadyOnboarded = localStorage.getItem("codex:onboardingComplete") === "true"
    if (alreadyOnboarded || freshOrgs.length > 0) {
      localStorage.setItem("codex:onboardingComplete", "true")
      posthog.capture(ONBOARDING_RETURNING_USER_SKIP, {
        reason: alreadyOnboarded ? "flag" : "has-orgs",
      })
      navigate("/")
    } else {
      // Brand-new account with no orgs yet — continue the signup wizard.
      next()
    }
  }, [refreshOrgs, navigate, next])

  const handleProjectCreated = useCallback((project: ProjectRecord) => {
    setCreatedProject(project)
    next()
  }, [next])

  const handleFinish = useCallback(() => {
    localStorage.setItem("codex:onboardingComplete", "true")
    if (createdProject) {
      navigate(`/project/${createdProject.id}`, {
        state: { openSetupChecklist: true },
      })
    } else {
      navigate("/")
    }
  }, [createdProject, navigate])

  const handleSkipProject = useCallback(() => {
    localStorage.setItem("codex:onboardingComplete", "true")
    navigate("/")
  }, [navigate])

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4" aria-label="Account setup">
      <div className="w-full max-w-md">
        {/* Step indicator */}
        <div
          className="mb-8 flex justify-center gap-2"
          role="progressbar"
          aria-valuenow={step}
          aria-valuemin={1}
          aria-valuemax={TOTAL_STEPS}
          aria-label={`Step ${step} of ${TOTAL_STEPS}`}
        >
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <div
              key={i}
              aria-hidden="true"
              className={
                "h-2 w-2 rounded-full transition-colors " +
                (i + 1 <= step ? "bg-primary" : "bg-muted")
              }
            />
          ))}
        </div>

        {/* Steps */}
        {step === 1 && <WelcomeStep onNext={next} />}
        {step === 2 && <PrivacyStep onNext={next} onBack={back} />}
        {step === 3 && <SignInStep onNext={next} onBack={back} onLoginComplete={handleLoginComplete} />}
        {step === 4 && (
          <NameStep
            value={displayName}
            onChange={setDisplayName}
            onNext={next}
            onBack={back}
          />
        )}
        {step === 5 && (
          <ProjectStep
            displayName={displayName}
            onCreated={handleProjectCreated}
            onBack={back}
            onSkip={handleSkipProject}
          />
        )}
        {step === 6 && createdProject && (
          <ReadyStep project={createdProject} onFinish={handleFinish} />
        )}
      </div>
    </main>
  )
}
