// Floating action cluster shown above a SOURCE selection. Mirrors the
// CellActionRail aesthetic (rounded container, muted icons). Buttons:
// Ask AI (push the selection into the agent chat as a chip) and Add to termbase
// (existing terminology flow). A "View term" lookup appears when the selection
// matches an active concept.
//
// AQU-1102: that lookup is READ-ONLY and takes no `onApply`. Apply may only
// mutate the target when the translator has the *target* cell focused with a
// text selection (AQU-204) — and by construction a source selection means the
// target has none, so an Apply button here could only ever write into an
// untouched target. The affordance is therefore absent, not merely disabled.
import { useMemo } from "react"
import { BookOpen, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Concept } from "@/lib/terminology/types"
import { TermLookupPopover } from "./TermLookupPopover"
import { useT } from "@/lib/i18n/I18nProvider"

export interface SourceSelectionToolbarProps {
  sourceSelection: string
  concepts: Concept[]
  onAskAi: () => void
  onAddToTermbase?: () => void
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
      className="absolute right-1 top-0 z-10 flex items-center gap-0.5 rounded-md bg-card p-1"
      dir="ltr"
      onMouseUp={onToolbarMouseUp}
      onMouseLeave={onToolbarMouseUp}
    >
      {/* AQU-1102: no `onApply` — read-only lookup. */}
      {hasMatch && (
        <TermLookupPopover sourceTerm={sourceSelection} concepts={activeConcepts}>
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
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onMouseDown={handleButtonMouseDown}
          onClick={onAddToTermbase}
        >
          <BookOpen className="size-3" aria-hidden />
          {t("workspace.sourceSelection.addToTermbase")}
        </Button>
      )}
    </div>
  )
}
