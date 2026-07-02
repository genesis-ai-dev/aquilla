// Floating action cluster shown above a SOURCE selection. Mirrors the
// CellActionRail aesthetic (rounded neumorphic pill, muted icons). Buttons:
// Ask AI (push the selection into the agent chat as a chip) and Add to termbase
// (existing terminology flow). A "View term" lookup appears when the selection
// matches an active concept.
import { useMemo } from "react"
import { BookOpen, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Concept } from "@/lib/terminology/types"
import { TermLookupPopover } from "./TermLookupPopover"

export interface SourceSelectionToolbarProps {
  sourceSelection: string
  concepts: Concept[]
  onAskAi: () => void
  onAddToTermbase?: () => void
  onTermApply: (rendering: string) => void
  /** FRO-260: called on mousedown so the parent suppresses selectionchange clearing. */
  onToolbarMouseDown?: () => void
  /** FRO-260: called on mouseup/mouseleave so the parent resets the guard. */
  onToolbarMouseUp?: () => void
}

const PILL =
  "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium " +
  "text-muted-foreground/80 transition-[transform,color,background-color] duration-150 " +
  "hover:bg-muted/80 hover:text-foreground active:scale-[0.92] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"

export function SourceSelectionToolbar({
  sourceSelection,
  concepts,
  onAskAi,
  onAddToTermbase,
  onTermApply,
  onToolbarMouseDown,
  onToolbarMouseUp,
}: SourceSelectionToolbarProps) {
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

  // FRO-260: preserve the browser selection + suppress the selectionchange guard.
  const handleButtonMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    onToolbarMouseDown?.()
  }

  return (
    <div
      className="absolute right-1 top-0 z-10 flex items-center gap-0.5 rounded-full bg-card px-1 py-0.5 shadow-neu-sm"
      dir="ltr"
      onMouseUp={onToolbarMouseUp}
      onMouseLeave={onToolbarMouseUp}
    >
      {hasMatch && (
        <TermLookupPopover sourceTerm={sourceSelection} concepts={activeConcepts} onApply={onTermApply}>
          <button type="button" onMouseDown={handleButtonMouseDown} className={cn(PILL)}>
            <BookOpen className="size-3" aria-hidden />
            View term
          </button>
        </TermLookupPopover>
      )}

      <button type="button" onMouseDown={handleButtonMouseDown} onClick={onAskAi} className={cn(PILL)}>
        <Sparkles className="size-3" aria-hidden />
        Ask AI
      </button>

      {onAddToTermbase && (
        <button
          type="button"
          onMouseDown={handleButtonMouseDown}
          onClick={onAddToTermbase}
          className={cn(PILL)}
        >
          <BookOpen className="size-3" aria-hidden />
          Add to termbase
        </button>
      )}
    </div>
  )
}
