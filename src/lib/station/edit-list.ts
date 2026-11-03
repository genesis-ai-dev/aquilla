// The Station's edit engine (AQU-2327). Ported from the working build on the
// Media Redesign canvas (board 40b, `station-build/station.logic.js`), where
// Sam tried it with real sound.
//
// A recording being edited is its ORIGINAL audio plus an ordered list of
// operations over it. Nothing here touches samples: the operations become a
// list of segments (which stretch of which source plays when), and the
// waveform, playback, the History rows and the saved version all read that
// same list. Deleting a part closes the gap; inserting audio pushes what
// follows later. Times are seconds on the recording's own clock.
//
// The clip's own settings — its trim (Start/End), fades and volume — are not
// operations: they never change the recording (40b's History footnote), so
// they live beside the list, and `shiftTime` keeps a trim on the same sound
// when an operation moves it.

/** A deleted part, in the edited recording's seconds when it was made. */
export interface DeleteOp {
  kind: "del"
  a: number
  b: number
}

/** Audio inserted at `at`, from another source (a take, a file, a recording). */
export interface InsertOp {
  kind: "ins"
  at: number
  /** The source's key; whoever renders or draws resolves it to samples. */
  src: string
  /** Its length in seconds. */
  len: number
  /** What it is, for the History row and the mark's tooltip. */
  label: string
}

export type EditOp = DeleteOp | InsertOp

/** One stretch of one source, in that source's own seconds. */
export interface Segment {
  src: string
  a: number
  b: number
  /** Set on inserted audio: its label. */
  ins?: string
}

/** A segment with where it sits in the edited recording. */
export interface PlacedSegment extends Segment {
  t0: number
  t1: number
}

const EPS = 1e-4

/** The recording as it stands after `ops`: its segments, in order. */
export function segmentsOf(baseSrc: string, baseDur: number, ops: readonly EditOp[]): Segment[] {
  let segs: Segment[] = [{ src: baseSrc, a: 0, b: Math.max(0, baseDur) }]
  for (const op of ops) {
    const out: Segment[] = []
    let t = 0
    if (op.kind === "del") {
      for (const g of segs) {
        const ga = t
        const gb = t + (g.b - g.a)
        if (gb <= op.a || ga >= op.b) out.push(g)
        else {
          if (op.a > ga) out.push({ ...g, b: g.a + (op.a - ga) })
          if (op.b < gb) out.push({ ...g, a: g.a + (op.b - ga) })
        }
        t = gb
      }
    } else {
      let done = false
      for (const g of segs) {
        const ga = t
        const gb = t + (g.b - g.a)
        if (!done && op.at >= ga && op.at <= gb) {
          if (op.at > ga) out.push({ ...g, b: g.a + (op.at - ga) })
          out.push({ src: op.src, a: 0, b: op.len, ins: op.label })
          if (op.at < gb) out.push({ ...g, a: g.a + (op.at - ga) })
          done = true
        } else out.push(g)
        t = gb
      }
      if (!done) out.push({ src: op.src, a: 0, b: op.len, ins: op.label })
    }
    segs = out
  }
  return segs.filter((g) => g.b - g.a > EPS)
}

export function lengthOf(segs: readonly Segment[]): number {
  let t = 0
  for (const g of segs) t += g.b - g.a
  return t
}

/** Where each segment sits in the edited recording. */
export function placeSegments(segs: readonly Segment[]): PlacedSegment[] {
  let t = 0
  return segs.map((g) => {
    const r = { ...g, t0: t, t1: t + (g.b - g.a) }
    t = r.t1
    return r
  })
}

/**
 * Where a moment of the recording ends up after one operation, so a trim (or
 * another placement's window) keeps the same sound. A moment inside a deleted
 * part lands where the part was. A moment after an insert point moves later
 * by the inserted length; one exactly at the point stays, so audio inserted at
 * Start is kept (40b's rule).
 */
export function shiftTime(t: number, op: EditOp): number {
  if (op.kind === "del") {
    const len = op.b - op.a
    return t <= op.a ? t : t >= op.b ? t - len : op.a
  }
  return op.at < t ? t + op.len : t
}

/** A window of the recording before `ops`, mapped through all of them. */
export function mapWindow(w: { start: number; end: number }, ops: readonly EditOp[]): { start: number; end: number } {
  let { start, end } = w
  for (const op of ops) {
    start = shiftTime(start, op)
    end = shiftTime(end, op)
  }
  return { start, end: Math.max(start, end) }
}

/** The joins a delete left inside one source, in the edited recording's seconds. */
export function joinsOf(placed: readonly PlacedSegment[]): number[] {
  const out: number[] = []
  for (let i = 1; i < placed.length; i++) {
    const p = placed[i - 1]
    const g = placed[i]
    if (!g.ins && !p.ins && p.src === g.src && Math.abs(p.b - g.a) > 1e-3) out.push(g.t0)
  }
  return out
}

/** The clip's own settings: they shape what plays, never the recording. */
export interface ClipMix {
  /** The kept part (Start and End), seconds. */
  trimA: number
  trimB: number
  /** Fade lengths, seconds; 0 = none. */
  fadeIn: number
  fadeOut: number
  /** Volume in dB; 0 = as recorded. */
  gainDb: number
}

export function dbToGain(db: number): number {
  return Math.pow(10, (db || 0) / 20)
}

/** The clip's level at time `t`: its volume, then the fades inside the kept part. */
export function gainAt(t: number, clip: ClipMix): number {
  let g = dbToGain(clip.gainDb)
  if (clip.fadeIn > 0 && t < clip.trimA + clip.fadeIn) g *= Math.max(0, (t - clip.trimA) / clip.fadeIn)
  if (clip.fadeOut > 0 && t > clip.trimB - clip.fadeOut) g *= Math.max(0, (clip.trimB - t) / clip.fadeOut)
  return g
}

/** The shortest kept part a trim may leave (40b). */
export const MIN_KEPT_SEC = 0.05

/** Start and End held inside the recording and apart by MIN_KEPT_SEC. A
 *  negative End means "the recording's end". */
export function clampTrim(trimA: number, trimB: number, length: number): { trimA: number; trimB: number } {
  const L = Math.max(MIN_KEPT_SEC, length)
  const a = Math.max(0, Math.min(trimA, L - MIN_KEPT_SEC))
  const b = trimB < 0 ? L : Math.max(a + MIN_KEPT_SEC, Math.min(trimB, L))
  return { trimA: a, trimB: b }
}

export const round2 = (x: number): number => Math.round(x * 100) / 100
export const round3 = (x: number): number => Math.round(x * 1000) / 1000
