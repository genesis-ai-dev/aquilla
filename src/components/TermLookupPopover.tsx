/**
 * TermLookupPopover — STANDALONE component.
 *
 * Props:
 *   sourceTerm  — the source-side token the user is hovering / querying
 *   concepts    — the subscribed concept set to search (provided by caller)
 *   onViewConcept — opens the matching concept in Terminology
 */

import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import type { Concept, TermRendering } from "@/lib/terminology/types"
import { renderingStatusLabelKey } from "@/lib/terminology/types"
import { useT } from "@/lib/i18n/I18nProvider"

// ────────────────────────────────────────────────────────────────────────────
// Single rendering row within the popover
// ────────────────────────────────────────────────────────────────────────────

interface RenderingLineProps {
  rendering: TermRendering
}

function RenderingLine({ rendering }: RenderingLineProps) {
  const t = useT()
  const isForbidden = rendering.status === "forbidden"

  return (
    <div className="flex items-center gap-2">
      {/* Status chip */}
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
          rendering.status === "preferred" &&
            "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
          rendering.status === "admitted" &&
            "bg-muted text-muted-foreground",
          isForbidden &&
            "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
        )}
      >
        {t(renderingStatusLabelKey(rendering.status))}
      </span>

      {/* Rendering text */}
      <span
        className={cn(
          "flex-1 text-sm",
          isForbidden && "text-muted-foreground line-through",
        )}
      >
        {rendering.rendering}
      </span>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Single concept panel inside the popover
// ────────────────────────────────────────────────────────────────────────────

interface ConceptPanelProps {
  concept: Concept
  onViewConcept?: (conceptId: string) => void
}

function ConceptPanel({ concept, onViewConcept }: ConceptPanelProps) {
  const t = useT()
  // Preferred first, admitted second, forbidden last
  const ordered = [...concept.renderings].sort((a, b) => {
    const rank: Record<string, number> = { preferred: 0, admitted: 1, forbidden: 2 }
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
  })

  return (
    <div className="space-y-2">
      {/* Headword */}
      <p className="text-xs font-semibold tracking-wide text-foreground">
        {concept.sourceTerm}
      </p>

      {/* Renderings list */}
      <div className="space-y-1.5">
        {ordered.map((r, i) => (
          <RenderingLine key={i} rendering={r} />
        ))}
      </div>

      {/* Notes */}
      {concept.notes && (
        <p className="text-xs text-muted-foreground border-t pt-2">
          {concept.notes}
        </p>
      )}

      {onViewConcept && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="w-full"
          onClick={() => onViewConcept(concept.id)}
        >
          {t("terminology.livingMemory.goToTerminologyAria")}
          <span className="sr-only"> {concept.sourceTerm}</span>
        </Button>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// TermLookupPopover — public API
// ────────────────────────────────────────────────────────────────────────────

export interface TermLookupPopoverProps {
  /** The source-side token string to look up. */
  sourceTerm: string
  /** Full concept set to search (caller provides, from subscribed termbases). */
  concepts: Concept[]
  /** Opens a matching concept in the Terminology page. */
  onViewConcept?: (conceptId: string) => void
  /** The trigger element — whatever the caller wraps. */
  children: React.ReactElement
  /**
   * AQU-204 — controlled mode. When `open` is provided the popover is
   * controlled by the caller (chip-click flow). `onOpenChange` is fired
   * when the user dismisses the popover. `anchor` pins it to a specific
   * DOM element (the clicked chip) instead of the trigger child.
   */
  open?: boolean
  onOpenChange?: (isOpen: boolean) => void
  anchor?: HTMLElement | null
}

export function TermLookupPopover({
  sourceTerm,
  concepts,
  onViewConcept,
  children,
  open,
  onOpenChange,
  anchor,
}: TermLookupPopoverProps) {
  const t = useT()
  const isControlled = open !== undefined

  // Find matching active concepts (case-insensitive substring match on sourceTerm)
  const matches = concepts.filter(
    (c) =>
      c.status === "active" &&
      c.sourceTerm.toLowerCase().includes(sourceTerm.toLowerCase()),
  )

  // No matches → just render trigger with no popover decoration
  if (matches.length === 0) {
    return <>{children}</>
  }

  const content = (
    <PopoverContent
      className="w-80 p-3 text-sm"
      sideOffset={6}
      anchor={anchor ?? undefined}
    >
      <div
        className="space-y-4"
        role="tooltip"
        aria-label={t("terminology.lookup.tooltipAria", { term: sourceTerm })}
      >
        {matches.map((concept) => (
          <ConceptPanel
            key={concept.id}
            concept={concept}
            onViewConcept={onViewConcept}
          />
        ))}
      </div>
    </PopoverContent>
  )

  if (isControlled) {
    // Controlled mode: caller owns open state; anchor is the chip element.
    return (
      <Popover open={open} onOpenChange={onOpenChange}>
        {content}
      </Popover>
    )
  }

  return (
    <Popover>
      <PopoverTrigger
        nativeButton={false}
        render={children}
      />
      {content}
    </Popover>
  )
}
