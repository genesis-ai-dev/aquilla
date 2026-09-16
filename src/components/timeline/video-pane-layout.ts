// Where the media lens's video pane is shown, and how wide. (AQU-646)

import type { AudioTimingMode } from "@/lib/parsers/types"

/** Wide enough to read burned-in captions, narrow enough to leave the table
 *  usable at 1280px: the row reserves ~174px of chrome before its two fluid
 *  columns, so every pixel here costs the target column half as much again. */
export const VIDEO_PANE_DEFAULT_WIDTH = 288
export const VIDEO_PANE_MIN_WIDTH = 220
/** The table's floor. The group honours this by squeezing the VIDEO panel
 *  (and collapsing it outright), so a narrow window loses the picture rather
 *  than crushing the text people are actually editing. 2026-08-08 (Sam):
 *  lowered from 700 so the divider can travel well right when someone wants a
 *  big picture, then raised by a quarter inch (24px, the CSS definition) when
 *  the far end proved a touch too far. */
export const VIDEO_PANE_TABLE_MIN_WIDTH = 544
// There used to be a ceiling here too — `VIDEO_PANE_MAX_SHARE = "58%"`, how
// much of the band the picture could take at the far right of the drag. It
// bound on wide windows, the table's floor above on narrow ones (crossing over
// around a 1300px band), and on 2026-08-08 Sam brought the far end in "about a
// quarter inch" by moving both. AQU-1119 retired it (2026-09-03): dragging the
// video wider is no longer the way to a bigger picture, folding sections is —
// and the ceiling was the one thing stopping the TABLE from folding by drag,
// since its only divider is the one it shares with the video and the cap
// stopped that drag ~230px before the table's snap point. The floor above is
// now the only stop, in every state.

const VIDEO_PANE_WIDTH_KEY = "aquilla:video-pane-width"

export interface VideoPaneGateInput {
  timelineStacked: boolean
  coreMediaUrl: string | null | undefined
  timingMode: AudioTimingMode
}

/**
 * Free timing deliberately keeps hiding the video (the timeline re-flows to the
 * translations' own lengths, which the original footage cannot follow) — the
 * timeline shows an explanatory note there instead. Exported so the gate has
 * test coverage: nothing renders ProjectWorkspace itself.
 */
export function shouldShowVideoPane({ timelineStacked, coreMediaUrl, timingMode }: VideoPaneGateInput): boolean {
  return Boolean(timelineStacked && coreMediaUrl && timingMode !== "audioFirst")
}

export function readStoredVideoPaneWidth(): number {
  if (typeof window === "undefined") return VIDEO_PANE_DEFAULT_WIDTH
  try {
    const saved = window.localStorage.getItem(VIDEO_PANE_WIDTH_KEY)
    if (saved) {
      const n = parseInt(saved, 10)
      if (Number.isFinite(n) && n >= VIDEO_PANE_MIN_WIDTH) return n
    }
  } catch {
    /* ignore */
  }
  return VIDEO_PANE_DEFAULT_WIDTH
}

export function writeStoredVideoPaneWidth(px: number): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(VIDEO_PANE_WIDTH_KEY, String(Math.round(px)))
  } catch {
    /* ignore */
  }
}
