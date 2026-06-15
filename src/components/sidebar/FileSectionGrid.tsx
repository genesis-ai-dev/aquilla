import { useSectionProgress } from "@/hooks/useSectionProgress"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface Props {
  projectId: string
  fileId: string
  validationCount: number
  getTokenForFile: (fileId: string) => Promise<string | null>
  onSectionClick: (sectionLabel: string) => void
}

/**
 * List of sections shown under an expanded file in the sidebar. Each section
 * is a clickable row (like a sub-file) with a small progress bar, replacing
 * the old dot-grid which was hard to interpret.
 */
export function FileSectionGrid({ projectId, fileId, validationCount, getTokenForFile, onSectionClick }: Props) {
  const sections = useSectionProgress(projectId, fileId, validationCount, getTokenForFile)

  if (sections === null) {
    return <div className="px-6 py-1 text-[10px] text-muted-foreground">Loading…</div>
  }
  if (sections.length === 0) {
    return null
  }

  return (
    <div className="space-y-px pl-6 pr-2 py-1">
      {sections.map((section) => {
        const completed = section.textCompleted
        const validated = section.textValidated
        return (
          <AppTooltip key={section.label} content={`${section.label}: ${completed}% translated, ${validated}% validated`}>
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded-xl bg-card px-2 py-1 text-left text-[11px] transition-shadow",
                "text-muted-foreground hover:text-foreground hover:shadow-neu-xs",
              )}
              onClick={() => onSectionClick(section.label)}
            >
              <span className="flex-1 min-w-0 truncate">{section.label}</span>
              <span className="flex items-center gap-0.5 shrink-0">
                <span className="h-1.5 w-5 rounded-full bg-muted overflow-hidden shadow-neu-inset">
                  <span
                    className="block h-full bg-amber-500 transition-all"
                    style={{ width: `${completed}%` }}
                  />
                </span>
                <span className="h-1.5 w-5 rounded-full bg-muted overflow-hidden shadow-neu-inset">
                  <span
                    className="block h-full bg-emerald-500 transition-all"
                    style={{ width: `${validated}%` }}
                  />
                </span>
              </span>
            </button>
          </AppTooltip>
        )
      })}
    </div>
  )
}
