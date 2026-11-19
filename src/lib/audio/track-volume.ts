// AQU-2664 (board 74): a track's own volume — the fader in its header.
//
// Stored on the file's track (`file.track.set` patch `volumeDb`, null = 0 dB),
// so it is SHARED: everyone hears it and every export applies it. It is the
// fourth stage of a take's level (take-gain.ts):
//
//     recording → evening out → the take's volume and fades → TRACK VOLUME
//               → main volume → peak guard
//
// Playback applies it in the mixer's track node (`setTrackGainDb`), and an
// export multiplies each clip by it (`withTrackVolumes` + clip-level.ts).
// Mute and solo are NOT here: they are personal (audibility.ts).

import type { CellData } from "@/hooks/useCells"
import { setTrackGainDb } from "./mixer"
import { slotsForTrack, trackIdForSlot } from "@/lib/timeline/track-slots"
import { overrideVolumeDb, type PersistedTrackOverrides, type TimelineTrack } from "@/lib/timeline/tracks"

export const TRACK_VOLUME_MIN_DB = -60
export const TRACK_VOLUME_MAX_DB = 6

/** Board 74's fader scale: dB → position 0..1 across the groove, linear
 *  between these stops (Logic's taper, roughly). */
const FADER_STOPS: ReadonlyArray<readonly [number, number]> = [
  [-60, 0], [-48, 0.08], [-36, 0.17], [-24, 0.3], [-18, 0.39], [-12, 0.5], [-6, 0.65], [0, 0.82], [6, 1],
]

export function faderPos(db: number): number {
  if (db <= FADER_STOPS[0][0]) return 0
  for (let i = 1; i < FADER_STOPS.length; i++) {
    const [b, pb] = FADER_STOPS[i]
    if (db <= b) {
      const [a, pa] = FADER_STOPS[i - 1]
      return pa + ((db - a) / (b - a)) * (pb - pa)
    }
  }
  return 1
}

export function faderDb(pos: number): number {
  if (pos <= 0) return TRACK_VOLUME_MIN_DB
  for (let i = 1; i < FADER_STOPS.length; i++) {
    const [b, pb] = FADER_STOPS[i]
    if (pos <= pb) {
      const [a, pa] = FADER_STOPS[i - 1]
      return a + ((pos - pa) / (pb - pa)) * (b - a)
    }
  }
  return TRACK_VOLUME_MAX_DB
}

/** A value the fader can hold: −60…+6, to a tenth of a dB; junk reads 0. */
export function clampTrackVolumeDb(db: number): number {
  if (!Number.isFinite(db)) return 0
  const r = Math.round(Math.min(TRACK_VOLUME_MAX_DB, Math.max(TRACK_VOLUME_MIN_DB, db)) * 10) / 10
  return Object.is(r, -0) ? 0 : r
}

const sign = (r: number) => (r > 0 ? "+" : r < 0 ? "−" : "")

/** The fader's readout: "0.0 dB", "−4.5 dB", "+2.0 dB". */
export function formatFaderDb(db: number): string {
  const r = Math.round(db * 10) / 10
  return `${sign(r)}${Math.abs(r).toFixed(1)} dB`
}

/** A take's own volume as the Station line reads it: "0 dB", "−2 dB", "+1.5 dB". */
export function formatOwnVolume(db: number): string {
  const r = Math.round(db * 10) / 10
  const n = Math.abs(r)
  return `${sign(r)}${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1)} dB`
}

/** Hand each audio track's volume to the mixer, under every slot it plays on. */
export function applyTrackVolumes(tracks: readonly TimelineTrack[]): void {
  for (const tr of tracks) {
    if (tr.kind !== "audio" && tr.kind !== "target-audio") continue
    for (const slot of slotsForTrack(tr.id)) setTrackGainDb(slot, tr.volumeDb ?? 0)
  }
}

/** The stored volume of the track a slot belongs to, dB (0 when none). */
export function trackVolumeForSlot(overrides: PersistedTrackOverrides | null | undefined, slot: string): number {
  return overrideVolumeDb(overrides?.[trackIdForSlot(slot)]?.volumeDb) ?? 0
}

/** The tracks' volumes in the stored shape `withTrackVolumes` reads, for a
 *  caller holding the drawn tracks rather than the file's overrides. */
export function trackVolumeOverrides(tracks: readonly TimelineTrack[] | null | undefined): PersistedTrackOverrides {
  const out: PersistedTrackOverrides = {}
  for (const tr of tracks ?? []) if (tr.volumeDb) out[tr.id] = { volumeDb: tr.volumeDb }
  return out
}

/**
 * For an export: the cells with each take stamped with its track's volume
 * (`trackGainDb`, read by clip-level.ts). Copies only what changes; the same
 * array back when no track has a volume.
 */
export function withTrackVolumes(cells: CellData[], overrides: PersistedTrackOverrides | null | undefined): CellData[] {
  if (!overrides || !Object.values(overrides).some((p) => overrideVolumeDb(p?.volumeDb))) return cells
  return cells.map((cell) => {
    const atts = cell.attachments
    if (!atts) return cell
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [id, att] of Object.entries(atts)) {
      const db = att && att.role !== "source" ? trackVolumeForSlot(overrides, att.slot ?? "recording") : 0
      if (db) {
        next[id] = { ...att, trackGainDb: db }
        changed = true
      } else next[id] = att
    }
    return changed ? ({ ...cell, attachments: next } as CellData) : cell
  })
}

/** A volume written here that the project read hasn't shown yet: drawn now,
 *  so the fader doesn't jump back while the write travels. */
export function applyPendingVolumes(tracks: TimelineTrack[], pending: ReadonlyMap<string, number>): TimelineTrack[] {
  if (pending.size === 0) return tracks
  return tracks.map((tr) => {
    if (!pending.has(tr.id)) return tr
    const db = pending.get(tr.id)!
    const next = { ...tr }
    if (db) next.volumeDb = db
    else delete next.volumeDb
    return next
  })
}

/** The pending volumes the read now shows (or overrules): drop these. */
export function settledPendingVolumes(pending: ReadonlyMap<string, number>, tracks: readonly TimelineTrack[]): string[] {
  const out: string[] = []
  for (const [id, db] of pending) {
    const tr = tracks.find((t) => t.id === id)
    if (!tr || (tr.volumeDb ?? 0) === db) out.push(id)
  }
  return out
}
