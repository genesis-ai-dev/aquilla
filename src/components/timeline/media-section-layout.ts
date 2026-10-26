// Which sections of the media lens are collapsed, and what that does to the
// panel constraints. (AQU-1119)
//
// Third sibling of video-pane-layout.ts and timeline-pane-layout.ts, written to
// the same idiom for the same reason: ProjectWorkspace is 7,000 lines, and a
// rule you cannot find is a rule nobody can test. Everything here is pure or
// localStorage-only, which matters because NOTHING IN THE SUITE RENDERS
// ProjectWorkspace — the panel group itself is only ever exercised by a browser
// pass, so the decisions have to live somewhere a unit test can reach them.
//
// The media lens is two nested panel groups:
//
//     ┌ media-timeline ────────────────────┐   vertical group
//     ├────────────────────────────────────┤
//     │ media-body:  video │ table         │   horizontal group inside
//     └────────────────────────────────────┘
//
// so "the body" below means the video and the table together — the row that
// shares one separator.

import { VIDEO_PANE_MIN_WIDTH, VIDEO_PANE_TABLE_MIN_WIDTH } from "./video-pane-layout"
import {
  MEDIA_BODY_MIN_HEIGHT,
  TIMELINE_PANE_MAX_SHARE,
  TIMELINE_PANE_MIN_HEIGHT,
} from "./timeline-pane-layout"

export type MediaSectionId = "timeline" | "video" | "text"

/**
 * How much room a folded section keeps: none.
 *
 * Media redesign, layout (Sam, Oct 24): "folded areas take zero space". A
 * folded section used to keep a 40px rail that was also its only way back;
 * now it gets out of the way entirely and the Panels menu (and the timeline's
 * ⋯ menu) brings it back. The section stays MOUNTED — frozen, clipped and
 * inert at zero size — for every reason AQU-1119 kept it mounted behind the
 * rail.
 */
export const MEDIA_FOLDED_PX = 0

/**
 * Slack when deciding "is this panel sitting folded?" from a measured size.
 * The library reports pixels it derived from a percentage, so a folded panel
 * can measure a hair above zero. Two pixels is plenty and cannot collide with
 * a real expanded size — the smallest floor in the lens is 130.
 */
const FOLD_TOLERANCE_PX = 2

/**
 * Collapsed sections, OLDEST FIRST — the tail is the most recently collapsed.
 *
 * An ordered array rather than a set, because recency is exactly what the
 * restore rule needs ("collapsing the last visible section brings back the one
 * you collapsed most recently") and an array gives it for free, with no second
 * field to keep in step and nothing extra to serialise.
 */
export type CollapsedSections = readonly MediaSectionId[]

const EMPTY: CollapsedSections = []

/** The body's two sections, in the order they sit on screen. */
const BODY: readonly MediaSectionId[] = ["video", "text"]

/** Every section, top to bottom then left to right. The canonical order. */
const ALL: readonly MediaSectionId[] = ["timeline", "video", "text"]

/**
 * Which sections exist at all right now.
 *
 * The video panel is gated (`shouldShowVideoPane` — no linked film, or Free
 * timing, and it is not rendered), and outside the media lens there is no
 * timeline and no collapsing of anything.
 */
export function presentSections(input: {
  timelineStacked: boolean
  hasVideo: boolean
}): MediaSectionId[] {
  if (!input.timelineStacked) return []
  return input.hasVideo ? ["timeline", "video", "text"] : ["timeline", "text"]
}

export function isSectionCollapsed(collapsed: CollapsedSections, id: MediaSectionId): boolean {
  return collapsed.includes(id)
}

/**
 * Is a measured panel size folded rather than a real width?
 *
 * Only ever used to decide what NOT to record (a folded size is never a size
 * the reader chose) and whether a pin still needs driving home — never to
 * commit a fold, which only the library's own `isCollapsed()` may do. That is
 * why zero can count here: a ResizeObserver also reports 0 for a subtree an
 * ancestor has hidden, and that is equally not a size to remember.
 */
export function isFoldSized(px: number): boolean {
  return px >= 0 && px <= MEDIA_FOLDED_PX + FOLD_TOLERANCE_PX
}

/**
 * THE INVARIANT, and it is arithmetic rather than product taste: the body must
 * always keep one of its sections open.
 *
 * Video and the table are siblings in one horizontal group. If both sat at
 * their 40px rail, that group would still be ~1240px wide on a 1280px window
 * and the library would have to stretch one of them back out to fill it — at
 * which point `isCollapsed()` disagrees with the state we are holding, and the
 * rail is drawn over a panel that is not collapsed. There is no arrangement of
 * min/max that avoids it, because a flex row must be filled by something.
 *
 * Sam's rule — never all three collapsed — falls out of this one: the timeline
 * may always collapse (the body absorbs its height), so the only way to empty
 * the lens would be to empty the body first.
 */
