// AQU-646 stage 2: folders, and what they do to the track list.
//
// Logic-style folder stacks: a folder is a track row like any other, and the
// tracks inside it are drawn indented beneath it — or, when it is collapsed,
// not drawn at all, with a summary band on the folder's own lane standing in
// for them. Collapse is personal state; membership is synced.
//
// ONE LEVEL ONLY, AND IT IS ENFORCED BY CONSTRUCTION RATHER THAN CHECKED. The
// single rule is: A FOLDER'S OWN `groupId` IS NEVER READ. That one line kills
// self-reference, two-cycles and folder-inside-folder together, with no visited
// set, no depth counter and no recursion — three classes of bug that a graph
// walk would have to defend against individually and would get wrong once.
// A folder always sits at the top level because nothing ever asks where it
// lives.
//
// IT REPOSITIONS, IT NEVER RE-SORTS. The list arriving here is already in
// `compareTracksBySeat` order, and that comparator exists precisely because
// equal `order` values are a real, reachable state. A second sort here could
// break a tie the other way — and the visible symptom would be a row swapping
// places at the instant the user releases a drag, which is the exact bug the
// shared comparator was written to prevent. So members are LIFTED OUT and
// SPLICED BACK, preserving whatever relative sequence they arrived in.
//
// ── `order` IS SCOPE-RELATIVE FROM STAGE 2 ON ─────────────────────────────
//
// A top-level track's `order` ranks it among the other top-level rows; a
// folder member's ranks it among its siblings. Comparing across scopes is
// meaningless.
//
// The first reason is arithmetic: with global orders, a folder at 3 holding a
// member at -5 makes the rendered sequence non-ascending, and `orderForDrop`
// then takes the midpoint of 3 and -5 and lands the dragged track above
// everything. Scoping it means every list handed to `orderForDrop` and
// `renormaliseOrders` is ascending by construction, so both are reused
// byte-for-byte, per scope.
//
// The second reason is the permission gate, and it is the load-bearing one. A
// bare `{order}` write is UNGATED — drag-to-reorder already shipped and a new
// setting defaulting to off must not take it away. With GLOBAL orders, a bare
// `{order}` could land a track inside a folder's run and restructure the tree
// with track editing switched off. With scoped orders it structurally cannot:
// an order only ranks a track among its own siblings, so crossing a folder
// boundary REQUIRES writing `groupId`, which is gated. The gate and the
// arithmetic want the same thing.
//
// Safe against every existing project: no folder exists anywhere yet, so every
// persisted order is a top-level one, and with no folders "scoped" and "global"
// say exactly the same thing.

import type { TimelineTrack } from "./tracks"
import { orderForInsert, type RowBound } from "./track-reorder"

/** One rendered row of the track column. */
export interface TrackRow {
  track: TimelineTrack
  /** 0 = top level, 1 = inside a folder. There is no 2. */
  depth: 0 | 1
  /** A folder row's members, in display order. Empty for every other row —
   *  and empty for a folder that holds nothing, which is a legal state (you
   *  make the folder before you fill it). */
  members: readonly TimelineTrack[]
  /** A folder row's collapse state. Always false for a non-folder. */
  collapsed: boolean
}

const NO_MEMBERS: readonly TimelineTrack[] = []

/**
 * Which scope a track's `order` is measured in: its folder's id, or null for
 * the top level.
 *
 * `folderIds` is the set of ids that are ACTUALLY folders in this list. A
 * `groupId` naming something that is not a folder here — a track deleted by a
 * collaborator, or one this build cannot draw — reads as top-level rather than
 * hiding the track: an orphan is visible and fixable, an invisible one is a
 * support ticket.
 */
export function trackScope(track: TimelineTrack, folderIds: ReadonlySet<string>): string | null {
  // THE ONE RULE. Never ask a folder where it lives.
  if (track.kind === "folder") return null
  const groupId = track.groupId
  return groupId && folderIds.has(groupId) ? groupId : null
}

/** The ids in this list that are folders. */
export function folderIdsOf(tracks: readonly TimelineTrack[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const track of tracks) if (track.kind === "folder") ids.add(track.id)
  return ids
}

/**
 * The rows to draw, in order.
 *
 * `collapsed` is the set of folder ids the viewer has closed — personal state,
 * so it never reaches the merge or an event.
 */
