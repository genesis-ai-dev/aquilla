import { useState, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import type { ProjectRecord } from "@/lib/parsers/types"
import { hasAnalyticsConsentBeenSet } from "@/lib/analytics-consent"
import { WelcomeStep } from "./steps/WelcomeStep"
import { PrivacyStep } from "./steps/PrivacyStep"
import { SignInStep } from "./steps/SignInStep"
import { NameStep } from "./steps/NameStep"
import { ProjectStep } from "./steps/ProjectStep"
import { ReadyStep } from "./steps/ReadyStep"

const TOTAL_STEPS = 6

export function OnboardingWizard() {
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  const [displayName, setDisplayName] = useState("")
  const [createdProject, setCreatedProject] = useState<ProjectRecord | null>(null)

  // The privacy step (2) is skipped in both directions once the user has made
  // an analytics choice on a previous run.
  const [skipPrivacy] = useState(() => hasAnalyticsConsentBeenSet())

  const next = useCallback(() => setStep((s) => {
    const n = Math.min(s + 1, TOTAL_STEPS)
    return n === 2 && skipPrivacy ? 3 : n
  }), [skipPrivacy])
  const back = useCallback(() => setStep((s) => {
    const p = Math.max(s - 1, 1)
    return p === 2 && skipPrivacy ? 1 : p
  }), [skipPrivacy])

  const handleProjectCreated = useCallback((project: ProjectRecord) => {
    setCreatedProject(project)
    next()
  }, [next])

  const handleFinish = useCallback(() => {
    localStorage.setItem("codex:onboardingComplete", "true")
    if (createdProject) {
      navigate(`/project/${createdProject.id}`)
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
        {step === 3 && <SignInStep onNext={next} onBack={back} />}
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
