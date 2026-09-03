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

import {
  VIDEO_PANE_MAX_SHARE,
  VIDEO_PANE_MIN_WIDTH,
  VIDEO_PANE_TABLE_MIN_WIDTH,
} from "./video-pane-layout"
import {
  MEDIA_BODY_MIN_HEIGHT,
  TIMELINE_PANE_MAX_SHARE,
  TIMELINE_PANE_MIN_HEIGHT,
} from "./timeline-pane-layout"

export type MediaSectionId = "timeline" | "video" | "text"

/**
 * How thick a collapsed section's rail is.
 *
 * 40 is the app's rail width, not a new number: AppShell calls the collapsed
 * dock "Collapsed rail (40)" and LeftDock draws it as `w-10`. The Parallel
 * Bibles edge tab is 36 because it carries a line of vertical text; these rails
 * are icon-only (Sam's call), so they match the dock instead.
 */
export const MEDIA_RAIL_PX = 40

/**
 * Slack when deciding "is this panel sitting at its rail?" from a measured
 * size. The library reports pixels it derived from a percentage, so the value
 * can land a hair either side of 40. Two pixels is plenty and cannot collide
 * with a real expanded size — the smallest floor in the lens is 130.
 */
const RAIL_TOLERANCE_PX = 2

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
 * Is a measured panel size the rail rather than a real width?
 *
 * Zero is NOT the rail. A ResizeObserver reports 0 for a subtree that has been
 * hidden by an ancestor, and treating that as "the user collapsed this" would
 * collapse sections behind the reader's back on any such transition.
 */
export function isRailSized(px: number): boolean {
  return px > 0 && px <= MEDIA_RAIL_PX + RAIL_TOLERANCE_PX
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

/** A collapsed section is pinned to the rail: one size, and nothing can move it. */
const RAIL_PINNED: MediaPanelConstraints = { minSize: MEDIA_RAIL_PX, maxSize: MEDIA_RAIL_PX }

/**
 * The four panels' constraints for a given collapsed set.
 *
 * A COLLAPSED SECTION IS PINNED (`min === max === MEDIA_RAIL_PX`), NOT
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
 * The one cap that must move is the video's. `58%` exists to stop the picture
 * eating the table; with the table railed there is no table to protect, and the
 * cap would be the only thing refusing the space the collapse just freed. It is
 * relaxed IN THE SAME RENDER as the pin — narrowing it back while the table is
 * still railed produces a layout summing to 110%, which flexbox normalises into
 * a table below its own floor and an `onResize` that writes that bogus width
 * into the remembered video width.
 */
export function mediaPanelConstraints(input: {
  collapsed: CollapsedSections
  timelineStacked: boolean
  hasVideo: boolean
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
  return {
    timeline: timelineCollapsed
      ? RAIL_PINNED
      : {
          minSize: TIMELINE_PANE_MIN_HEIGHT,
          maxSize: TIMELINE_PANE_MAX_SHARE,
          collapsible: true,
          collapsedSize: MEDIA_RAIL_PX,
        },
    body: { minSize: MEDIA_BODY_MIN_HEIGHT },
    video: videoCollapsed
      ? RAIL_PINNED
      : {
          minSize: VIDEO_PANE_MIN_WIDTH,
          maxSize: textCollapsed ? "100%" : VIDEO_PANE_MAX_SHARE,
          collapsible: true,
          collapsedSize: MEDIA_RAIL_PX,
        },
    // The table is NOT collapsible while open, and that is deliberate rather
    // than an omission. It is the last panel of its group, so its only
    // separator is on its left and dragging that grows the video into its own
    // cap long before the table reaches a collapse threshold — the gesture
    // cannot reach it. Leaving `collapsible` on would buy nothing and would
    // hand the library licence to snap the table shut on its own on a very
    // narrow window. The button collapses it by pinning; the library's own
    // validation clamps it to the rail on the next commit, with no imperative
    // call at all. With the video railed the table simply takes the residual,
    // which is how "collapsing the video gives its space to the text" happens
    // without a rule for it.
    table: textCollapsed ? RAIL_PINNED : { minSize: VIDEO_PANE_TABLE_MIN_WIDTH },
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
): boolean {
  if (id === "timeline") return !collapsed.includes("timeline")
  return !collapsed.includes("video") && !collapsed.includes("text")
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
): boolean {
  return between === "timeline-body"
    ? collapsed.includes("timeline")
    : collapsed.includes("video") || collapsed.includes("text")
}

// PER FILE, matching the timeline's height and the gutter beside it rather than
// the video pane's global width: an episode with a linked film and a four-row
// dubbing file want different arrangements, and one shared setting would have
// each visit undo the other.
const KEY_PREFIX = "aquilla:mediaSectionsCollapsed:"

const keyFor = (fileId: string) => `${KEY_PREFIX}${fileId}`

const ALL: readonly MediaSectionId[] = ["timeline", "video", "text"]

/** Nothing collapsed for anything that is not an explicit, well-formed list —
 *  private mode, a cleared store, a value from a future build. That default is
 *  the state that hides nothing from anybody. */
export function readStoredCollapsedSections(fileId: string | null | undefined): CollapsedSections {
  if (!fileId) return EMPTY
  try {
    const saved = localStorage.getItem(keyFor(fileId))
    if (!saved) return EMPTY
    const ids = saved.split(",").filter((s): s is MediaSectionId => ALL.includes(s as MediaSectionId))
    // De-duplicate defensively: the order carries recency, so a repeated id
    // would make "most recently collapsed" ambiguous.
    return ids.filter((id, i) => ids.indexOf(id) === i)
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
