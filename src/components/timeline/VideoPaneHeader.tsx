// The video column's header — the same row the chip strip provides for the
// text column (2026-08-08, Sam's sketch): identical chrome so the two read as
// one line split by the divider. The pill carries the linked file's name.
//
// Extracted 2026-08-11: both the pane and its error card render this, so it
// cannot live inside either of them.
//
// Stage 2 (2026-08-13) hung the source mute off the right of this row, having
// moved it off the timeline's Source-audio track (that track is cue data now
// and mutes nothing). 2026-08-14 it moved again, and further: onto the bottom
// right corner of the picture itself, matching the recording modal. A header is
// still not the thing being silenced. See MediaVideoPane for the button.
//
// Anything added here must stay ICON-ONLY or wordless — a browser pass reads
// this header's textContent — and no taller than the name pill, because this
// row's height is kept in lockstep with MediaTextHeader's (see the note in
// ProjectWorkspace around the media-video/media-table panels).

import { useT } from "@/lib/i18n/I18nProvider"
import { MediaSectionCollapseButton } from "./MediaSectionRail"

export interface VideoPaneHeaderProps {
  src: string
  /**
   * AQU-1119: collapse the video section to a rail. Absent means no button —
   * the error card renders this same header, and outside the media lens there
   * is nothing to collapse into.
   */
  onCollapse?: () => void
}

export function VideoPaneHeader({ src, onCollapse }: VideoPaneHeaderProps) {
  const t = useT()
  let basename = src
  try {
    basename = decodeURIComponent(new URL(src).pathname.split("/").pop() || src)
  } catch {
    /* not a parseable URL — show it raw */
  }
  return (
    <div
      data-testid="video-pane-header"
      className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/20 px-4 py-1.5"
    >
      <span className="text-xs font-medium text-muted-foreground">{t("editor.timeline.videoPaneTitle")}</span>
      {/* Beside the heading, pointing the way the section folds — the gutter's
          own idiom. Icon-only and no taller than the name pill, per the note
          at the top of this file: a browser pass and a unit test both read
          this header's textContent, and the row's height is kept in lockstep
          with the text header's opposite it. */}
      {onCollapse && <MediaSectionCollapseButton section="video" onCollapse={onCollapse} />}
      <span className="inline-flex min-w-0 items-center rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-foreground/80">
        <span className="truncate font-mono">{basename}</span>
      </span>
    </div>
  )
}
