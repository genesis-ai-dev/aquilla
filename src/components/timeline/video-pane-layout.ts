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

/**
 * PER FILE since the media redesign's layout (Sam, Oct 23: "each person's own
 * arrangement per file"), like the timeline's height beside it: a dubbing
 * episode wants a large picture and a subtitles file a large table, and one
 * shared width made each visit undo the other.
 *
 * A file with no width of its own takes the width everyone's files SHARED
 * before (the bare key above, read and never written again), so a width
 * someone dragged to is not lost to the change; only with neither does it
 * start from `fallback`, the width its kind of file starts with (see
 * media-layout-start.ts). Reset layout leaves `RESET_WIDTH` under the file's
 * own key, so a reset file starts from its kind and the old shared width
 * never decides it again.
 */
const videoPaneWidthKey = (fileId: string) => `${VIDEO_PANE_WIDTH_KEY}:${fileId}`
const RESET_WIDTH = "reset"

export function readStoredVideoPaneWidth(
  fileId?: string | null,
  fallback: number = VIDEO_PANE_DEFAULT_WIDTH,
): number {
  if (typeof window === "undefined" || !fileId) return fallback
  try {
    const own = window.localStorage.getItem(videoPaneWidthKey(fileId))
    const saved = own ?? window.localStorage.getItem(VIDEO_PANE_WIDTH_KEY)
    if (saved && saved !== RESET_WIDTH) {
      const n = parseInt(saved, 10)
      if (Number.isFinite(n) && n >= VIDEO_PANE_MIN_WIDTH) return n
    }
  } catch {
    /* ignore */
  }
  return fallback
}

export function writeStoredVideoPaneWidth(fileId: string | null | undefined, px: number): void {
  if (typeof window === "undefined" || !fileId) return
  try {
    window.localStorage.setItem(videoPaneWidthKey(fileId), String(Math.round(px)))
  } catch {
    /* ignore */
  }
}

/** "Reset layout": the file goes back to its kind's starting width — not to
 *  the old shared width, which is why this marks the key rather than removing it. */
export function clearStoredVideoPaneWidth(fileId: string | null | undefined): void {
  if (typeof window === "undefined" || !fileId) return
  try {
    window.localStorage.setItem(videoPaneWidthKey(fileId), RESET_WIDTH)
  } catch {
    /* ignore */
  }
}