function bodyOpenAfter(next: CollapsedSections, present: MediaSectionId[]): MediaSectionId[] {
  return BODY.filter((id) => present.includes(id) && !next.includes(id))
}

/**
 * Can this section be collapsed at all?
 *
 * The one "no" is a body section with no open partner to hand its space to —
 * which happens on a file with no linked video, where the table is the body.
 * The caller uses this to decide whether to draw a collapse control, so the
 * button is simply absent rather than present and inert.
 */
export function canCollapseSection(
  collapsed: CollapsedSections,
  id: MediaSectionId,
  present: MediaSectionId[],
): boolean {
  if (!present.includes(id) || collapsed.includes(id)) return false
  if (id === "timeline") return true
  const partner = id === "video" ? "text" : "video"
  return present.includes(partner)
}

/**
 * Collapse a section, restoring another if that is what it takes to keep the
 * body populated.
 *
 * Returns the SAME REFERENCE when nothing changes. That is load-bearing, not a
 * micro-optimisation: every constraint change re-registers the panels and fires
 * `onResize` again, so a reducer that allocated a fresh array each time would
 * drive a render loop through the resize seam.
 */
export function collapseSection(
  collapsed: CollapsedSections,
  id: MediaSectionId,
  present: MediaSectionId[],
): CollapsedSections {
  if (!canCollapseSection(collapsed, id, present)) return collapsed
  const next = [...collapsed, id]
  const stillOpen = bodyOpenAfter(next, present)
  if (stillOpen.length > 0) return next
  // Collapsing this one closed the body, so the partner comes back. It is by
  // construction the section the reader collapsed most recently before this
  // action, which is why this reads as an undo rather than an arbitrary pick.
  const partner = id === "video" ? "text" : "video"
  return next.filter((s) => s !== partner)
}

export function expandSection(
  collapsed: CollapsedSections,
  id: MediaSectionId,
): CollapsedSections {
  if (!collapsed.includes(id)) return collapsed
  return collapsed.filter((s) => s !== id)
}

/**
 * Is this section the only one on screen — folded neighbours all round?
 *
 * DERIVED, never stored, and that is the whole design of full screen. The
 * button's glyph reads off this, so it cannot claim a state the layout is not
 * in, and every route that changes the arrangement — a chevron, a rail, a
 * drag, a window fold, a film being unlinked — updates it for nothing. What IS
 * stored is only the arrangement to go back to, and that is a hint rather than
 * a source of truth (see `FullscreenMemory`).
 *
 * A consequence worth stating: folding the timeline and the text by hand
 * leaves the video genuinely full screen, so its button shows the restore
 * glyph even though nobody pressed it. That is honest, and pressing it opens
 * everything, which is what `exitFullscreen`'s empty fallback is for.
 */
export function isSectionFullscreen(
  collapsed: CollapsedSections,
  id: MediaSectionId,
  present: MediaSectionId[],
  bodyFolded = false,
): boolean {
  if (!present.includes(id) || collapsed.includes(id)) return false
  // The timeline takes the lens by folding the body ROW as one unit, which
  // leaves the film and the text exactly as they were inside it — so with the
  // body folded, the timeline is the only thing on screen and nothing in the
  // body is.
  if (bodyFolded) return id === "timeline"
  return present.every((s) => s === id || collapsed.includes(s))
}

/**
 * May this section take the whole lens?
 *
 * The timeline does it by folding the body ROW as one unit (`bodyFolded`),
 * never by folding both body sections — the body is a flex row that something
 * has to fill, the one arrangement the layout cannot hold (see
 * `bodyOpenAfter`). That was the "separate ticket" AQU-1119 left open; the
 * media redesign's layout closes it (Sam, Oct 24: full screen for every panel,
 * by real folds).
 */
export function canFullscreen(
  collapsed: CollapsedSections,
  id: MediaSectionId,
  present: MediaSectionId[],
  bodyFolded = false,
): boolean {
  if (bodyFolded) return false
  if (!present.includes(id) || collapsed.includes(id)) return false
  return present.length > 1
}

/**
 * What has to fold for this section to take the lens, in the canonical order.
 *
 * Already-folded sections are skipped, so pressing full screen when one
 * neighbour is down folds only the other — and the caller's per-section
 * collapse work (freezing the box, blurring the editor) runs once each rather
 * than for sections that are already away.
 */