export function buildTrackRows(
  tracks: readonly TimelineTrack[],
  collapsed?: ReadonlySet<string> | null,
): TrackRow[] {
  const folderIds = folderIdsOf(tracks)

  // Lift the members out, keeping their arrival order within each folder.
  const members = new Map<string, TimelineTrack[]>()
  const topLevel: TimelineTrack[] = []
  for (const track of tracks) {
    const scope = trackScope(track, folderIds)
    if (scope === null) {
      topLevel.push(track)
      continue
    }
    const bucket = members.get(scope)
    if (bucket) bucket.push(track)
    else members.set(scope, [track])
  }

  // …and splice them back under their folders.
  const rows: TrackRow[] = []
  for (const track of topLevel) {
    if (track.kind !== "folder") {
      rows.push({ track, depth: 0, members: NO_MEMBERS, collapsed: false })
      continue
    }
    const own = members.get(track.id) ?? NO_MEMBERS
    const isCollapsed = collapsed?.has(track.id) ?? false
    rows.push({ track, depth: 0, members: own, collapsed: isCollapsed })
    if (isCollapsed) continue
    for (const member of own) {
      rows.push({ track: member, depth: 1, members: NO_MEMBERS, collapsed: false })
    }
  }
  return rows
}

/**
 * What a drag is actually reordering: the dragged track's SIBLINGS, and the
 * screen extent of each.
 *
 * A drag reorders within one scope and never across scopes — moving a track
 * into or out of a folder is the "Move to folder" command, which writes
 * `groupId` and is therefore gated. Confining the drag is what keeps a single
 * gesture from being sometimes-gated and sometimes-not, and it is what makes
 * the bare `{order}` write safe to leave ungated (see the header).
 *
 * A DRAGGED FOLDER MOVES AS A BLOCK. Its bound is the union of its own row and
 * its visible members' rows, so the hit-testing matches what the user sees
 * themselves picking up — and it is still ONE write, because members' orders
 * are measured inside the folder and do not change when the folder moves.
 *
 * Returns null when there is nothing to reorder: a scope of one, or a row index
 * that does not exist. `rowBounds` must be parallel to `rows`; a short array
 * (a row whose element could not be measured) also returns null rather than
 * hit-testing against bounds that do not line up.
 */
export interface ScopeSiblings {
  /** The scope's tracks, in display order — the list `orderForDrop` and
   *  `renormaliseOrders` are applied to. */
  tracks: TimelineTrack[]
  /** Where the dragged track sits in `tracks`. */
  fromIndex: number
  /** `tracks[i]` is rendered at `rowIndexes[i]`. The drop indicator is drawn in
   *  ROW space and decided in SCOPE space, and this is the bridge. */
  rowIndexes: number[]
  /** The folder this reorder happens inside, or null for the top level. */
  groupId: string | null
}

export function scopeSiblings(
  rows: readonly TrackRow[],
  fromRowIndex: number,
): ScopeSiblings | null {
  const origin = rows[fromRowIndex]
  if (!origin) return null

  const folderIds = folderIdsOf(rows.map((r) => r.track))
  const scope = trackScope(origin.track, folderIds)

  // One pass serves both cases. When `scope` is null the filter keeps the
  // top-level rows and drops every member; when it is a folder id it keeps
  // exactly that folder's members. Nothing needs to know which case it is in.
  const tracks: TimelineTrack[] = []
  const rowIndexes: number[] = []
  let fromIndex = -1
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (trackScope(row.track, folderIds) !== scope) continue
    if (row.track.id === origin.track.id) fromIndex = tracks.length
    tracks.push(row.track)
    rowIndexes.push(i)
  }

  if (fromIndex < 0 || tracks.length < 2) return null
  return { tracks, fromIndex, rowIndexes, groupId: scope }
}

/**
 * How far a MEMBER ROW is drawn in from the wall — `pl-3.5`, and the width the
 * drop line inherits so the line lands where the row it promises will.
 *
 * THIS IS A DRAWING MEASUREMENT, NOT A GESTURE ONE. It used to be both, and
 * that was the bug: see `folderReachInPx`.
 */
export const FOLDER_DROP_INDENT_PX = 16

