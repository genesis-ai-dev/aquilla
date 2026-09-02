// AQU-646 stage 3b: how wide the track gutter is, and remembering it.
//
// Sam, 2026-08-24: "make the gutter collapsible, and when it's expanded it
// should be fully expanded so that you can see the full name and all the
// information." Two states, not a drag handle — and ALL THE ROWS TOGETHER,
// never one at a time ("they would all do so at once"). So this is one boolean
// per file, not a per-track anything.
//
// THE OLD 128px IS NEITHER OF THE TWO STATES, and that is deliberate rather
// than an oversight. 128px was a compromise that did both jobs badly: it was
// wide enough to spend real timeline on, and too narrow to show a name — a
// two-word track truncated, which is what prompted the request. Splitting it
// gives each state one job. Expanded is sized to show the longest name the app
// generates plus a grip, a dot, a speaker and the `⋯` with room to spare;
// collapsed keeps only the glyphs that stay meaningful without words.
//
// DEFAULT EXPANDED. The names are the reason the gutter exists, and a file that
// opened with every track anonymous would read as broken rather than as tidy.
// Collapsing is the deliberate act; the default is the informative state.

/**
 * The strip: a colour dot (or a folder's triangle) and a speaker, and nothing
 * that needs words.
 *
 * 44 WAS TOO NARROW AND CLIPPED THE MUTE BUTTON (Sam, 2026-08-24). The row is
 * `px-1.5` around a 6px dot, a 4px gap and a 24px speaker — 46px of content
 * asking for 44px of box, inside an `overflow-hidden` column, so the control
 * simply disappeared off the edge. The `⋯` made it worse: `opacity-0` hides it
 * until hover but it still takes its width, so it is withheld entirely while
 * collapsed. 56 leaves ~10px of slack over the honest measurement rather than
 * sitting exactly on it, because the speaker grows to `p-1` at taller rows and
 * a strip that fits only at one row height is a strip that breaks at another.
 */
export const GUTTER_COLLAPSED_PX = 56

/** "Fully expanded" — Sam's words. Sized off the longest label this build
 *  produces ("Source text" / "takes · generated", plus a user's own track names,
 *  which run longer) with the grip, dot, speaker and `⋯` all present. */
export const GUTTER_EXPANDED_PX = 240

/** The width of the gutter column in px, for the grid template. */
export function gutterWidthPx(collapsed: boolean): number {
  return collapsed ? GUTTER_COLLAPSED_PX : GUTTER_EXPANDED_PX
}

// PER FILE, which is Sam's call and not the obvious one — the neighbouring
// snap preference is global. His reasoning is the same as the row height's next
// to it: a file whose tracks are called "Armenian dub (rerecord, take 3)" wants
// the names on screen, and a two-row dubbing file does not, and one shared
// setting would have each visit undo the other.
const KEY_PREFIX = "aquilla:tlGutterCollapsed:"

const keyFor = (fileId: string) => `${KEY_PREFIX}${fileId}`

/** Is this person's gutter collapsed on this file? False for anything that is
 *  not an explicit yes — private mode, a cleared store, a corrupt value — which
 *  is the state that hides no name from anybody. */
export function loadGutterCollapsed(fileId: string | null | undefined): boolean {
  if (!fileId) return false
  try {
    return localStorage.getItem(keyFor(fileId)) === "1"
  } catch {
    return false
  }
}

export function saveGutterCollapsed(fileId: string | null | undefined, collapsed: boolean): void {
  if (!fileId) return
  try {
    // Expanded REMOVES the key rather than writing "0": it is the default, so
    // storing it says nothing, and this keeps a browser from accumulating a row
    // per file anyone ever scrolled past. Same rule as the folder-collapse set
    // beside it.
    if (collapsed) localStorage.setItem(keyFor(fileId), "1")
    else localStorage.removeItem(keyFor(fileId))
  } catch {
    /* private mode — just won't persist */
  }
}
