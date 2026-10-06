/**
 * Shared, co-referential Living Memory entry point: one glyph, one label, one
 * destination across every surface. Data-driven menus that render their own
 * rows (workspace sidebar, settings NavRows) reuse LIVING_MEMORY_ICON +
 * projectMemoryPath instead of this component so the references stay aligned.
 */
import { BrainCircuit, Target } from "lucide-react"
import { useNavigate } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { projectMemoryPath } from "@/lib/navigation/org-paths"

/** The one Living Memory glyph — matches `page-icons.ts` ("Project memory"). */
export const LIVING_MEMORY_ICON = BrainCircuit

/** The one translation-brief glyph. Lives here, beside the Living Memory
 *  glyph, because two surfaces now row the brief — the Living Memory index
 *  (LIVING_MEMORY_SECTIONS) and project settings' AI & completion pane
 *  (AQU-1672) — and a settings import of LivingMemoryPage for it would drag
 *  that whole page into the settings bundle. */
export const BRIEF_ICON = Target

interface LivingMemoryButtonProps {
  projectId: string
  /** Target section pane (e.g. "instructions", "quality"); omit for the index. */
  section?: string
  /** Minimal variant — the label moves into a tooltip + aria-label. */
  iconOnly?: boolean
  variant?: "ghost" | "outline" | "secondary"
  /** Runs just before navigation so hosts can close sheets/popovers first. */
  onNavigate?: () => void
  className?: string
}

export function LivingMemoryButton({
  projectId,
  section,
  iconOnly = false,
  variant = "ghost",
  onNavigate,
  className,
}: LivingMemoryButtonProps) {
  const t = useT()
  const navigate = useNavigate()
  const label = t("terminology.livingMemory.title")
  const go = () => {
    onNavigate?.()
    navigate(projectMemoryPath(projectId, section))
  }
  if (iconOnly) {
    return (
      <AppTooltip content={label}>
        <Button
          type="button"
          variant={variant}
          size="icon-sm"
          aria-label={label}
          onClick={go}
          className={className}
        >
          <LIVING_MEMORY_ICON />
        </Button>
      </AppTooltip>
    )
  }
  return (
    <Button type="button" variant={variant} size="sm" onClick={go} className={className}>
      <LIVING_MEMORY_ICON data-icon="inline-start" aria-hidden />
      {label}
    </Button>
  )
}
