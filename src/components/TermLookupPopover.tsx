/**
 * TermLookupPopover — STANDALONE component.
 *
 * Props:
 *   sourceTerm  — the source-side token the user is hovering / querying
 *   concepts    — the subscribed concept set to search (provided by caller)
 *   termMatching — the project's affix inventory / fold defaults, so which
 *                 concepts the surface resolves to is the shared matcher's
 *                 verdict rather than a substring test (AQU-1272)
 *   onViewConcept — opens the matching concept in Terminology
 */

import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import type { Concept, TermMatchingSettings, TermRendering } from "@/lib/terminology/types"
import { renderingStatusLabelKey } from "@/lib/terminology/types"
import { conceptsForSourceSurface } from "@/lib/terminology/source-lookup"
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
  /** Project affix inventory + fold defaults feeding the shared matcher. */
  termMatching?: TermMatchingSettings
  /** Opens a matching concept in the Terminology page. */
  onViewConcept?: (conceptId: string) => void
  /** The trigger element — whatever the caller wraps. */
  children: React.ReactElement
  /** True when the trigger renders a native button instead of an inline element. */
  triggerIsNativeButton?: boolean
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
  termMatching,
  onViewConcept,
  children,
  triggerIsNativeButton = false,
  open,
  onOpenChange,
  anchor,
}: TermLookupPopoverProps) {
  const t = useT()
  const isControlled = open !== undefined

  // AQU-1272: the shared matcher decides, so a prefixed or differently pointed
  // occurrence resolves to its entry like it does for chips and enforcement.
  const matches = conceptsForSourceSurface(sourceTerm, concepts, termMatching)

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
        nativeButton={triggerIsNativeButton}
        render={children}
      />
      {content}
    </Popover>
  )
}
