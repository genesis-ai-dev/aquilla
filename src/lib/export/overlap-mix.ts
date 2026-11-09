// AQU-2432 (Sam, Nov 6, rule 7): EXPORTS MIX AN OVERLAP EXACTLY AS YOU HEAR
// IT. Following the recordings a take can be dragged earlier, over the end of
// the take before it, and playback plays both at full volume, with no ducking
// and no cutting off. An export that joins takes end to end lays each one
// where playback starts it — some way before the end of the one before it —
// and SUMS the two where they overlap, held at full scale, as a mixer does.
//
// Every part is placed against the END OF THE PART BEFORE IT: `overlap` that
// much before it (never before the start of the file), else right at it. So a
// chain — a short take inside a long one, and the next over both — lands each
// take where playback has it, and the joined audio lasts to whichever part
// ends last.

/** One part to join: its audio and how far before the end of the part before
 *  it it starts (0: right at it). */
export interface MixPart<T> {
  audio: T
  overlap: number
}

/** Where each part starts, in samples, and how long the whole is. */
export function mixPlaces(parts: readonly { length: number; overlap: number }[]): { at: number[]; total: number } {
  const at: number[] = []
  let prevEnd = 0
  let total = 0
  for (const p of parts) {
    const start = Math.max(0, prevEnd - Math.max(0, p.overlap))
    at.push(start)
    prevEnd = start + p.length
    total = Math.max(total, prevEnd)
  }
  return { at, total }
}

/**
 * Float32 parts joined, overlaps summed. A list with no overlap is joined as
 * it always was (the parts end to end), into one array.
 */
export function mixPcm(parts: readonly MixPart<Float32Array>[]): Float32Array {
  const { at, total } = mixPlaces(parts.map((p) => ({ length: p.audio.length, overlap: p.overlap })))
  const out = new Float32Array(total)
  parts.forEach((p, i) => {
    const a = p.audio
    const o = at[i]
    // Summed, so a part over the end of the one before it is heard with it,
    // and one after a long part still running on is mixed in under it.
    for (let k = 0; k < a.length; k++) out[o + k] += a[k]
  })
  return out
}

const clamp16 = (v: number) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v)

/**
 * PCM16 parts in blob storage (AQU-1862: a whole file's audio is never held
 * on the heap), joined the same way: a part that starts where everything
 * before it has ended is handed on as the blob it is; the parts that sound
 * over one another — a take over the end of the one before it, or one that
 * starts while a long take before that is still running on — are read back
 * (only them, a few seconds at a time), summed, held at full scale, and handed
 * on as one blob.
 */
export class Pcm16Mixer {
  private readonly out: Blob[] = []
  /** What a later part may still sound over: one untouched blob, or several
   *  parts already mixed into one stretch. */
  private pending: { blob: Blob; samples: number } | { pcm: Int16Array<ArrayBuffer> } | null = null
  /** Where the last part ends inside `pending`, in samples. */
  private lastEnd = 0
  private written = 0

  /** Total samples handed on and pending. */
  get samples(): number {
    return this.written + this.pendingLength()
  }

  private pendingLength(): number {
    const p = this.pending
    return !p ? 0 : "pcm" in p ? p.pcm.length : p.samples
  }

  private flush(): void {
    const p = this.pending
    if (!p) return
    this.out.push("pcm" in p ? new Blob([p.pcm]) : p.blob)
    this.written += "pcm" in p ? p.pcm.length : p.samples
    this.pending = null
  }

  /**
   * Add a part `samples` long, starting `overlap` samples before the end of
   * the part before it (0: right at it). A caller may pass a negative overlap
   * — a part after the last one's end — only while it still starts inside
   * what is pending (`mixVoiceOverlaps`); otherwise parts follow one another.
   */
  async push(blob: Blob, samples: number, overlap: number): Promise<void> {
    const start = Math.max(0, this.lastEnd - overlap)
    if (!this.pending || start >= this.pendingLength()) {
      this.flush()
      this.pending = { blob, samples }
      this.lastEnd = samples
      return
    }
    const base = "pcm" in this.pending ? this.pending.pcm : await readPcm16(this.pending.blob, this.pending.samples)
    const pcm = base.length >= start + samples ? base : grow(base, start + samples)
    const add = await readPcm16(blob, samples)
    for (let k = 0; k < add.length; k++) pcm[start + k] = clamp16(pcm[start + k] + add[k])
    this.pending = { pcm }
    this.lastEnd = start + samples
  }

  /** Every part, as blobs to join in order. */
  finish(): Blob[] {
    this.flush()
    return this.out
  }
}

function grow(pcm: Int16Array<ArrayBuffer>, length: number): Int16Array<ArrayBuffer> {
  const out = new Int16Array(length)
  out.set(pcm)
  return out
}

async function readPcm16(blob: Blob, samples: number): Promise<Int16Array<ArrayBuffer>> {
  const buf = await blob.arrayBuffer()
  return new Int16Array(buf, 0, Math.min(samples, Math.floor(buf.byteLength / 2)))
}
