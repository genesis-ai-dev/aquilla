// A take's volume and fades in an export (AQU-2327, slice 8): the same numbers
// the playback mixer applies (lib/audio/mixer.ts), so an export sounds like
// the timeline. Applied to a clip's KEPT part (after its trim), whose start and
// end are where the fades run from and to.

export interface ClipLevelFields {
  gainDb?: number | null
  fadeInMs?: number | null
  fadeOutMs?: number | null
}

/** Does this take play at anything other than its recorded level? */
export function hasClipLevel(att: ClipLevelFields | null | undefined): boolean {
  return Boolean(att && ((att.gainDb ?? 0) !== 0 || (att.fadeInMs ?? 0) > 0 || (att.fadeOutMs ?? 0) > 0))
}

/** Just the level fields, for carrying on an export's own clip records. */
export function levelFields(att: ClipLevelFields | null | undefined): ClipLevelFields {
  return hasClipLevel(att) ? { gainDb: att!.gainDb ?? null, fadeInMs: att!.fadeInMs ?? null, fadeOutMs: att!.fadeOutMs ?? null } : {}
}

/** The kept part with its volume and fades applied (a copy); untouched when flat. */
export function applyClipLevelPcm(kept: Float32Array, rate: number, att: ClipLevelFields | null | undefined): Float32Array {
  if (!hasClipLevel(att)) return kept
  const g = Math.pow(10, (att!.gainDb ?? 0) / 20)
  const fin = Math.round(((att!.fadeInMs ?? 0) / 1000) * rate)
  const fout = Math.round(((att!.fadeOutMs ?? 0) / 1000) * rate)
  const n = kept.length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let f = g
    if (fin > 0 && i < fin) f *= i / fin
    if (fout > 0 && i > n - fout) f *= Math.max(0, (n - i) / fout)
    out[i] = kept[i] * f
  }
  return out
}

/**
 * Where clips SUM (the by-character stems), a peak guard instead of a hard
 * clip: unchanged up to -1 dBFS, then a smooth knee that never passes full
 * scale. Raised takes overlap more often than recorded ones clipped.
 */
export function guardPeak(x: number): number {
  const T = 0.891 // -1 dBFS
  const a = Math.abs(x)
  if (a <= T) return x
  const over = (a - T) / (1 - T)
  return Math.sign(x) * (T + (1 - T) * Math.tanh(over))
}
