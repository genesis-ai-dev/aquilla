import { Button } from "@/components/ui/button"
import { projectTranslationInstructions } from "@/lib/instructions/project-instructions"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"

interface AiInstructionsStepProps {
  project: ProjectRecord
  /** Opens Living Memory → Instructions, the one place the instructions are
   *  edited (AQU-2342). Absent → the step only previews them. */
  onOpen?: () => void
}

/**
 * Setup step for the project instructions. It edits nothing itself: the
 * instructions have one editor (Living Memory → Instructions), so the step
 * previews the resolved text and opens that editor.
 */
export function AiInstructionsStep({ project, onOpen }: AiInstructionsStepProps) {
  const t = useT()
  const instructions = projectTranslationInstructions(project)

  return (
    <div className="space-y-3">
      {instructions && (
        <p className="line-clamp-3 whitespace-pre-line text-xs text-muted-foreground">
          {instructions}
        </p>
      )}
      {onOpen && (
        <Button variant="outline" onClick={onOpen} className="w-full">
          {t("onboarding.checklist.aiInstructions.openButton")}
        </Button>
      )}
    </div>
  )
}
