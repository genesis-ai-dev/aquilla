// The burned-in caption over the linked video.
//
// Extracted 2026-08-11: this markup existed TWICE in MediaVideoPane, byte for
// byte apart from its comments — once anchored to the picture and once to the
// black field — because the caption can sit in either place and the two are
// different DOM parents. The placement choice stays at the call sites; the
// line itself is one component.
//
// aria-hidden on purpose: this repeats the row the table has already scrolled
// to and marked as sounding. Announcing it again would read every line twice.

import { resolveTextDirection, type DirectionMode, type TextDirection } from "@/lib/text-direction"

export interface VideoPaneCaptionProps {
  /** Already resolved against the subtitle mode — "" means "do not show". */
  target: string
  source: string
  sourceDirectionMode: DirectionMode
  targetDirectionMode: DirectionMode
  sourceTextDirection: TextDirection
  targetTextDirection: TextDirection
}

export function VideoPaneCaption({
  target,
  source,
  sourceDirectionMode,
  targetDirectionMode,
  sourceTextDirection,
  targetTextDirection,
}: VideoPaneCaptionProps) {
  return (
    <div
      aria-hidden="true"
      data-testid="video-pane-caption"
      className="pointer-events-none absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1 px-2 text-center"
      style={{ maxWidth: "92%" }}
    >
      {/* The translucent plate is invisible against a real black bar, and it is
          what saves the line when there ISN'T one — a tall-enough field, or a
          video shaped taller than the pane, leaves the picture height-bound and
          the caption sitting straight on the image. */}
      {target && (
        <span
          data-testid="video-pane-caption-target"
          dir={resolveTextDirection(targetDirectionMode, target, targetTextDirection)}
          className="inline-block whitespace-pre-wrap rounded px-2 py-1 text-xs font-medium leading-tight text-white"
          style={{
            backgroundColor: "rgba(0, 0, 0, 0.75)",
            textShadow: "1px 1px 2px rgba(0, 0, 0, 0.9)",
          }}
        >
          {target}
        </span>
      )}
      {source && (
        <span
          data-testid="video-pane-caption-source"
          dir={resolveTextDirection(sourceDirectionMode, source, sourceTextDirection)}
          className="inline-block whitespace-pre-wrap rounded px-2 py-1 text-[11px] leading-tight text-white/80"
          style={{
            backgroundColor: "rgba(0, 0, 0, 0.65)",
            textShadow: "1px 1px 2px rgba(0, 0, 0, 0.9)",
          }}
        >
          {source}
        </span>
      )}
    </div>
  )
}