/**
 * How far right the pointer must be before a drop means "inside that folder"
 * rather than "after it".
 *
 * Logic's model, and Sam's ask (2026-08-24): *"dragging can either just reorder
 * or drag into a folder, depending on the cursor being a little more to the
 * left or a little more to the right."* Measured from the gutter's own left
 * edge, so it is independent of where the timeline sits on screen.
 *
 * A FRACTION OF THE GUTTER, NOT A FIXED 16px, and the fixed version is what
 * Sam ran into (2026-08-24): *"I find out if I drag to the left enough for it
 * not to place itself in the folder."* The old threshold was sized to match the
 * 14px `pl-3.5` a member row is drawn with, on the reasoning that "the
 * threshold and the result agree" — but a row's visual indent and a pointer
 * gesture's dead zone are different things wearing the same number. On the
 * 240px expanded gutter it meant 93% of the column read as "drop inside", so
 * the only way to get a plain reorder was to hug the leftmost 16px, and the
 * indent looked like it never responded to sideways movement at all.
 *
 * Half and half instead: the left half of the gutter reorders, the right half
 * drops in. Predictable without being taught, and it scales with a column that
 * is now 56px collapsed and 240px expanded. The floor keeps the collapsed strip
 * usable rather than letting the zone shrink to nothing.
 */
export function folderReachInPx(gutterWidthPx: number): number {
  return Math.max(FOLDER_DROP_INDENT_PX, gutterWidthPx / 2)
}

export interface TrackDropTarget {
  /** The folder the track lands in, or null for the top level. */
  groupId: string | null
  /** Its new sort key WITHIN that scope. */
  order: number
  /** The scope's numbers are exhausted or tied; the caller must renormalise. */
  needsRenormalise: boolean
  /** Where to draw the line, in RENDERED-row space. */
  indicator: { rowIndex: number; edge: "top" | "bottom"; indent: boolean }
}

/**
 * Where a drag would drop, given where the pointer is in BOTH axes.
 *
 * **Y picks the position, X picks the depth.** This is the whole of the
 * Logic-style folder drag: the vertical position chooses an insertion boundary
 * among the rows on screen, and the horizontal position chooses whether that
 * boundary means "at the top level" or "inside the folder this boundary is
 * against". The caller draws an indented line for the second, so the two
 * outcomes are distinguishable before the pointer is released.
 *
 * **`allowCrossing` is the permission gate**, and it is the one place the two
 * halves of the track-editing model meet. A bare `{order}` write is ungated —
 * drag-to-reorder shipped before the setting existed — while putting a track in
 * a folder writes `groupId` and is gated. So with the setting off the answer is
 * clamped to the dragged track's CURRENT scope: the row reorders among its
 * siblings and slides past a folder as a block, exactly as it did before
 * folders existed.
 *
 * **A dragged folder ignores X entirely.** Folders do not nest — enforced by
 * construction, since nothing ever reads a folder's own `groupId` — so there is
 * no depth for it to choose.
 *
 * Returns null when the drop would change nothing, when the bounds do not line
 * up with the rows (a row that could not be measured), or when there is no such
 * row.
 */
