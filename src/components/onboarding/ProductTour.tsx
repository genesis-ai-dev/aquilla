/**
 * FRO-243: Lightweight spotlight / coach-marks product tour.
 *
 * Design constraints:
 * - No new npm dependencies — built with React portals + inline Tailwind.
 * - Rendered into document.body via createPortal so z-index context is clean.
 * - Each step targets a `data-tour` attribute. If the element is missing
 *   (route changed, feature gated), that step is silently skipped.
 * - Auto-starts once for new users (shouldAutoStartTour). Re-launchable from
 *   the OrgSidebar footer button.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { X, ChevronRight, ChevronLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { markProductTourDone, shouldAutoStartTour } from "@/hooks/useProductTour"

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------

export interface TourStep {
  /** data-tour value on the target element. Null = centre-screen splash step. */
  anchor: string | null
  title: string
  body: string
  /** Preferred placement relative to the anchor element. */
  placement?: "top" | "bottom" | "left" | "right"
}

export const TOUR_STEPS: TourStep[] = [
  {
    anchor: null,
    title: "Welcome to your workspace",
    body: "This quick tour shows you where everything lives. You can skip at any time.",
    placement: undefined,
  },
  {
    anchor: "org-switcher",
    title: "Switch organizations",
    body: "Click here to switch between organizations or create a new one.",
    placement: "right",
  },
  {
    anchor: "nav-overview",
    title: "Projects",
    body: "See portfolio health, sort project lists, and open or create projects from one place.",
    placement: "right",
  },
  {
    anchor: "nav-assigned",
    title: "Assigned to me",
    body: "Jump straight to the segments assigned to you across all projects.",
    placement: "right",
  },
  {
    anchor: "nav-settings",
    title: "Settings & members",
    body: "Manage your organization settings, invite members, and configure access here.",
    placement: "right",
  },
  {
    anchor: "account-switcher",
    title: "Your account",
    body: "Access your preferences, add another account, or sign out from here.",
    placement: "top",
  },
]

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

const SPOTLIGHT_PAD = 8

/** Returns the bounding rect of a data-tour element, or null if not found. */
function getAnchorRect(anchor: string): Rect | null {
  const el = document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

interface TooltipPos {
  top: number
  left: number
  arrowSide: "top" | "bottom" | "left" | "right" | "none"
}

const TOOLTIP_W = 288
const TOOLTIP_H_EST = 160 // conservative estimate for placement math
const GAP = 16

function computeTooltipPos(
  rect: Rect | null,
  placement: TourStep["placement"],
  vw: number,
  vh: number,
): TooltipPos {
  if (!rect) {
    // Centre-screen splash
    return {
      top: Math.max(24, vh / 2 - TOOLTIP_H_EST / 2),
      left: Math.max(24, vw / 2 - TOOLTIP_W / 2),
      arrowSide: "none",
    }
  }

  const sr = {
    top: rect.top - SPOTLIGHT_PAD,
    left: rect.left - SPOTLIGHT_PAD,
    width: rect.width + SPOTLIGHT_PAD * 2,
    height: rect.height + SPOTLIGHT_PAD * 2,
  }

  const centreX = sr.left + sr.width / 2
  const centreY = sr.top + sr.height / 2

  const preferred = placement ?? "right"

  const candidates: Array<{ side: TourStep["placement"]; pos: TooltipPos }> = [
    {
      side: "right",
      pos: {
        top: Math.min(vh - TOOLTIP_H_EST - 8, Math.max(8, centreY - TOOLTIP_H_EST / 2)),
        left: sr.left + sr.width + GAP,
        arrowSide: "left",
      },
    },
    {
      side: "left",
      pos: {
        top: Math.min(vh - TOOLTIP_H_EST - 8, Math.max(8, centreY - TOOLTIP_H_EST / 2)),
        left: sr.left - TOOLTIP_W - GAP,
        arrowSide: "right",
      },
    },
    {
      side: "bottom",
      pos: {
        top: sr.top + sr.height + GAP,
        left: Math.min(vw - TOOLTIP_W - 8, Math.max(8, centreX - TOOLTIP_W / 2)),
        arrowSide: "top",
      },
    },
    {
      side: "top",
      pos: {
        top: sr.top - TOOLTIP_H_EST - GAP,
        left: Math.min(vw - TOOLTIP_W - 8, Math.max(8, centreX - TOOLTIP_W / 2)),
        arrowSide: "bottom",
      },
    },
  ]

  const ordered = [
    candidates.find((c) => c.side === preferred),
    ...candidates.filter((c) => c.side !== preferred),
  ].filter(Boolean) as typeof candidates

  for (const c of ordered) {
    const p = c.pos
    const fits =
      p.left >= 0 &&
      p.left + TOOLTIP_W <= vw &&
      p.top >= 0 &&
      p.top + TOOLTIP_H_EST <= vh
    if (fits) return p
  }
  // Fallback: centre
  return {
    top: Math.max(8, vh / 2 - TOOLTIP_H_EST / 2),
    left: Math.max(8, vw / 2 - TOOLTIP_W / 2),
    arrowSide: "none",
  }
}

// ---------------------------------------------------------------------------
// SVG spotlight cutout
// ---------------------------------------------------------------------------

function SpotlightSvg({
  rect,
  vw,
  vh,
}: {
  rect: Rect | null
  vw: number
  vh: number
}) {
  if (!rect) {
    // Semi-transparent backdrop only, no cutout
    return (
      <svg
        className="fixed inset-0 pointer-events-none"
        style={{ zIndex: 9990, width: vw, height: vh }}
        aria-hidden="true"
      >
        <rect x={0} y={0} width={vw} height={vh} fill="rgba(0,0,0,0.45)" />
      </svg>
    )
  }

  const sr = {
    x: Math.round(rect.left - SPOTLIGHT_PAD),
    y: Math.round(rect.top - SPOTLIGHT_PAD),
    w: Math.round(rect.width + SPOTLIGHT_PAD * 2),
    h: Math.round(rect.height + SPOTLIGHT_PAD * 2),
    r: 8,
  }

  // The clipPath punches a rounded rect hole in the overlay.
  const clipId = "tour-spotlight-clip"

  return (
    <svg
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 9990, width: vw, height: vh }}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipId}>
          <path
            d={`
              M0,0 L${vw},0 L${vw},${vh} L0,${vh} Z
              M${sr.x + sr.r},${sr.y}
              L${sr.x + sr.w - sr.r},${sr.y}
              Q${sr.x + sr.w},${sr.y} ${sr.x + sr.w},${sr.y + sr.r}
              L${sr.x + sr.w},${sr.y + sr.h - sr.r}
              Q${sr.x + sr.w},${sr.y + sr.h} ${sr.x + sr.w - sr.r},${sr.y + sr.h}
              L${sr.x + sr.r},${sr.y + sr.h}
              Q${sr.x},${sr.y + sr.h} ${sr.x},${sr.y + sr.h - sr.r}
              L${sr.x},${sr.y + sr.r}
              Q${sr.x},${sr.y} ${sr.x + sr.r},${sr.y}
              Z
            `}
            fillRule="evenodd"
          />
        </clipPath>
      </defs>
      <rect
        x={0}
        y={0}
        width={vw}
        height={vh}
        fill="rgba(0,0,0,0.45)"
        clipPath={`url(#${clipId})`}
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Tooltip card
// ---------------------------------------------------------------------------

