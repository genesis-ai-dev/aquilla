// Floating action cluster shown above a SOURCE selection. Mirrors the
// CellActionRail aesthetic (rounded container, muted icons). Buttons:
// Ask AI (push the selection into the agent chat as a chip) and Add to
// terminology (popover that creates a concept without leaving the editor).
import { useMemo } from "react"
import { BookOpen, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Concept, ConceptDraft } from "@/lib/terminology/types"
import { TermLookupPopover } from "./TermLookupPopover"
import { AddConceptPopover } from "./AddConceptDialog"
import { useT } from "@/lib/i18n/I18nProvider"

export interface SourceSelectionToolbarProps {
  sourceSelection: string
  concepts: Concept[]
  onAskAi: () => void
  onAddToTermbase?: (draft: ConceptDraft) => void | Promise<void>
  addConceptBlockedReason?: string | null
  onAddOpenChange?: (open: boolean) => void
  onViewConcept?: (conceptId: string) => void
  /** AQU-260: called on mousedown so the parent suppresses selectionchange clearing. */
  onToolbarMouseDown?: () => void
  /** AQU-260: called on mouseup/mouseleave so the parent resets the guard. */
  onToolbarMouseUp?: () => void
}

export function SourceSelectionToolbar({
  sourceSelection,
  concepts,
  onAskAi,
  onAddToTermbase,
  addConceptBlockedReason,
  onAddOpenChange,
  onViewConcept,
  onToolbarMouseDown,
  onToolbarMouseUp,
}: SourceSelectionToolbarProps) {
  const t = useT()
  const activeConcepts = useMemo(() => concepts.filter((c) => c.status === "active"), [concepts])
  const hasMatch = useMemo(
    () =>
      activeConcepts.some(
        (c) =>
          c.sourceTerm.toLowerCase().includes(sourceSelection.toLowerCase()) ||
          sourceSelection.toLowerCase().includes(c.sourceTerm.toLowerCase()),
      ),
    [activeConcepts, sourceSelection],
  )

  // AQU-260: preserve the browser selection + suppress the selectionchange guard.
  const handleButtonMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    onToolbarMouseDown?.()
  }

  return (
    <div
      className="absolute right-1 top-0 z-20 flex items-center gap-0.5 rounded-md bg-card p-1"
      dir="ltr"
      onMouseUp={(e) => {
        e.stopPropagation()
        onToolbarMouseUp?.()
      }}
      onMouseLeave={onToolbarMouseUp}
    >
      {hasMatch && (
        <TermLookupPopover
          sourceTerm={sourceSelection}
          concepts={activeConcepts}
          onViewConcept={onViewConcept}
          triggerIsNativeButton
        >
          <Button type="button" size="xs" variant="ghost" onMouseDown={handleButtonMouseDown}>
            <BookOpen className="size-3" aria-hidden />
            {t("workspace.sourceSelection.viewTerm")}
          </Button>
        </TermLookupPopover>
      )}

      <Button type="button" size="xs" variant="ghost" onMouseDown={handleButtonMouseDown} onClick={onAskAi}>
        <Sparkles className="size-3" aria-hidden />
        {t("workspace.sourceSelection.askAi")}
      </Button>

      {onAddToTermbase && (
        <AddConceptPopover
          sourceTerm={sourceSelection}
          blockedReason={addConceptBlockedReason}
          onConfirm={onAddToTermbase}
          onOpenChange={onAddOpenChange}
        >
          <Button type="button" size="xs" variant="ghost" onMouseDown={handleButtonMouseDown}>
            <BookOpen className="size-3" aria-hidden />
            {t("workspace.sourceSelection.addToTermbase")}
          </Button>
        </AddConceptPopover>
      )}
    </div>
  )
}