export function resolveDropTarget(
  rows: readonly TrackRow[],
  rowBounds: readonly RowBound[],
  fromRowIndex: number,
  pointer: { contentY: number; indentX: number },
  options: {
    allowCrossing: boolean
    /** From `folderReachInPx`. Defaults to the bare indent so the pure tables
     *  that predate the width-relative rule keep meaning what they meant. */
    reachInPx?: number
  },
): TrackDropTarget | null {
  if (rowBounds.length !== rows.length) return null
  const origin = rows[fromRowIndex]
  if (!origin) return null
  // A non-finite pointer (an unmeasurable rect, a detached node) compares false
  // against every midpoint and would read as "drop at the very top".
  if (!Number.isFinite(pointer.contentY)) return null

  const folderIds = folderIdsOf(rows.map((r) => r.track))
  const movedId = origin.track.id
  const originScope = trackScope(origin.track, folderIds)
  const isFolder = origin.track.kind === "folder"

  // ── X FIRST, because it decides how Y is read ────────────────────────────
  //
  // REACHING RIGHT IS WHAT LETS YOU AIM INSIDE, and that is not two rules but
  // one: the horizontal position says whether the folder is an obstacle you are
  // going past or a container you are going into, and those want different
  // targets.
  //
  //   · Left — the folder is ONE target. Its rows are hit-tested as a single
  //     block, so a track slides past the whole thing and can never be dropped
  //     "into the middle of a folder you were only stepping over".
  //   · Right — every row is its own target, so you can put the track first,
  //     last, or between two of its members. Without this the folder's interior
  //     is unreachable from outside and a drop could only ever land at the end.
  //
  // A drag ALREADY INSIDE a folder is always per-row: its siblings are the
  // targets, and the block rule would collapse them all into one.
  const reachingIn = !isFolder && pointer.indentX >= (options.reachInPx ?? FOLDER_DROP_INDENT_PX)
  const perRow = reachingIn || originScope !== null

  let boundary = 0
  if (perRow) {
    for (let i = 0; i < rows.length; i += 1) {
      if ((rowBounds[i].top + rowBounds[i].bottom) / 2 < pointer.contentY) boundary = i + 1
    }
  } else {
    for (let i = 0; i < rows.length; i += 1) {
      // A member row is part of its folder's block; only block heads count.
      if (rows[i].depth === 1) continue
      const bound = blockBound(rows, rowBounds, i)
      if ((bound.top + bound.bottom) / 2 < pointer.contentY) boundary = blockEndRow(rows, i) + 1
    }
  }

  // ── …and at that boundary, is there a folder to go into? ─────────────────
  const above = boundary > 0 ? rows[boundary - 1] : null
  const below = boundary < rows.length ? rows[boundary] : null
  const candidate = isFolder
    ? null
    : above == null
      ? null
      : // Immediately under a folder's own heading — open or closed — means
        // "inside it". A closed one is still a destination; its members simply
        // are not on screen to aim between.
        above.track.kind === "folder"
        ? above.track.id
        : above.depth === 1
          ? trackScope(above.track, folderIds)
          : null

  // ── X ONLY GETS A VOTE WHERE BOTH ANSWERS ARE REAL ───────────────────────
  //
  // Sam, 2026-08-25: dragging a track around inside its own folder, drifting
  // left still offered to take it out — and releasing there did not do what the
  // line showed, it threw the track out of the folder and dropped it underneath.
  //
  // The cause was treating the horizontal position as the ONLY thing that
  // decides scope. It is not: at most heights the vertical position has already
  // decided, because there is no legal top-level insertion point BETWEEN a
  // folder's own rows. A boundary sitting immediately above a member row is
  // strictly interior to that member's folder, so "inside" is the only answer
  // and X is ignored. The genuinely ambiguous spot is the folder's END edge —
  // just past its last member, where "last inside" and "first after" are both
  // real — and that is where X still chooses. Above a folder's heading, or out
  // on open ground, there is no candidate at all and the answer is top level.
  //
  // This REMOVES A LIE rather than a capability: the left half of the gutter was
  // offering an outcome the drop would not perform.
  //
  // (Per-BLOCK stepping cannot land inside a folder — its boundaries are block
  // edges — so `below` is never a member row on that path and this changes
  // nothing about sliding past a folder you were only stepping over.)
  const interior = !isFolder && below?.depth === 1 ? trackScope(below.track, folderIds) : null

  let groupId: string | null = interior ?? (reachingIn ? candidate : null)
  // The gate. Not a refusal — a clamp — so the drag still works, it just cannot
  // change which folder anything is in.
  if (!options.allowCrossing) groupId = originScope

  // ── The order, within whichever scope won ────────────────────────────────
  const targetTracks: TimelineTrack[] =
    groupId == null
      ? rows.filter((r) => r.depth === 0).map((r) => r.track)
      : // A folder's members come off the folder ROW, not off the rendered
        // rows — that is the only way to place a drop into a CLOSED folder,
        // whose members are not on screen at all.
        [...(rows.find((r) => r.track.id === groupId)?.members ?? [])]

  const rest = targetTracks.filter((t) => t.id !== movedId)
  /** Where each remaining member of the target scope renders. -1 when it does
   *  not (a closed folder's members). */
  const restRowIndexes = rest.map((t) => rows.findIndex((r) => r.track.id === t.id))

  const folderRow = groupId == null ? null : rows.find((r) => r.track.id === groupId)
  const index = folderRow?.collapsed
    ? // Nothing of that folder is on screen, so there is no position to read
      // from the pointer. Append — the honest answer, and the same one the
      // menu's "new folder from these tracks" gives.
      rest.length
    : restRowIndexes.filter((i) => i >= 0 && i < boundary).length

  const placed = orderForInsert(rest, index)
  if (!placed) return null

  // NOTHING TO DO: the same scope, and the same gap it already occupies.
  // Measured in ROW space rather than by comparing orders — two tracks may
  // legitimately share an order, and the comparator's tie-break, not the
  // number, decides which is above.
  if (groupId === originScope) {
    const currentIndex = restRowIndexes.filter((i) => i >= 0 && i < fromRowIndex).length
    if (currentIndex === index) return null
  }

  const indicator =
    boundary < rows.length
      ? { rowIndex: boundary, edge: "top" as const, indent: groupId != null }
      : {
          rowIndex: rows.length - 1,
          edge: "bottom" as const,
          indent: groupId != null,
        }

  return { groupId, order: placed.order, needsRenormalise: placed.needsRenormalise, indicator }
}

