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

import { cloneElement, useRef, useState } from "react"
import type { KeyboardEvent, MouseEvent, ReactElement } from "react"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import type { Concept, TermMatchingSettings, TermRendering } from "@/lib/terminology/types"
import { renderingStatusLabelKey } from "@/lib/terminology/types"
import { conceptAnswersSourceSurface, conceptsForSourceSurface } from "@/lib/terminology/source-lookup"
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

      {/* AQU-1721: a concept from a subscribed termbase belongs to another
          project. This project's Terminology page neither lists nor edits it. */}
      {onViewConcept && !concept.termbaseProjectId && (
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
  /**
   * Concepts OF `concepts` the caller already knows match this occurrence —
   * the source column found the highlight by matching them. When one of them
   * answers the lookup, the trigger is decorated without searching the
   * glossary; the full lookup then runs when the popover opens (AQU-2654).
   * Optional: without it the lookup decides, as before.
   */
  knownConcepts?: readonly Concept[]
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

/**
 * The popover's body. A component of its own so that the lookup — which
 * concepts this surface resolves to, AQU-1272's shared-matcher verdict — runs
 * when the popup mounts, not when the row that holds the trigger draws
 * (AQU-2654: every highlighted term of every row used to pay for it).
 */
function LookupPanels({
  sourceTerm,
  concepts,
  termMatching,
  onViewConcept,
}: Pick<TermLookupPopoverProps, "sourceTerm" | "concepts" | "termMatching" | "onViewConcept">) {
  const t = useT()
  const matches = conceptsForSourceSurface(sourceTerm, concepts, termMatching)
  return (
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
  )
}

/** What an inline trigger element may already carry. */
interface InlineTriggerProps {
  onClick?: (event: MouseEvent<HTMLElement>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
}

/**
 * The lookup over an INLINE trigger — a highlighted term in running source
 * text — with nothing mounted until the reader asks (AQU-2654, decision 0013:
 * "closed is unmounted").
 *
 * The source column wraps every highlighted term of every row. A Popover root,
 * a trigger and a (closed) portal per term was most of what a row with a
 * glossary rendered: the same row drew twice the components of one without.
 * Here a closed lookup is the caller's own element with the attributes and
 * keys of a popover trigger on it, and the Popover is mounted the first time
 * it is opened — anchored to that element, which is never re-created, so a
 * selection or the focus in the source text is not disturbed. It stays
 * mounted afterwards, so closing animates as before.
 *
 * Same contract as the controlled chip flow (`open` + `anchor`), owned here.
 */
function InlineTermLookup({
  sourceTerm,
  concepts,
  termMatching,
  onViewConcept,
  children,
}: Pick<TermLookupPopoverProps, "sourceTerm" | "concepts" | "termMatching" | "onViewConcept" | "children">) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  // The event that dismissed the popover, when it was a press on the trigger
  // itself: that press is "close", and the click it ends in must not re-open.
  const dismissedBy = useRef<Event | null>(null)

  const child = children as ReactElement<InlineTriggerProps>
  const toggle = (element: HTMLElement) => {
    setAnchor(element)
    setOpen((current) => !current)
  }
  const trigger = cloneElement(child, {
    role: "button",
    tabIndex: 0,
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    "data-slot": "popover-trigger",
    ...(open ? { "data-popup-open": "" } : {}),
    onClick: (event: MouseEvent<HTMLElement>) => {
      child.props.onClick?.(event)
      const dismissal = dismissedBy.current
      dismissedBy.current = null
      if (dismissal) {
        // Dismissed by this very click, or by the press that began it.
        if (dismissal === event.nativeEvent) return
        if (dismissal.type !== "click" && event.nativeEvent.timeStamp - dismissal.timeStamp < 1000) return
      }
      toggle(event.currentTarget)
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      child.props.onKeyDown?.(event)
      if (event.target !== event.currentTarget) return
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      toggle(event.currentTarget)
    },
  } as Partial<InlineTriggerProps>)

  return (
    <>
      {trigger}
      {anchor && (
        <Popover
          open={open}
          onOpenChange={(next, details) => {
            if (next) return
            const target = details.event.target
            dismissedBy.current = target instanceof Node && anchor.contains(target) ? details.event : null
            setOpen(false)
          }}
        >
          <PopoverContent className="w-80 p-3 text-sm" sideOffset={6} anchor={anchor}>
            <LookupPanels
              sourceTerm={sourceTerm}
              concepts={concepts}
              termMatching={termMatching}
              onViewConcept={onViewConcept}
            />
          </PopoverContent>
        </Popover>
      )}
    </>
  )
}

export function TermLookupPopover({
  sourceTerm,
  concepts,
  knownConcepts,
  termMatching,
  onViewConcept,
  children,
  triggerIsNativeButton = false,
  open,
  onOpenChange,
  anchor,
}: TermLookupPopoverProps) {
  const isControlled = open !== undefined

  // AQU-1272: the shared matcher decides, so a prefixed or differently pointed
  // occurrence resolves to its entry like it does for chips and enforcement.
  //
  // Here only "is there anything to show" is needed. A concept the caller
  // already matched answers that with the lookup's own per-concept predicate;
  // the lookup over the whole glossary is the fallback (no hint, or a hinted
  // concept the lookup turns away, e.g. on an excluded form).
  const hasMatch =
    (knownConcepts?.some((concept) => conceptAnswersSourceSurface(sourceTerm, concept, termMatching)) ?? false) ||
    conceptsForSourceSurface(sourceTerm, concepts, termMatching).length > 0

  // No matches → just render trigger with no popover decoration
  if (!hasMatch) {
    return <>{children}</>
  }

  // An inline trigger (a term in running text): nothing mounted until opened.
  if (!isControlled && !triggerIsNativeButton) {
    return (
      <InlineTermLookup
        sourceTerm={sourceTerm}
        concepts={concepts}
        termMatching={termMatching}
        onViewConcept={onViewConcept}
      >
        {children}
      </InlineTermLookup>
    )
  }

  const content = (
    <PopoverContent
      className="w-80 p-3 text-sm"
      sideOffset={6}
      anchor={anchor ?? undefined}
    >
      <LookupPanels
        sourceTerm={sourceTerm}
        concepts={concepts}
        termMatching={termMatching}
        onViewConcept={onViewConcept}
      />
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
      <PopoverTrigger nativeButton render={children} />
      {content}
    </Popover>
  )
}
