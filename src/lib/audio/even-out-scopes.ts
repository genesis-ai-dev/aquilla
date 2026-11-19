// AQU-2664 (board 71): what the one Even out window offers — the whole file,
// one track, or the selected tracks — and where it starts, worked out from
// the cells that carry the file's takes and its tracks. Pure, so the window,
// the track headers' ≈ and the menus all count the same takes.

import type { CellData } from "@/hooks/useCells"
import { slotsForTrack } from "@/lib/timeline/track-slots"
import type { TimelineTrack } from "@/lib/timeline/tracks"
import { evenedTakesIn, evenStateOf, takesToEvenOut, type TakeRef } from "./even-out"

export type EvenOutPick = "file" | "track" | "sel"

export interface EvenOutScope {
  pick: EvenOutPick
  /** The tracks it covers, by name (empty for the whole file). */
  names: string[]
  /** How many tracks holding takes it covers. */
  trackCount: number
  takes: TakeRef[]
  /** The takes in it that are evened out (what Clear would take back). */
  evened: TakeRef[]
}

/** Where the window was opened from: the tracks it was opened on (none = the
 *  file menu) and the tracks selected on the timeline. */
export interface EvenOutRequest {
  trackIds: readonly string[]
  selection: readonly string[]
  /** Evidence 71F: the track whose ⋯ or ≈ opened it, when it was opened on a
   *  selection; offered on its own too. */
  from?: string
}

const mixKinds = new Set(["target-audio", "audio"])

function scopeOf(pick: EvenOutPick, cells: readonly CellData[], tracks: readonly TimelineTrack[]): EvenOutScope {
  const slots = tracks.flatMap((tr) => slotsForTrack(tr.id))
  return {
    pick,
    names: tracks.map((tr) => tr.name),
    trackCount: tracks.length,
    takes: takesToEvenOut(cells, { slots }),
    evened: evenedTakesIn(cells, { slots }),
  }
}

/** The audio tracks that hold takes, in the timeline's order. */
function tracksWithTakes(cells: readonly CellData[], tracks: readonly TimelineTrack[]): TimelineTrack[] {
  return tracks.filter((tr) => mixKinds.has(tr.kind) && takesToEvenOut(cells, { slots: slotsForTrack(tr.id) }).length > 0)
}

export function evenOutScopes(
  cells: readonly CellData[],
  tracks: readonly TimelineTrack[],
  req: EvenOutRequest,
): { scopes: EvenOutScope[]; start: EvenOutPick } {
  const holding = tracksWithTakes(cells, tracks)
  const byId = new Map(holding.map((tr) => [tr.id, tr]))
  const pickIn = (ids: readonly string[]) => holding.filter((tr) => ids.includes(tr.id))
  const file: EvenOutScope = { ...scopeOf("file", cells, holding), names: [], takes: takesToEvenOut(cells), evened: evenedTakesIn(cells) }
  const scopes: EvenOutScope[] = [file]
  const opened = pickIn(req.trackIds)
  const selected = pickIn(req.selection)
  // One track: the one it was opened on, else (from the file menu) the first
  // selected one.
  const one = opened.length === 1
    ? opened[0]
    : req.trackIds.length === 0
      ? (selected[0] ?? null)
      : (req.from ? (byId.get(req.from) ?? null) : null)
  if (one) scopes.push(scopeOf("track", cells, [byId.get(one.id)!]))
  // The selection: only while two or more tracks holding takes are selected
  // (opened on several tracks, those are the selection).
  const sel = opened.length >= 2 ? opened : selected.length >= 2 ? selected : null
  if (sel) scopes.push(scopeOf("sel", cells, sel))
  const start: EvenOutPick = opened.length >= 2 ? "sel" : opened.length === 1 ? "track" : "file"
  return { scopes, start }
}

/** Each track's ≈, for the tracks that hold takes (the others have no ≈). */
export function evenOutTrackStates(cells: readonly CellData[], tracks: readonly TimelineTrack[]): Map<string, "none" | "full" | "part"> {
  const out = new Map<string, "none" | "full" | "part">()
  for (const tr of tracksWithTakes(cells, tracks)) out.set(tr.id, evenStateOf(cells, slotsForTrack(tr.id)))
  return out
}