export function sectionsToFoldForFullscreen(
  collapsed: CollapsedSections,
  id: MediaSectionId,
  present: MediaSectionId[],
): MediaSectionId[] {
  // The timeline folds the body row instead of anything in it.
  if (id === "timeline" || !canFullscreen(collapsed, id, present)) return []
  return ALL.filter((s) => s !== id && present.includes(s) && !collapsed.includes(s))
}

/**
 * The arrangement to come back to, and whose press it belongs to.
 *
 * It belongs to the GESTURE: pressing full screen records the folded set as it
 * was at that instant, and any later change that is not the matching press
 * throws it away. That is what makes "open another section and it just ends"
 * work without a rule of its own.
 */
export interface FullscreenMemory {
  section: MediaSectionId
  restore: CollapsedSections
}

/**
 * Drop sections that have stopped existing, and re-apply the invariant.
 *
 * The case that matters: the video is collapsed and the timeline is collapsed,
 * then the film is unlinked or the file switches to Free timing. The video
 * panel vanishes, and without this the table would be the only section left and
 * it would be collapsed — an empty workspace. Storage is deliberately NOT
 * rewritten here; re-linking the film should bring back the arrangement you
 * had, rather than punishing you for having toggled timing mode.
 */
export function reconcilePresence(
  collapsed: CollapsedSections,
  present: MediaSectionId[],
): CollapsedSections {
  let next = collapsed.filter((id) => present.includes(id))
  while (next.length > 0 && bodyOpenAfter(next, present).length === 0) {
    // Give back the most recently collapsed body section until the body has
    // something in it. A `while` rather than an `if` because the body could in
    // principle grow a third section; with two, this runs at most once.
    const lastBody = [...next].reverse().find((id) => BODY.includes(id))
    if (!lastBody) break
    next = next.filter((id) => id !== lastBody)
  }
  return next.length === collapsed.length ? collapsed : next
}

export interface MediaPanelConstraints {
  minSize?: number | string
  maxSize?: number | string
  collapsible?: boolean
  collapsedSize?: number
}

/** A collapsed section is pinned folded: one size (none), and nothing can move it. */
const FOLD_PINNED: MediaPanelConstraints = { minSize: MEDIA_FOLDED_PX, maxSize: MEDIA_FOLDED_PX }

/**
 * The four panels' constraints for a given collapsed set.
 *
 * A COLLAPSED SECTION IS PINNED (`min === max === MEDIA_FOLDED_PX`), NOT
 * `collapsible`. That is the whole mechanism and it is worth writing down why,
 * because `collapsible` + `collapsedSize` is the obvious reading of the
 * library's API and it does not work here:
 *
 *  - `media-table` is the LAST panel of its group, and the library's imperative
 *    collapse has an explicit rule that the last panel keeps the remainder — so
 *    `collapse()` on it returns a 94%-wide table. Dragging cannot reach it
 *    either: the delta is bounded by what the video can absorb, and the video's
 *    58% cap binds first.
 *  - A `collapsedSize` panel keeps rendering its children into an
 *    `overflow: auto` box, so it SCROLLS rather than turning into a rail. At
 *    40px the table's `132px` gutter column alone overflows and the timeline
 *    loses its timing row; that is clipped chrome, not a rail.
 *  - Four separate paths — a separator's Enter, Home/End, arrow keys and
 *    double-click — can drive a `collapsible` panel to its collapsed size
 *    without React hearing about it, at which point the rail is not drawn over
 *    a panel that the library considers collapsed.
 *  - `preserveFixedPanelSizes` hands the group's whole width to its one
 *    flexible panel on any window resize, which silently re-opens a railed
 *    table.
 *
 * Pinning removes all four: the solver has exactly one fixed point, every drag
 * and keypress becomes inert, and React stays the single source of truth. The
 * neighbouring `ResizableHandle` is disabled to match, so it stops announcing
 * itself as an adjustable control that cannot move.
 *
 * The video has NO ceiling, in any state. It used to be capped at 58% of the
 * row, which stopped the picture eating the table when dragging the video
 * wider was the only way to get a bigger picture. That cap was also the reason
 * the table could never be folded by dragging: its only divider is the one it
 * shares with the video, and the cap stopped the drag ~230px before the table
 * reached its snap point. Folding is the route to a bigger picture now, so the
 * table's own floor is the stop and the cap is gone (Sam, 2026-09-03).
 */
