/**
 * TermLookupPopover — STANDALONE component.
 *
 * Props:
 *   sourceTerm  — the source-side token the user is hovering / querying
 *   concepts    — the subscribed concept set to search (provided by caller)
 *   onApply     — called with a rendering string when the user clicks Apply
 *
 * The Apply affordance is shown only when onApply is provided AND the caller
 * signals that the target cell is focused with text selected (pass onApply
 * as undefined / undefined to make the popover read-only).
 *
 * SWARM-TODO: Editor-mount of this popover (wiring to EditorTable.tsx hover
 * events + target-cell focus/selection state) is owned by the glue agent.
 * This file is intentionally self-contained.
 */

import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import type { Concept, TermRendering } from "@/lib/terminology/types"

// ────────────────────────────────────────────────────────────────────────────
// Status labels (per vocabulary-mapping table in terminology.md)
// ────────────────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<TermRendering["status"], string> = {
  preferred: "required",
  admitted: "alternate",
  forbidden: "avoid",
}

// ────────────────────────────────────────────────────────────────────────────
// Single rendering row within the popover
// ────────────────────────────────────────────────────────────────────────────

interface RenderingLineProps {
  rendering: TermRendering
  onApply?: (rendering: string) => void
}

function RenderingLine({ rendering, onApply }: RenderingLineProps) {
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
        {STATUS_LABEL[rendering.status]}
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

      {/* Apply affordance — hidden for forbidden; only when onApply is provided */}
      {!isForbidden && onApply && (
        <Button
          variant="outline"
          size="xs"
          aria-label={`Apply rendering: ${rendering.rendering}`}
          onClick={() => onApply(rendering.rendering)}
        >
          Apply
        </Button>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Single concept panel inside the popover
// ────────────────────────────────────────────────────────────────────────────

interface ConceptPanelProps {
  concept: Concept
  onApply?: (rendering: string) => void
}

function ConceptPanel({ concept, onApply }: ConceptPanelProps) {
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
          <RenderingLine key={i} rendering={r} onApply={onApply} />
        ))}
      </div>

      {/* Notes */}
      {concept.notes && (
        <p className="text-xs text-muted-foreground border-t pt-2">
          {concept.notes}
        </p>
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
  /**
   * When provided, Apply buttons appear on preferred/admitted renderings.
   * Omit or pass undefined to make the popover strictly read-only (per spec:
   * Apply is visible only when the target cell is focused with text selected).
   */
  onApply?: (rendering: string) => void
  /** The trigger element — whatever the caller wraps. */
  children: React.ReactNode
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
  onApply,
  children,
  open,
  onOpenChange,
  anchor,
}: TermLookupPopoverProps) {
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
        aria-label={`Terminology lookup for "${sourceTerm}"`}
      >
        {matches.map((concept) => (
          <ConceptPanel key={concept.id} concept={concept} onApply={onApply} />
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
      <PopoverTrigger render={<span />}>{children}</PopoverTrigger>
      {content}
    </Popover>
  )
}
