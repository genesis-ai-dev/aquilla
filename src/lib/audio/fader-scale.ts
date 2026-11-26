// AQU-2668 (Sam, Nov 19): Logic's fader scale and the one parser for a typed
// level — shared by the volume line's display (a point's height, its value
// box) and, once it moves over, the track header's fader (AQU-2664, board 74,
// whose `faderPos`/`faderDb` in track-volume.ts stop at −60 dB and whose
// double-click parser is private to TrackMixControls).
//
// THE SCALE. Position 0…1, bottom to top. Most of the height (70%) covers
// +6 to −20 dB, where people work; below that it compresses, linear between
// the stops down to −60 dB, then falls away toward −∞ at the very bottom.
// Pure, no imports.

/** dB → position, linear between these stops (Logic's taper, roughly). */
const STOPS: ReadonlyArray<readonly [number, number]> = [
  [6, 1], [0, 0.86], [-3, 0.78], [-6, 0.7], [-10, 0.6], [-15, 0.45], [-20, 0.3], [-30, 0.18], [-40, 0.11], [-60, 0.04],
]
const LOWEST_STOP = STOPS[STOPS.length - 1]

/** The loudest level the scale (and a typed value) holds, dB. */
export const FADER_MAX_DB = 6

/** dB → position 0…1; −∞ (silence) is the bottom, +6 and above the top. */
export function faderPos(db: number): number {
  if (Number.isNaN(db)) return 0
  if (db >= STOPS[0][0]) return 1
  if (db === -Infinity) return 0
  for (let i = 1; i < STOPS.length; i++) {
    const [b, pb] = STOPS[i]
    if (db >= b) {
      const [a, pa] = STOPS[i - 1]
      return pb + ((db - b) / (a - b)) * (pa - pb)
    }
  }
  // Below −60: toward the bottom as the gain itself falls away.
  return LOWEST_STOP[1] * Math.pow(10, (db - LOWEST_STOP[0]) / 20)
}

/** Position 0…1 → dB; the bottom is −∞ (silence). */
export function faderDb(pos: number): number {
  if (!(pos > 0)) return -Infinity
  if (pos >= 1) return FADER_MAX_DB
  for (let i = 1; i < STOPS.length; i++) {
    const [b, pb] = STOPS[i]
    if (pos >= pb) {
      const [a, pa] = STOPS[i - 1]
      return b + ((pos - pb) / (pa - pb)) * (a - b)
    }
  }
  return LOWEST_STOP[0] + 20 * Math.log10(pos / LOWEST_STOP[1])
}

const MINUS = "−"

/** The usual ticks, top to bottom, with their labels and positions. */
export const FADER_TICKS: ReadonlyArray<{ db: number; label: string; pos: number }> = [6, 0, -3, -6, -10, -15, -20, -30, -40, -60, -Infinity].map((db) => ({
  db,
  label: db === -Infinity ? `${MINUS}∞` : db > 0 ? `+${db}` : db < 0 ? `${MINUS}${-db}` : "0",
  pos: faderPos(db),
}))

/** A level as it is shown and typed back: "−∞ dB", "−3.5 dB", "+2.0 dB", "0.0 dB". */
export function formatDbValue(db: number): string {
  if (db === -Infinity) return `${MINUS}∞ dB`
  const r = Math.round(db * 10) / 10
  const sign = r > 0 ? "+" : r < 0 ? MINUS : ""
  return `${sign}${Math.abs(r).toFixed(1)} dB`
}

const TYPED = /^\s*([+\-−–]?)\s*(\d+(?:[.,]\d*)?|[.,]\d+|inf(?:inity)?|∞)\s*(?:db)?\s*$/i

/**
 * A typed level, dB, or null for junk. Takes "−3.5", "-3.5", "+2", "-3,5 dB",
 * and silence as "-inf", "−∞" or "-infinity" (an infinity needs its sign:
 * bare "inf" is refused). Held at +6 at the top ("+inf" reads +6); silence
 * reads −Infinity, which a line stores as `db: null` (`storedPointDb`).
 */
export function parseDbValue(text: string): number | null {
  const m = TYPED.exec(text)
  if (!m) return null
  const [, sign, body] = m
  const negative = sign !== "" && sign !== "+"
  if (/^(inf|∞)/i.test(body)) {
    if (!sign) return null
    return negative ? -Infinity : FADER_MAX_DB
  }
  const n = Number.parseFloat(body.replace(",", "."))
  if (!Number.isFinite(n)) return null
  const v = negative ? -n : n
  return Object.is(v, -0) ? 0 : Math.min(FADER_MAX_DB, v)
}
