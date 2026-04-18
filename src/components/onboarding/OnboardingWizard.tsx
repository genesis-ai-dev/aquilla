import { useState, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import type { ProjectRecord } from "@/lib/parsers/types"
import { WelcomeStep } from "./steps/WelcomeStep"
import { SignInStep } from "./steps/SignInStep"
import { NameStep } from "./steps/NameStep"
import { ProjectStep } from "./steps/ProjectStep"
import { ReadyStep } from "./steps/ReadyStep"

const TOTAL_STEPS = 5

export function OnboardingWizard() {
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  const [displayName, setDisplayName] = useState("")
  const [createdProject, setCreatedProject] = useState<ProjectRecord | null>(null)

  const next = useCallback(() => setStep((s) => Math.min(s + 1, TOTAL_STEPS)), [])
  const back = useCallback(() => setStep((s) => Math.max(s - 1, 1)), [])

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
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        {/* Step indicator */}
        <div className="mb-8 flex justify-center gap-2">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <div
              key={i}
              className={
                "h-2 w-2 rounded-full transition-colors " +
                (i + 1 <= step ? "bg-primary" : "bg-muted")
              }
            />
          ))}
        </div>

        {/* Steps */}
        {step === 1 && <WelcomeStep onNext={next} />}
        {step === 2 && <SignInStep onNext={next} onBack={back} />}
        {step === 3 && (
          <NameStep
            value={displayName}
            onChange={setDisplayName}
            onNext={next}
            onBack={back}
          />
        )}
        {step === 4 && (
          <ProjectStep
            displayName={displayName}
            onCreated={handleProjectCreated}
            onBack={back}
            onSkip={handleSkipProject}
          />
        )}
        {step === 5 && createdProject && (
          <ReadyStep project={createdProject} onFinish={handleFinish} />
        )}
      </div>
    </div>
  )
}
