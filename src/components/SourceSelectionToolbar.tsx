// Floating action cluster shown above a SOURCE selection. Mirrors the
// CellActionRail aesthetic (rounded container, muted icons). Buttons:
// Ask AI (push the selection into the agent chat as a chip) and Add to
// terminology (popover that creates a concept without leaving the editor).
import { useMemo } from "react"
import { BookOpen, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SOURCE_SELECTION_RAIL_Z } from "@/lib/editor/source-cell-layers"
import type { CellStore } from "@/hooks/useActiveCellStore"
import type { Concept, ConceptDraft, TermMatchingSettings } from "@/lib/terminology/types"
import { hasSourceTermMatch } from "@/lib/terminology/source-lookup"
import { TermLookupPopover } from "./TermLookupPopover"
import { AddConceptPopover } from "./AddConceptDialog"
import { useT } from "@/lib/i18n/I18nProvider"

export interface SourceSelectionToolbarProps {
  sourceSelection: string
  concepts: Concept[]
  onAskAi: () => void
  onAddToTermbase?: (draft: ConceptDraft) => void | Promise<void>
  addConceptBlockedReason?: string | null
  /** May this user APPROVE a term (enforce it), vs only suggest one? */
  canApproveConcept?: boolean
  /** AQU-1271: the open file's cell store; the add-popover subscribes to it
   *  for its live match preview. */
  cellStore?: CellStore
  /** Project affix inventory + fold defaults feeding that preview. */
  termMatching?: TermMatchingSettings
  /** Open project settings so the user can configure prefixes/suffixes. */
  onSetUpAffixes?: () => void
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
  canApproveConcept,
  cellStore,
  termMatching,
  onSetUpAffixes,
  onAddOpenChange,
  onViewConcept,
  onToolbarMouseDown,
  onToolbarMouseUp,
}: SourceSelectionToolbarProps) {
  const t = useT()
  const activeConcepts = useMemo(() => concepts.filter((c) => c.status === "active"), [concepts])
  // AQU-1272: the matcher's verdict, not a bidirectional substring test — the
  // affordance has to appear on exactly the occurrences the project's fold /
  // affix / forms settings recognise, and on no others.
  const hasMatch = useMemo(
    () => hasSourceTermMatch(sourceSelection, activeConcepts, termMatching),
    [activeConcepts, sourceSelection, termMatching],
  )

  // AQU-260: preserve the browser selection + suppress the selectionchange guard.
  const handleButtonMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    onToolbarMouseDown?.()
  }

  return (
    <div
      // AQU-1134: the rail overlaps the source cell's menu trigger and must
      // paint in front of it. The layer is owned by source-cell-layers.ts —
      // don't hand-edit it here (both were z-10 once, and DOM order then put
      // the menu on top).
      className={cn(
        "absolute right-1 top-0 flex items-center gap-0.5 rounded-md bg-card p-1",
        SOURCE_SELECTION_RAIL_Z,
      )}
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
          termMatching={termMatching}
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
          canApprove={canApproveConcept}
          cellStore={cellStore}
          termMatching={termMatching}
          onSetUpAffixes={onSetUpAffixes}
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
