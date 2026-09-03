// The two controls that open and shut a media-lens section. (AQU-1119)
//
// A collapsed section is a 40px rail holding one icon, and THE RAIL IS THE
// BUTTON. That is the whole point of the round: the video pane has been
// collapsible for months, but shut it and the only thing left to grab was the
// divider's own 4x24px grip, and dragging that open does nothing for the first
// 110px because the library swallows the delta until it clears half the
// collapse gap. So the rail is a real, full-strip target, and dragging is
// demoted to a way of CLOSING a section rather than the way of opening one.
//
// Same lesson the track gutter learned (TimelineEditor's gutter toggle):
// collapsed, the control is the only thing in the strip, so it takes the whole
// strip and is impossible to miss.
//
// NOT extracted to components/ui/. This is media-lens chrome, keyed to
// MediaSectionId. The app has three other hand-rolled versions of "collapsed,
// click to restore" — the Parallel Bibles edge tab, the timeline gutter toggle
// and the left dock's expand button — and folding all four onto one primitive
// is worth doing, but it is its own piece of work with its own review, not a
// silent rider on a media-lens feature.

import { ChartNoAxesGantt, Film, Rows3 } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import type { MediaSectionId } from "./media-section-layout"

/**
 * One icon per section.
 *
 * The timeline gets `ChartNoAxesGantt` — staggered bars, which is what a
 * timeline looks like — and deliberately NOT `AudioWaveform`: that is the
 * media lens's own icon in the mode switcher, so using it for one section
 * inside that lens would read as "this section is the lens".
 */
const ICON: Record<MediaSectionId, LucideIcon> = {
  video: Film,
  timeline: ChartNoAxesGantt,
  text: Rows3,
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

/** The collapsed section itself: one icon, and the whole strip is the target. */
export function MediaSectionRail({ section, orientation, onExpand }: MediaSectionRailProps) {
  const t = useT()
  const Icon = ICON[section]
  const label = t(EXPAND_KEY[section])
  return (
    <AppTooltip content={label} side={orientation === "vertical" ? "right" : "bottom"}>
      <button
        type="button"
        // `aria-expanded` rather than a bare label, so the control announces
        // the STATE it is in and not just what it does. Its counterpart in the
        // section header is the same button reading `true`.
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
        <Icon className="h-3.5 w-3.5 shrink-0" />
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
 * The collapse half, which lives in each section's own header.
 *
 * Borrowed from the timeline toolbar's icon buttons rather than the dock's
 * ghost Button: two of the three headers sit in or beside that toolbar, and
 * the video and text headers are kept in height lockstep on purpose — so all
 * three have to be the same element at the same size. Icon-only is a hard
 * requirement in the video header, whose textContent is asserted.
 */
export function MediaSectionCollapseButton({
  section,
  onCollapse,
  className,
}: MediaSectionCollapseButtonProps) {
  const t = useT()
  const Icon = ICON[section]
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
          "inline-flex shrink-0 items-center rounded-md border border-border px-1.5 py-1",
          "bg-background text-foreground/70 hover:bg-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500",
          className,
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
      </button>
    </AppTooltip>
  )
}