const ARROW_CLASS: Record<NonNullable<TooltipPos["arrowSide"]>, string> = {
  left: "absolute left-[-8px] top-1/2 -translate-y-1/2 border-y-8 border-r-8 border-y-transparent border-r-popover",
  right: "absolute right-[-8px] top-1/2 -translate-y-1/2 border-y-8 border-l-8 border-y-transparent border-l-popover",
  top: "absolute top-[-8px] left-1/2 -translate-x-1/2 border-x-8 border-b-8 border-x-transparent border-b-popover",
  bottom: "absolute bottom-[-8px] left-1/2 -translate-x-1/2 border-x-8 border-t-8 border-x-transparent border-t-popover",
  none: "",
}

interface TooltipCardProps {
  step: TourStep
  stepIndex: number
  totalSteps: number
  pos: TooltipPos
  onNext: () => void
  onPrev: () => void
  onSkip: () => void
}

function TooltipCard({ step, stepIndex, totalSteps, pos, onNext, onPrev, onSkip }: TooltipCardProps) {
  const isFirst = stepIndex === 0
  const isLast = stepIndex === totalSteps - 1

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={`Tour step ${stepIndex + 1} of ${totalSteps}: ${step.title}`}
      className="fixed rounded-xl border bg-popover text-popover-foreground shadow-lg"
      style={{
        zIndex: 9991,
        top: pos.top,
        left: pos.left,
        width: TOOLTIP_W,
      }}
    >
      {/* Arrow */}
      {pos.arrowSide !== "none" && (
        <span aria-hidden="true" className={ARROW_CLASS[pos.arrowSide]} />
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-2 p-4 pb-2">
        <p className="text-sm font-semibold leading-tight">{step.title}</p>
        <button
          type="button"
          aria-label="Skip tour"
          onClick={onSkip}
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Body */}
      <p className="px-4 pb-3 text-xs leading-relaxed text-muted-foreground">{step.body}</p>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
        {/* Step dots */}
        <div className="flex items-center gap-1" aria-hidden="true">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              className={`h-1.5 w-1.5 rounded-full transition-colors ${
                i === stepIndex ? "bg-primary" : "bg-muted"
              }`}
            />
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {!isFirst && (
            <Button variant="ghost" size="sm" onClick={onPrev} className="h-7 px-2 text-xs">
              <ChevronLeft className="h-3 w-3" />
              Back
            </Button>
          )}
          <Button size="sm" onClick={onNext} className="h-7 px-3 text-xs">
            {isLast ? "Done" : (
              <>
                Next
                <ChevronRight className="h-3 w-3" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main ProductTour component
// ---------------------------------------------------------------------------

interface ProductTourProps {
  /** Controlled open state. Caller manages this. */
  open: boolean
  onClose: () => void
}

export function ProductTour({ open, onClose }: ProductTourProps) {
  const [stepIndex, setStepIndex] = useState(0)
  const [vw, setVw] = useState(() => window.innerWidth)
  const [vh, setVh] = useState(() => window.innerHeight)
  // Tracks the resolved anchor rect for the current step (null = not found or splash).
  const [anchorRect, setAnchorRect] = useState<Rect | null>(null)
  // Resolved visible steps (steps whose anchors exist in the DOM, or splash steps).
  const [visibleSteps, setVisibleSteps] = useState<TourStep[]>([])

  // Resolve visible steps whenever open changes or the window resizes.
  const resolveSteps = useCallback(() => {
    const resolved = TOUR_STEPS.filter((s) => {
      if (s.anchor === null) return true // splash step always included
      return document.querySelector(`[data-tour="${s.anchor}"]`) !== null
    })
    setVisibleSteps(resolved)
  }, [])

  // Resize observer keeps spotlight in sync with layout changes.
  useEffect(() => {
    if (!open) return
    resolveSteps()
    const onResize = () => {
      setVw(window.innerWidth)
      setVh(window.innerHeight)
      resolveSteps()
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [open, resolveSteps])

  // Reset to step 0 each time the tour opens.
  useEffect(() => {
    if (open) setStepIndex(0)
  }, [open])

  // Update anchorRect whenever the step or viewport changes.
  useEffect(() => {
    if (!open || visibleSteps.length === 0) {
      setAnchorRect(null)
      return
    }
    const step = visibleSteps[Math.min(stepIndex, visibleSteps.length - 1)]
    if (!step || step.anchor === null) {
      setAnchorRect(null)
      return
    }
    const rect = getAnchorRect(step.anchor)
    setAnchorRect(rect)
  }, [open, stepIndex, visibleSteps, vw, vh])

  const handleNext = useCallback(() => {
    if (stepIndex >= visibleSteps.length - 1) {
      markProductTourDone()
      onClose()
    } else {
      setStepIndex((i) => i + 1)
    }
  }, [stepIndex, visibleSteps.length, onClose])

  const handlePrev = useCallback(() => {
    setStepIndex((i) => Math.max(0, i - 1))
  }, [])

  const handleSkip = useCallback(() => {
    markProductTourDone()
    onClose()
  }, [onClose])

  // Keyboard: Escape = skip, ArrowRight/Enter = next, ArrowLeft = prev.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); handleSkip() }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.stopPropagation(); handleNext() }
      else if (e.key === "ArrowLeft") { e.stopPropagation(); handlePrev() }
    }
    window.addEventListener("keydown", onKey, { capture: true })
    return () => window.removeEventListener("keydown", onKey, { capture: true })
  }, [open, handleNext, handlePrev, handleSkip])

  if (!open || visibleSteps.length === 0) return null

  const safeIndex = Math.min(stepIndex, visibleSteps.length - 1)
  const step = visibleSteps[safeIndex]
  const pos = computeTooltipPos(anchorRect, step.placement, vw, vh)

  return createPortal(
    <>
      <SpotlightSvg rect={anchorRect} vw={vw} vh={vh} />
      <TooltipCard
        step={step}
        stepIndex={safeIndex}
        totalSteps={visibleSteps.length}
        pos={pos}
        onNext={handleNext}
        onPrev={handlePrev}
        onSkip={handleSkip}
      />
    </>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Controller hook — manages open state + auto-start
// ---------------------------------------------------------------------------

/**
 * Returns `[open, openTour, closeTour]`. Auto-starts the tour if
 * `shouldAutoStartTour()` is true at mount time (new user, post-onboarding).
 */
export function useProductTourController(): [boolean, () => void, () => void] {
  const autoRef = useRef(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (autoRef.current) return
    autoRef.current = true
    // Delay slightly so the app shell and sidebar have had a chance to render
    // and their data-tour elements are in the DOM.
    const timer = setTimeout(() => {
      if (shouldAutoStartTour()) setOpen(true)
    }, 600)
    return () => clearTimeout(timer)
  }, [])

  const openTour = useCallback(() => setOpen(true), [])
  const closeTour = useCallback(() => setOpen(false), [])

  return [open, openTour, closeTour]
}
