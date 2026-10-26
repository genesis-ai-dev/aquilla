// The controls beside each media-lens section's heading: fold it, or give it
// the lens. (AQU-1119; media redesign layout, Oct 2026.)
//
// A folded section used to keep a 40px rail that was also its way back. Since
// the media redesign's layout (Sam, Oct 24: "folded areas take zero space") a
// folded section takes no room at all, and the Panels menu above the lens
// brings it back (MediaPanelsMenu.tsx). The fold control keeps the gutter's
// language — a chevron pair pointing the way the section folds.
//
// NOT extracted to components/ui/. This is media-lens chrome, keyed to
// MediaSectionId.

import { ChevronsLeft, ChevronsRight, ChevronsUp, Maximize2, Minimize2 } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import type { MediaSectionId } from "./media-section-layout"

/**
 * Which way each section folds, as the pair of glyphs that say so. The
 * timeline folds up to the top edge, the video left, the text right — the
 * three edges of the lens.
 */
const GLYPH: Record<MediaSectionId, { fold: LucideIcon }> = {
  timeline: { fold: ChevronsUp },
  video: { fold: ChevronsLeft },
  text: { fold: ChevronsRight },
}

/**
 * The height of every section header row — the timeline's toolbar, the
 * video's and the text's. One number so the three rows line up beside each
 * other. Before this the rows were whatever their tallest child made them
 * (35.5px, 41px, 41px).
 *
 * 41, not 40: every row carries a 1px rule (`border-t` on the two headers,
 * `border-b` on the toolbar) and min-height is border-box, so 40px of row
 * plus its rule is what the two naturally-tall rows already measure.
 */
export const MEDIA_HEADER_ROW = "min-h-[41px]"

const FULLSCREEN_KEY = {
  timeline: "editor.timeline.fullscreenTimelineAria",
  video: "editor.timeline.fullscreenVideoAria",
  text: "editor.timeline.fullscreenTextAria",
} as const

const RESTORE_KEY = {
  timeline: "editor.timeline.restoreTimelineAria",
  video: "editor.timeline.restoreVideoAria",
  text: "editor.timeline.restoreTextAria",
} as const

const COLLAPSE_KEY = {
  video: "editor.timeline.collapseVideoAria",
  timeline: "editor.timeline.collapseTimelineAria",
  text: "editor.timeline.collapseTextAria",
} as const

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

export interface MediaSectionFullscreenButtonProps {
  /** The timeline takes the lens by folding the body row as one unit. */
  section: MediaSectionId
  /** Is this section already alone on screen? Derived, never stored. */
  isFullscreen: boolean
  onToggle: () => void
  className?: string
}

/**
 * The other control beside a section's heading: where the chevron folds THIS
 * section, this one folds the others so this section has the lens to itself.
 *
 * `Maximize2`/`Minimize2` rather than more chevrons — two glyph families for
 * two different moves, and it is the pair this app already speaks: the audio
 * recording modal uses exactly it to grow and shrink a film pane. It is NOT
 * browser fullscreen; nothing here touches the Fullscreen API and the window
 * is unchanged. See MediaVideoPane's note on why real fullscreen would have to
 * be built on the wrapper field rather than the video element.
 *
 * `aria-pressed`, not `aria-expanded`: the chevron beside it is a disclosure,
 * this is a two-state toggle of a layout mode. Wordless for the same reason
 * the chevron is — the video header's textContent is asserted, and its height
 * is in lockstep with the text header's.
 */
export function MediaSectionFullscreenButton({
  section,
  isFullscreen,
  onToggle,
  className,
}: MediaSectionFullscreenButtonProps) {
  const t = useT()
  const Glyph = isFullscreen ? Minimize2 : Maximize2
  const label = t(isFullscreen ? RESTORE_KEY[section] : FULLSCREEN_KEY[section])
  return (
    <AppTooltip content={label}>
      <button
        type="button"
        aria-pressed={isFullscreen}
        aria-label={label}
        data-testid={`media-fullscreen-${section}`}
        onClick={onToggle}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-sm p-0.5",
          "text-muted-foreground transition-colors hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500",
          className,
        )}
      >
        <Glyph className="h-3.5 w-3.5 shrink-0" />
      </button>
    </AppTooltip>
  )
}