export function mediaPanelConstraints(input: {
  collapsed: CollapsedSections
  timelineStacked: boolean
  hasVideo: boolean
  /** The timeline has the lens: the whole body row is folded as one unit. */
  bodyFolded?: boolean
}): Record<"timeline" | "body" | "video" | "table", MediaPanelConstraints> {
  if (!input.timelineStacked) {
    // The text lens renders this same subtree as a bare full-height table in
    // two degenerate single-panel groups. Nothing there may collapse — there
    // would be nothing left on screen.
    return { timeline: {}, body: {}, video: {}, table: {} }
  }
  const timelineCollapsed = input.collapsed.includes("timeline")
  const videoCollapsed = input.collapsed.includes("video")
  const textCollapsed = input.collapsed.includes("text")
  const bodyFolded = Boolean(input.bodyFolded) && !timelineCollapsed
  return {
    timeline: timelineCollapsed
      ? FOLD_PINNED
      : {
          minSize: TIMELINE_PANE_MIN_HEIGHT,
          // Its 70% cap is what keeps the body usable; with the body folded
          // there is nothing below to protect, so it may take the whole lens.
          maxSize: bodyFolded ? "100%" : TIMELINE_PANE_MAX_SHARE,
          collapsible: true,
          collapsedSize: MEDIA_FOLDED_PX,
        },
    body: bodyFolded ? FOLD_PINNED : { minSize: MEDIA_BODY_MIN_HEIGHT },
    video: videoCollapsed
      ? FOLD_PINNED
      : {
          minSize: VIDEO_PANE_MIN_WIDTH,
          maxSize: "100%",
          collapsible: true,
          collapsedSize: MEDIA_FOLDED_PX,
        },
    // The table folds by drag like the other two: it holds at its floor and
    // snaps to the rail once the pointer is past the midpoint between floor
    // and rail. That pull is ~250px, longer than the video's ~90px, because
    // the floor is taller — and the floor is Sam's, it protects the table's
    // legibility at rest, so it stays. With the video railed the table simply
    // takes the residual, which is how "collapsing the video gives its space
    // to the text" happens without a rule for it.
    table: textCollapsed
      ? FOLD_PINNED
      : {
          minSize: VIDEO_PANE_TABLE_MIN_WIDTH,
          collapsible: true,
          collapsedSize: MEDIA_FOLDED_PX,
        },
  }
}

/**
 * May a measured size be written back as the section's remembered size?
 *
 * The guard the panels already carry — "only persist a size at or above the
 * floor" — is not enough once a sibling can be railed. With the table pinned
 * the video legitimately measures the whole row, which sails past its 220px
 * floor and would overwrite the width the reader actually chose; expanding the
 * table again would then restore a full-width picture instead of their 288px.
 * So a size only counts when nothing in its own group is collapsed.
 */
export function shouldPersistSize(
  collapsed: CollapsedSections,
  id: MediaSectionId,
  bodyFolded = false,
): boolean {
  // A full-screen timeline fills the lens; that is not the height anyone chose.
  if (id === "timeline") return !collapsed.includes("timeline") && !bodyFolded
  return !bodyFolded && !collapsed.includes("video") && !collapsed.includes("text")
}

/**
 * Is this section's neighbouring separator inert right now?
 *
 * A pinned panel cannot be dragged, so the handle beside it must be `disabled`
 * — otherwise it keeps a tab stop and reports `aria-valuemin === valuemax ===
 * valuenow`, announcing a slider that cannot move.
 */
export function isSeparatorDisabled(
  collapsed: CollapsedSections,
  between: "timeline-body" | "video-table",
  bodyFolded = false,
): boolean {
  return between === "timeline-body"
    ? collapsed.includes("timeline") || bodyFolded
    : collapsed.includes("video") || collapsed.includes("text")
}

// PER FILE, matching the timeline's height and the gutter beside it rather than
// the video pane's global width: an episode with a linked film and a four-row
// dubbing file want different arrangements, and one shared setting would have
// each visit undo the other.
const KEY_PREFIX = "aquilla:mediaSectionsCollapsed:"

const keyFor = (fileId: string) => `${KEY_PREFIX}${fileId}`

/**
 * A stored comma list back into sections, keeping only what this build knows.
 *
 * De-duplicates defensively: the order carries recency, so a repeated id would
 * make "most recently collapsed" ambiguous. Shared with the full-screen key,
 * whose remembered set is the same kind of list.
 */
function parseSectionList(saved: string): CollapsedSections {
  if (!saved) return EMPTY
  const ids = saved.split(",").filter((s): s is MediaSectionId => ALL.includes(s as MediaSectionId))
  return ids.filter((id, i) => ids.indexOf(id) === i)
}

