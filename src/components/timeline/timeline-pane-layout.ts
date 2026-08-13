// How tall the media lens's timeline is, and where that number is kept.
// (AQU-646 stage 3)
//
// Sibling of video-pane-layout.ts and written to the same idiom on purpose: one
// small module per divider, holding the constants the ResizablePanelGroup in
// ProjectWorkspace needs plus the read/write pair for the stored size. The
// workspace is 7,000 lines; a `parseInt` and a try/catch inlined there is a
// thing nobody can find and nobody can test.
//
// The one real difference from the video pane's width: THIS IS PER FILE. Sam's
// call, matching the horizontal zoom and the row height — a four-row episode and
// a two-row dubbing file want different amounts of timeline, and one global
// number would have each visit undo the other.

/**
 * The height the timeline takes on a file nobody has resized.
 *
 * IT MUST REPRODUCE WHAT THE PANEL REPLACED. Until this round the timeline sat
 * in a `shrink-0` div and was simply as tall as its content, so anyone opening
 * a file for the first time after this change has to see the same layout they
 * saw before it — a divider that silently resizes the timeline on first load is
 * the change announcing itself as a bug.
 *
 * THIS NUMBER IS AN ESTIMATE AND IS OWED A MEASUREMENT. It is arithmetic over
 * the shipped chrome — 39 toolbar (a 26px button row inside `py-1.5` plus the
 * border) + 28 ruler (`h-7`) + 3 rows x 66 (`ROW_H_DEFAULT`) + 39 timing row (a
 * 23px pill inside `py-2` plus the border) — and line heights can land a pixel
 * either way. `docs/qa/browser-passes/browser-verify-media-table-sync.mjs`
 * already logs the real height ("layout: timeline Npx tall") on every run: true
 * this up from that line the next time the pass is run against a build with
 * three rows and no notice bars showing.
 */
export const TIMELINE_PANE_DEFAULT_HEIGHT = 304

/**
 * The floor, and it is not arbitrary: 39 toolbar + 28 ruler + one 24px compact
 * band + 39 timing row. Below this the divider would start eating the chrome
 * that explains what you are looking at, and the first thing to go would be the
 * only row of actual content.
 */
export const TIMELINE_PANE_MIN_HEIGHT = 130

/** How much of the pane the timeline may take at the bottom of the drag. The
 *  ceiling exists for the same reason the video pane has one — the table below
 *  has a pixel floor of its own, and on a tall window that floor stops binding
 *  long before the layout stops being sensible. */
export const TIMELINE_PANE_MAX_SHARE = "70%"

/**
 * The floor under everything BELOW the timeline — the chip-strip header, the
 * video pane and the dialogue table.
 *
 * This is now the only thing keeping the table usable, and that is a change
 * worth stating: before this round the timeline had no height control, so the
 * table's share was whatever the window left over. `browser-verify-media-table
 * -sync.mjs` checks the table clears 80px on a 1280x700 window; with a divider
 * in the layout that check passes because of THIS constant and nothing else.
 * The extra over 80 is the chip-strip header the table sits under, plus enough
 * for a row or two of text — a table squeezed to exactly its guard is not a
 * table anyone can work in.
 */
export const MEDIA_BODY_MIN_HEIGHT = 168

const timelinePaneHeightKey = (fileId: string) => `codex:timelinePaneHeight:${fileId}`

/**
 * Range-validated on the way in, not just on the way out. The stored number was
 * written by whatever build (and whatever window) the user last had this file
 * open in, and a height from a taller window applied on a short one would push
 * the table under its own floor before the group had a chance to arbitrate.
 */
export function readStoredTimelinePaneHeight(fileId: string): number {
  if (typeof window === "undefined") return TIMELINE_PANE_DEFAULT_HEIGHT
  try {
    const saved = window.localStorage.getItem(timelinePaneHeightKey(fileId))
    if (saved) {
      const n = parseInt(saved, 10)
      if (Number.isFinite(n) && n >= TIMELINE_PANE_MIN_HEIGHT) return n
    }
  } catch {
    /* private mode / unavailable — the height just won't persist */
  }
  return TIMELINE_PANE_DEFAULT_HEIGHT
}

export function writeStoredTimelinePaneHeight(fileId: string, px: number): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(timelinePaneHeightKey(fileId), String(Math.round(px)))
  } catch {
    /* ignore */
  }
}