export function dragScope(
  rows: readonly TrackRow[],
  rowBounds: readonly RowBound[],
  fromRowIndex: number,
): (ScopeSiblings & { bounds: RowBound[] }) | null {
  if (rowBounds.length !== rows.length) return null
  const scope = scopeSiblings(rows, fromRowIndex)
  if (!scope) return null
  return { ...scope, bounds: scope.rowIndexes.map((i) => blockBound(rows, rowBounds, i)) }
}

/**
 * The LAST rendered row belonging to a scope member's block — itself, or its
 * last visible member if it is an open folder.
 *
 * The drop indicator needs this for the one boundary that cannot be expressed
 * as "above row N": dropping at the very end of a scope. Drawn above the row
 * after the block, it would appear inside the folder it is meant to follow.
 */
export function blockEndRow(rows: readonly TrackRow[], rowIndex: number): number {
  if (rows[rowIndex]?.track.kind !== "folder") return rowIndex
  let end = rowIndex
  while (end + 1 < rows.length && rows[end + 1].depth === 1) end += 1
  return end
}

/** A top-level row's extent INCLUDING its visible members, so a folder is
 *  hit-tested as the block the user sees themselves dragging. */
function blockBound(
  rows: readonly TrackRow[],
  rowBounds: readonly RowBound[],
  index: number,
): RowBound {
  const bound = rowBounds[index]
  if (rows[index].track.kind !== "folder") return bound
  let bottom = bound.bottom
  for (let i = index + 1; i < rows.length && rows[i].depth === 1; i += 1) {
    bottom = rowBounds[i].bottom
  }
  return { top: bound.top, bottom }
}

/**
 * The `order` to give a track being moved INTO a scope — below everything
 * already there.
 *
 * Below rather than at a chosen position, deliberately: "Move to folder" is a
 * menu command with no pointer behind it, so there is no position to honour,
 * and the alternative (guessing the top) would bury whichever member the user
 * was looking at. They can drag it where they want afterwards, which is the
 * ungated gesture.
 *
 * Note the empty-scope answer is 0, not `-Infinity + 1`: a scope with nothing
 * in it starts counting at zero like any other list.
 */
export function orderForScopeAppend(
  tracks: readonly TimelineTrack[],
  groupId: string | null,
): number {
  const folderIds = folderIdsOf(tracks)
  let max = Number.NEGATIVE_INFINITY
  for (const track of tracks) {
    if (trackScope(track, folderIds) !== groupId) continue
    if (Number.isFinite(track.order) && track.order > max) max = track.order
  }
  return Number.isFinite(max) ? max + 1 : 0
}

/**
 * Every track that would go with a folder if it were deleted — its members.
 *
 * Named for the question the delete confirm has to answer, and it does NOT
 * recurse for the same reason nothing else here does: a folder's own `groupId`
 * is never read, so a folder cannot contain a folder and there is no second
 * level to find.
 */
export function folderMembers(
  tracks: readonly TimelineTrack[],
  folderId: string,
): TimelineTrack[] {
  const folderIds = folderIdsOf(tracks)
  return tracks.filter((track) => trackScope(track, folderIds) === folderId)
}
