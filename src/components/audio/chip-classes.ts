// The timeline take chip's class strings, shared with every other waveform so
// the two can never drift apart (AQU-1210 / AQU-1217). Kept out of
// chip-parts.tsx so that file exports only components (fast refresh).

/** A corner button's classes. `reveal: "hover"` is the timeline's — invisible
 *  until the pointer is over the chip. `"always"` is for surfaces that are not
 *  a chip in a crowded lane (a card, a recorder), where a control you have to
 *  discover by hovering would simply go unfound. */
export function chipCornerButtonClass(side: "left" | "right", reveal: "hover" | "always" = "hover"): string {
  return reveal === "hover"
    ? `absolute ${side === "left" ? "left-2" : "right-2"} top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-background/80 opacity-0 shadow-sm ring-1 ring-border transition-opacity hover:bg-background group-hover/chip:opacity-100 focus-visible:opacity-100`
    : `absolute ${side === "left" ? "left-2" : "right-2"} top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-background/80 shadow-sm ring-1 ring-border transition-colors hover:bg-background`
}

/** The validated tick's classes (bottom-right). */
export const CHIP_VALIDATED_BADGE_CLASS =
  "pointer-events-none absolute bottom-1 right-2 z-10 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background/80 text-green-500 shadow-sm ring-1 ring-border"

/**
 * Anything drawn over a waveform OFF the timeline — its corner buttons, the
 * running time, the card's own tools. While a trim line is dragged or nudged
 * close to one it "steps aside" (Sam, 2026-09-28): WaveformRect sets
 * `data-stepped-aside` on it, and this fades it out and stops it taking
 * clicks, so the audio underneath can be seen and cut. The `!` beats a hover
 * reveal: the pointer is over the waveform for the whole drag.
 */
export const WAVE_OVERLAY_CLASS =
  "transition-opacity data-[stepped-aside=true]:pointer-events-none data-[stepped-aside=true]:opacity-0!"

/** An overlay shown only while the pointer is over its waveform or focus is
 *  inside it — for the card's secondary tools. */
export const WAVE_OVERLAY_REVEAL_CLASS =
  "opacity-0 group-hover/wave:opacity-100 group-focus-within/wave:opacity-100 focus-visible:opacity-100"

/** A 16px round overlay button, in the chip's corner-button look. The caller
 *  positions it (`right-2 top-1`, …). */
export const WAVE_OVERLAY_BUTTON_CLASS =
  "absolute z-10 flex h-4 w-4 items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm ring-1 ring-border hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

/** The preview's white hairline. The faint dark halo is what keeps a white line
 *  visible over a light body. */
export const CHIP_PLAYLINE_CLASS =
  "pointer-events-none absolute inset-y-0 left-0 z-10 w-px bg-white opacity-0 shadow-[0_0_2px_rgba(0,0,0,0.5)]"
