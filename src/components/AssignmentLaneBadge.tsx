import { Badge } from "@/components/ui/badge"
import { laneChipLabel } from "@/components/org/project-lanes"
import { cn } from "@/lib/utils"

interface AssignmentLaneBadgeProps {
  /** Assignment lane tag; '' / absent = the project's default lane. */
  targetLang?: string
  /** Human label for the default ('') lane — the project's target language. */
  defaultLaneLabel: string
  /** Localized placeholder when no target language is configured. */
  fallbackLabel: string
  /** Lane row name, when the assignment payload carries one. */
  laneName?: string | null
  className?: string
}

/** Lane chip for an assignment row — always visible so assignees know which language lane they're in. */
export function AssignmentLaneBadge({
  targetLang = "",
  defaultLaneLabel,
  fallbackLabel,
  laneName,
  className,
}: AssignmentLaneBadgeProps) {
  const label = laneChipLabel(targetLang, defaultLaneLabel, fallbackLabel, laneName)
  return (
    <Badge variant="outline" className={cn("shrink-0", className)}>
      {label}
    </Badge>
  )
}