/** Nothing collapsed for anything that is not an explicit, well-formed list —
 *  private mode, a cleared store, a value from a future build. That default is
 *  the state that hides nothing from anybody. */
export function readStoredCollapsedSections(fileId: string | null | undefined): CollapsedSections {
  if (!fileId) return EMPTY
  try {
    const saved = localStorage.getItem(keyFor(fileId))
    if (!saved) return EMPTY
    return parseSectionList(saved)
  } catch {
    return EMPTY
  }
}

export function writeStoredCollapsedSections(
  fileId: string | null | undefined,
  collapsed: CollapsedSections,
): void {
  if (!fileId) return
  try {
    // Nothing collapsed REMOVES the key rather than writing an empty string:
    // it is the default, so storing it says nothing, and this keeps a browser
    // from accumulating a row per file anyone ever opened. Same rule as the
    // gutter and folder state beside it.
    if (collapsed.length > 0) localStorage.setItem(keyFor(fileId), collapsed.join(","))
    else localStorage.removeItem(keyFor(fileId))
  } catch {
    /* private mode — just won't persist */
  }
}

// The full-screen memory rides in its own key rather than a new format for the
// one above: that key's parsing is covered by its own tests and is already in
// people's browsers, and a section being folded is true whether or not
// anything asked for it. Reading them separately also means a corrupt memory
// costs the reader nothing — the arrangement still comes back, only the
// "put it back" shortcut is gone.
const FULLSCREEN_PREFIX = "aquilla:mediaSectionFullscreen:"

const fullscreenKeyFor = (fileId: string) => `${FULLSCREEN_PREFIX}${fileId}`

/**
 * Read the remembered arrangement, or nothing at all.
 *
 * Strict, in the same spirit as the folded set: an unrecognised section, a
 * section that is not on screen right now, or anything that is not
 * `section|a,b` at all reads as no memory. `present` is taken so a memory
 * naming the video survives in storage but is ignored on a file whose film has
 * been unlinked — re-linking it should bring the arrangement back rather than
 * punishing a trip through Free timing, the same reasoning `reconcilePresence`
 * gives for not rewriting storage.
 */
export function readStoredFullscreen(
  fileId: string | null | undefined,
  present: MediaSectionId[],
): FullscreenMemory | null {
  if (!fileId) return null
  try {
    const saved = localStorage.getItem(fullscreenKeyFor(fileId))
    if (!saved) return null
    const bar = saved.indexOf("|")
    if (bar < 0) return null
    const section = saved.slice(0, bar) as MediaSectionId
    if (!ALL.includes(section) || !present.includes(section)) return null
    return { section, restore: parseSectionList(saved.slice(bar + 1)) }
  } catch {
    return null
  }
}

export function writeStoredFullscreen(
  fileId: string | null | undefined,
  memory: FullscreenMemory | null,
): void {
  if (!fileId) return
  try {
    // Removed rather than written empty, like the folded set: no memory is the
    // default, so storing it says nothing.
    if (memory) {
      localStorage.setItem(fullscreenKeyFor(fileId), `${memory.section}|${memory.restore.join(",")}`)
    } else {
      localStorage.removeItem(fullscreenKeyFor(fileId))
    }
  } catch {
    /* private mode — just won't persist */
  }
}

// The timeline's full screen folds the body row, and that fold is its own key:
// the folded set above is a list of SECTIONS with years of browsers holding it,
// and the body is not a section anyone can see on its own.
const BODY_FOLDED_PREFIX = "aquilla:mediaBodyFolded:"

export function readStoredBodyFolded(fileId: string | null | undefined): boolean {
  if (!fileId) return false
  try {
    return localStorage.getItem(`${BODY_FOLDED_PREFIX}${fileId}`) === "1"
  } catch {
    return false
  }
}

export function writeStoredBodyFolded(fileId: string | null | undefined, folded: boolean): void {
  if (!fileId) return
  try {
    if (folded) localStorage.setItem(`${BODY_FOLDED_PREFIX}${fileId}`, "1")
    else localStorage.removeItem(`${BODY_FOLDED_PREFIX}${fileId}`)
  } catch {
    /* private mode — just won't persist */
  }
}

/**
 * Forget this file's arrangement: what is folded, the full-screen memory and
 * the body fold. "Reset layout" — the sizes are cleared by their own modules.
 */
export function clearStoredMediaSections(fileId: string | null | undefined): void {
  writeStoredCollapsedSections(fileId, EMPTY)
  writeStoredFullscreen(fileId, null)
  writeStoredBodyFolded(fileId, false)
}
