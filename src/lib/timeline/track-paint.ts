// AQU-2492: a track write that is not a drag or a "Move to" — the Undo or Redo
// of one — drawn at once, through the same display overlays those paint.
//
// A move draws itself through an overlay that comes off only when the project
// read shows exactly the moved place. An Undo pressed straight after it goes
// out in the same batch as the move, so the read goes from "before" to
// "before" and never shows the moved place: without its own paint, the row
// stayed drawn moved after its Undo. Painting the Undo's target in the same
// way means the read that follows settles it, as it settles a move.
//
// One rule per patch:
// - null (the track is deleted): it leaves every overlay;
// - a track the read does not hold yet, with a kind: it is drawn as a new track;
// - a `groupId`: the track's place (folder and rank), which replaces any order
//   held for it, as a folder move does;
// - an `order` alone: its rank, and the rank of a folder move still held for it.

import { withPendingScopeOrders, withoutPendingOrder, type PendingTrackScope } from "./track-reorder"
import type { TimelineTrack, TrackKind } from "./tracks"

/** The fields a track write can name (the workspace's track patch). */
export interface TrackWritePatch {
  kind?: string
  name?: string | null
  order?: number | null
  groupId?: string | null
  color?: string | null
  sourceTrackId?: string | null
  contentFileId?: string | null
  setsLineLengths?: boolean | null
}

export interface TrackOverlays {
  orders: ReadonlyMap<string, number>
  scopes: ReadonlyMap<string, PendingTrackScope>
  newTracks: readonly TimelineTrack[]
}

type Write = { trackId: string; patch: TrackWritePatch | null }

interface Paint {
  gone: Set<string>
  orders: Map<string, number>
  scopes: Map<string, PendingTrackScope>
  newTracks: TimelineTrack[]
}

function paintFor(changes: readonly Write[], known: ReadonlySet<string>): Paint {
  const paint: Paint = { gone: new Set(), orders: new Map(), scopes: new Map(), newTracks: [] }
  for (const { trackId, patch } of changes) {
    if (patch === null) {
      paint.gone.add(trackId)
      continue
    }
    const order = typeof patch.order === "number" ? patch.order : null
    if (!known.has(trackId) && patch.kind) {
      paint.newTracks.push({
        id: trackId,
        kind: patch.kind as TrackKind,
        name: patch.name ?? "",
        order: order ?? 0,
        groupId: patch.groupId ?? null,
        ...(patch.color != null ? { color: patch.color } : {}),
        ...(patch.sourceTrackId != null ? { sourceTrackId: patch.sourceTrackId } : {}),
        ...(patch.contentFileId != null ? { contentFileId: patch.contentFileId } : {}),
        ...(patch.setsLineLengths === false ? { setsLineLengths: false as const } : {}),
      })
      continue
    }
    if (order === null) continue
    if ("groupId" in patch) paint.scopes.set(trackId, { groupId: patch.groupId ?? null, order })
    else paint.orders.set(trackId, order)
  }
  return paint
}

/** `known`: the ids the project read holds. */
export function paintTrackWrites(overlays: TrackOverlays, changes: readonly Write[], known: ReadonlySet<string>): TrackOverlays {
  const paint = paintFor(changes, known)
  let orders = new Map(overlays.orders)
  for (const id of [...paint.gone, ...paint.scopes.keys()]) orders = withoutPendingOrder(orders, id)
  for (const [id, order] of paint.orders) orders.set(id, order)
  const scopes = withPendingScopeOrders(overlays.scopes, [...paint.orders].map(([trackId, order]) => ({ trackId, order })))
  for (const id of paint.gone) scopes.delete(id)
  for (const [id, place] of paint.scopes) scopes.set(id, place)
  const replaced = new Set([...paint.gone, ...paint.newTracks.map((t) => t.id)])
  const newTracks = [...overlays.newTracks.filter((t) => !replaced.has(t.id)), ...paint.newTracks]
  return { orders, scopes, newTracks }
}

/**
 * The same write refused: its paint comes off where nothing newer replaced
 * it, and the read is the truth again. What it took away (a deleted track, a
 * move's place) is not put back; the read shows what the server kept.
 */
export function unpaintTrackWrites(overlays: TrackOverlays, changes: readonly Write[], known: ReadonlySet<string>): TrackOverlays {
  const paint = paintFor(changes, known)
  const orders = new Map(overlays.orders)
  for (const [id, order] of paint.orders) if (orders.get(id) === order) orders.delete(id)
  const scopes = new Map(overlays.scopes)
  for (const [id, place] of paint.scopes) {
    const held = scopes.get(id)
    if (held && held.groupId === place.groupId && held.order === place.order) scopes.delete(id)
  }
  const painted = new Set(paint.newTracks.map((t) => t.id))
  const newTracks = overlays.newTracks.filter((t) => !painted.has(t.id))
  return { orders, scopes, newTracks }
}
