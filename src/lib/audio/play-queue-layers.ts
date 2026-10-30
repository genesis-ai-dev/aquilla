// AQU-2252: a programme's LAYERS as the transport schedules them while a file
// follows its recordings — the takes on its other tracks, each with its own
// length and its own place on the programme clock (lib/timeline/programme's
// `ProgrammeLayer`, placed against its line).
//
// Pure: what is laid where, what sounds at a moment, what holds a line, what
// starts next. The transport (play-queue.ts) owns the players, the clock and
// the timers, and asks these on every 60 ms boundary check, so every question
// here is a binary search over the layers' starts, never a walk of all of
// them: a book can carry a layer under thousands of lines.

import type { CellData } from "@/hooks/useCells"
import type { Programme } from "@/lib/timeline/programme"

export interface ProgLayerRef {
  cellId: string
  /** Its line as the transport was handed it — what its player is made from. */
  cell: CellData
  slot: string
  audioId: string
  url: string
  /** Where it starts and stops sounding, on the programme clock. */
  startSec: number
  endSec: number
  /** Its window on its own clip's clock. */
  window: { start: number; end: number }
}

export interface LayerSchedule {
  /** Every playable layer, soonest first. */
  readonly layers: readonly ProgLayerRef[]
  /** The longest of them. Anything sounding at a moment started no more than
   *  this before it, which bounds every search to a window of starts. */
  readonly maxLenSec: number
}

export const NO_LAYERS: LayerSchedule = { layers: [], maxLenSec: 0 }

/** Slack on the search window's far edge, for sums that round differently. */
const EPS_SEC = 1e-6

export function buildLayerSchedule(prog: Programme | null, cells: readonly CellData[]): LayerSchedule {
  if (!prog) return NO_LAYERS
  const byId = new Map(cells.map((c) => [c.id, c]))
  const layers: ProgLayerRef[] = []
  let maxLenSec = 0
  for (const slot of prog.slots) {
    const cell = slot.layers ? byId.get(slot.cellId) : undefined
    if (!cell) continue
    for (const l of slot.layers ?? []) {
      // No honest length → nothing honest to play, the main take's rule too.
      const url = cell.attachments?.[l.audioId]?.url
      if (!l.window || !url) continue
      const startSec = slot.startSec + l.atSec
      const lenSec = l.window.end - l.window.start
      maxLenSec = Math.max(maxLenSec, lenSec)
      layers.push({
        cellId: slot.cellId, cell, slot: l.slot, audioId: l.audioId, url,
        startSec, endSec: startSec + lenSec, window: l.window,
      })
    }
  }
  if (layers.length === 0) return NO_LAYERS
  return { layers: layers.sort((a, b) => a.startSec - b.startSec), maxLenSec }
}

/** The index of the first layer that starts after `sec` — or at it, with
 *  `orAt` (the length when none does). */
export function layerIndexAfter(s: LayerSchedule, sec: number, orAt = false): number {
  let lo = 0
  let hi = s.layers.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const start = s.layers[mid].startSec
    if (orAt ? start < sec : start <= sec) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The layers sounding at `atSec`, soonest first: started (or within
 *  `earlySec` of their start) and not over. */
export function layersDueAt(s: LayerSchedule, atSec: number, earlySec: number): ProgLayerRef[] {
  const out: ProgLayerRef[] = []
  const end = layerIndexAfter(s, atSec + earlySec)
  for (let i = layerIndexAfter(s, atSec - s.maxLenSec - EPS_SEC); i < end; i++) {
    if (atSec < s.layers[i].endSec) out.push(s.layers[i])
  }
  return out
}

/** Does any layer sound somewhere in [fromSec, toSec)? */
export function layersSoundIn(s: LayerSchedule, fromSec: number, toSec: number): boolean {
  const end = layerIndexAfter(s, toSec, /* orAt */ true)
  for (let i = layerIndexAfter(s, fromSec - s.maxLenSec - EPS_SEC); i < end; i++) {
    if (s.layers[i].endSec > fromSec) return true
  }
  return false
}
