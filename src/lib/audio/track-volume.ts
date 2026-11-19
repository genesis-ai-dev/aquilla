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
// −∞ (stored "-inf") is silence in both: a gain of 0.
// Mute and solo are NOT here: they are personal (audibility.ts).

import type { CellData } from "@/hooks/useCells"
import { setTrackGainDb } from "./mixer"
import { slotsForTrack, trackIdForSlot } from "@/lib/timeline/track-slots"
import { overrideVolumeDb, type PersistedTrackOverrides, type TimelineTrack } from "@/lib/timeline/tracks"
import { toStoredVolume } from "./track-volume-store"

// The fader's scale, its typing and its readout live in fader-scale.ts; what
// it holds and how that is stored, in track-volume-store.ts.

const sign = (r: number) => (r > 0 ? "+" : r < 0 ? "−" : "")

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
  for (const tr of tracks ?? []) {
    const stored = tr.volumeDb ? toStoredVolume(tr.volumeDb) : null
    if (stored != null) out[tr.id] = { volumeDb: stored }
  }
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
