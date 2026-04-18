import { useSectionProgress } from "@/hooks/useSectionProgress"
import { ProgressDot } from "./ProgressDot"

interface Props {
  fileId: string
  validationCount: number
  onSectionClick: (sectionLabel: string) => void
}

/**
 * Compact dot grid showing per-section progress for a file. Rendered inside
 * the expanded file row in the sidebar. Loads the file's Y.Doc lazily (via
 * the ref-counted registry) so expanding N files hydrates N docs but
 * collapsing frees them.
 */
export function FileSectionGrid({ fileId, validationCount, onSectionClick }: Props) {
  const sections = useSectionProgress(fileId, validationCount)

  if (sections === null) {
    return <div className="px-6 py-1 text-[10px] text-muted-foreground">Loading…</div>
  }
  if (sections.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-1.5 px-6 py-1.5 max-h-24 overflow-y-auto">
      {sections.map((section) => (
        <ProgressDot
          key={section.label}
          label={section.label}
          completedPercent={section.textCompleted}
          validatedPercent={section.textValidated}
          validationLevels={section.textValidationLevels}
          requiredValidations={validationCount}
          onClick={() => onSectionClick(section.label)}
        />
      ))}
    </div>
  )
}
