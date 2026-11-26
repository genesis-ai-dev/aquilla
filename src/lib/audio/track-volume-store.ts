// AQU-2664: what a track's fader may hold and how it is STORED. The scale,
// the ticks, the readout and the typing are fader-scale.ts (shared with the
// AQU-2668 volume line and kept byte-for-byte as it is there); this is only
// what that module doesn't cover.
//
// STORED on the file's track (`file.track.set` patch `volumeDb`):
// - 0 dB: nothing (the patch sends null, which clears the key);
// - a level: the number, TRACK_VOLUME_FLOOR_DB…+6;
// - silence (−∞): the string "-inf".
// Not null for silence, as the volume line's points use: a track's overrides
// are merged with jsonb `||` + `jsonb_strip_nulls`, so a stored null is
// dropped and would read back as 0 dB. The sync worker validates these three
// (file-track-set.ts), and tracks.ts reads them (`overrideVolumeDb`). In memory
// silence is −Infinity, which the mixer and the exports turn into a gain of 0.

import { FADER_MAX_DB } from "./fader-scale"

/** The stored form of silence. */
export const SILENT_VOLUME = "-inf"
/** The quietest finite level kept; under it is −∞. (The fader's lowest pixel
 *  above the bottom reads about −67 dB; this only bounds typed values.) */
export const TRACK_VOLUME_FLOOR_DB = -150

/** A value the fader holds: −∞, or up to +6 dB to a tenth. Junk reads 0. */
export function clampTrackVolumeDb(db: number): number {
  if (db === -Infinity) return -Infinity
  if (!Number.isFinite(db)) return 0
  if (db < TRACK_VOLUME_FLOOR_DB) return -Infinity
  const r = Math.round(Math.min(FADER_MAX_DB, db) * 10) / 10
  return Object.is(r, -0) ? 0 : r
}

export function toStoredVolume(db: number): number | typeof SILENT_VOLUME | null {
  if (db === -Infinity) return SILENT_VOLUME
  return db === 0 ? null : db
}

/** A stored level back as dB (−Infinity for silence); undefined for none or junk. */
export function fromStoredVolume(value: unknown): number | undefined {
  if (value === SILENT_VOLUME || value === -Infinity) return -Infinity
  return typeof value === "number" && Number.isFinite(value) && value >= TRACK_VOLUME_FLOOR_DB && value <= FADER_MAX_DB ? value : undefined
}
