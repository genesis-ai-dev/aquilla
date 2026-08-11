// The two caption controls that ride on the picture.
//
// 2026-08-08 (Sam): both ride ON the picture, faded — visible while hovering,
// and for a moment when playback starts so you learn they exist. Hidden they
// are also pointer-inert, so a stray click near a corner hits the video, not an
// invisible control. They sit on the FIELD rather than the picture so they keep
// their corners when the picture is letterboxed down to a small box.
//
// ONE wrapping row rather than two free-floating corners: laid out
// independently they simply overlapped at the default pane width — 34px of
// intersection, measured, with the later-painted control swallowing clicks
// meant for the other one (a press on "Target" toggled "In bar"). Side by side
// while there is room, stacked when there is not; either way they cannot cross.
//
// Extracted from MediaVideoPane 2026-08-11, no behaviour change.

import { SegmentTabs } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { CaptionPlacement, SubtitleMode } from "./video-pane-prefs"

/** Shared look for the two controls that ride on the picture: dark, translucent
 *  and legible over any frame, with the active tab picked out in white. */
const OVERLAY_TABS_CLASS =
  // `flex-none` on the buttons matters: TabsTrigger is flex-1 by default, so a
  // list left to itself claims (widest label × tab count) and cannot give any
  // of it back. Sized to their own content, the two controls fit side by side
  // far sooner.
  "h-7 border-0 bg-black/55 backdrop-blur-sm [&_button]:h-6 [&_button]:flex-none [&_button]:px-2 [&_button]:text-[11px] [&_button]:text-white/70 [&_button:hover]:text-white [&_button[data-active]]:!bg-white/25 [&_button[data-active]]:!text-white [&_button[data-active]]:!border-transparent [&_button[data-active]]:shadow-none"

export interface VideoPaneControlsProps {
  mode: SubtitleMode
  placement: CaptionPlacement
  /** Held open for a beat after playback starts; otherwise hover-only. */
  revealed: boolean
  onModeChange(mode: SubtitleMode): void
  onPlacementChange(placement: CaptionPlacement): void
}

export function VideoPaneControls({
  mode,
  placement,
  revealed,
  onModeChange,
  onPlacementChange,
}: VideoPaneControlsProps) {
  return (
    <div
      data-testid="video-pane-controls"
      className={cn(
        "absolute inset-x-2 top-2 z-30 flex flex-wrap items-start justify-between gap-2 transition-opacity duration-300",
        revealed
          ? "opacity-100"
          : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
      )}
    >
      {mode !== "off" ? (
        <div data-testid="video-pane-placement-overlay">
          <SegmentTabs<CaptionPlacement>
            value={placement}
            onValueChange={onPlacementChange}
            aria-label="Subtitle position"
            options={[
              { label: "On video", value: "picture" },
              { label: "In bar", value: "bar" },
            ]}
            listClassName={OVERLAY_TABS_CLASS}
          />
        </div>
      ) : (
        // Holds the right-hand slot so the text control keeps its corner
        // instead of sliding left when the position control goes away.
        <span aria-hidden />
      )}
      <div data-testid="video-pane-mode-overlay">
        <SegmentTabs<SubtitleMode>
          value={mode}
          onValueChange={onModeChange}
          aria-label="Subtitle text"
          options={[
            { label: "Target", value: "target" },
            { label: "Source", value: "source" },
            { label: "Both", value: "both" },
            { label: "Off", value: "off" },
          ]}
          listClassName={OVERLAY_TABS_CLASS}
        />
      </div>
    </div>
  )
}
