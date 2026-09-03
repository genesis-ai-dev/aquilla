// The two controls that fold and unfold a media-lens section. (AQU-1119)
//
// A collapsed section is a 40px rail holding one glyph, and THE RAIL IS THE
// BUTTON. That is the whole point of the round: the video pane has been
// collapsible for months, but shut it and the only thing left to grab was the
// divider's own 4x24px grip, and dragging that open does nothing for the first
// 110px because the library swallows the delta until it clears half the
// collapse gap. So the rail is a real, full-strip target, and a collapsed
// section is not draggable at all — the rail is the only way out.
//
// The glyphs are the timeline gutter's: a chevron pair pointing the way the
// section FOLDS on the control beside its heading, and the same pair reversed
// on the rail, pointing the way it OPENS. Sam's call (2026-09-03), after the
// first round's section icons — film, bars, rows — went unnoticed: an icon
// says "this is a video", a chevron says "fold this", and the gutter already
// speaks that language a few inches away. Same lesson the gutter learned about
// the strip: collapsed, the control is the only thing in it, so it takes the
// whole strip and is impossible to miss.
//
// NOT extracted to components/ui/. This is media-lens chrome, keyed to
// MediaSectionId. The app has three other hand-rolled versions of "collapsed,
// click to restore" — the Parallel Bibles edge tab, the timeline gutter toggle
// and the left dock's expand button — and folding all four onto one primitive
// is worth doing, but it is its own piece of work with its own review, not a
// silent rider on a media-lens feature.

import { ChevronsDown, ChevronsLeft, ChevronsRight, ChevronsUp } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import type { MediaSectionId } from "./media-section-layout"

/**
 * Which way each section folds, as the pair of glyphs that say so. The
 * timeline folds up to the top edge, the video left, the text right — the
 * three edges of the lens — and the rail points back the other way.
 */
const GLYPH: Record<MediaSectionId, { fold: LucideIcon; open: LucideIcon }> = {
  timeline: { fold: ChevronsUp, open: ChevronsDown },
  video: { fold: ChevronsLeft, open: ChevronsRight },
  text: { fold: ChevronsRight, open: ChevronsLeft },
}

const EXPAND_KEY = {
  video: "editor.timeline.expandVideoAria",
  timeline: "editor.timeline.expandTimelineAria",
  text: "editor.timeline.expandTextAria",
} as const

const COLLAPSE_KEY = {
  video: "editor.timeline.collapseVideoAria",
  timeline: "editor.timeline.collapseTimelineAria",
  text: "editor.timeline.collapseTextAria",
} as const

export interface MediaSectionRailProps {
  section: MediaSectionId
  /** Vertical for the side rails (video, text); horizontal for the timeline. */
  orientation: "vertical" | "horizontal"
  onExpand: () => void
}

/** The collapsed section itself: one glyph, and the whole strip is the target. */
export function MediaSectionRail({ section, orientation, onExpand }: MediaSectionRailProps) {
  const t = useT()
  const Open = GLYPH[section].open
  const label = t(EXPAND_KEY[section])
  return (
    <AppTooltip content={label} side={orientation === "vertical" ? "right" : "bottom"}>
      <button
        type="button"
        // `aria-expanded` rather than a bare label, so the control announces
        // the STATE it is in and not just what it does. Its counterpart beside
        // the section heading is the same button reading `true`.
        aria-expanded={false}
        aria-label={label}
        data-testid={`media-rail-${section}`}
        onClick={onExpand}
        className={cn(
          // Sits over the frozen, clipped content — which stays mounted, so it
          // must not be reachable behind this. The panel marks it inert.
          "absolute inset-0 z-10 flex items-center justify-center bg-background",
          "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500",
          orientation === "vertical" ? "border-e border-border" : "border-b border-border",
        )}
      >
        <Open className="h-3.5 w-3.5 shrink-0" />
      </button>
    </AppTooltip>
  )
}

export interface MediaSectionCollapseButtonProps {
  section: MediaSectionId
  onCollapse: () => void
  className?: string
}

/**
 * The fold half, which sits beside each section's heading.
 *
 * The gutter toggle's shape (TimelineEditor's `tl-gutter-toggle`): a bare
 * chevron in muted ink that darkens on hover, no border, no fill — a
 * disclosure control, not a toolbar button. Icon-only is a hard requirement
 * in the video header, whose textContent is asserted, and both the video and
 * text headers are kept in height lockstep, so it must add no height either.
 */
export function MediaSectionCollapseButton({
  section,
  onCollapse,
  className,
}: MediaSectionCollapseButtonProps) {
  const t = useT()
  const Fold = GLYPH[section].fold
  const label = t(COLLAPSE_KEY[section])
  return (
    <AppTooltip content={label}>
      <button
        type="button"
        aria-expanded
        aria-label={label}
        data-testid={`media-collapse-${section}`}
        onClick={onCollapse}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-sm p-0.5",
          "text-muted-foreground transition-colors hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500",
          className,
        )}
      >
        <Fold className="h-3.5 w-3.5 shrink-0" />
      </button>
    </AppTooltip>
  )
}
