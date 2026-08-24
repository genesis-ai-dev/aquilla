// AudioWorkletProcessor for WAV takes: buffers the mic input and posts it to
// the main thread as Int16.
//
// The Float32→Int16 conversion happens HERE, on the audio thread, not in
// pcm-capture.ts. A 15-minute take is 43.2M samples: accumulating Float32 on
// the main thread and converting at encode time peaks around 260 MB (the
// Float32 store, the Int16 copy, and the encode spike all alive at once),
// while converting up front holds a flat ~86 MB. Buffering to 4096 samples
// also cuts the message rate from one per 128-frame render quantum (~375/s) to
// ~12/s, and each one is handed over via the transfer list rather than
// structured-cloned.
//
// ZERO "@/" imports and no DOM: AudioWorklet.addModule() evaluates this file
// in AudioWorkletGlobalScope, which has no bundler runtime, no document and no
// fetch. Keeping it dependency-free is also what keeps Vite's emitted chunk a
// single self-contained file.

// AudioWorkletProcessor and registerProcessor are not in lib.dom.d.ts — TS has
// never shipped the worklet global scope. Declare the two members we touch;
// both are ambient and erase to nothing, which `erasableSyntaxOnly` requires.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(
  name: string,
  ctor: new (options?: unknown) => AudioWorkletProcessor,
): void

// Must match PROCESSOR_NAME in pcm-capture.ts. It cannot be a shared import:
// pulling this module into the main thread would run registerProcessor there,
// where it does not exist.
const PROCESSOR_NAME = "aq-pcm-capture"

// 4096 samples ≈ 85ms at 48 kHz — long enough to keep the message rate low,
// short enough that the flush watchdog in the host (200ms) always beats it.
const CHUNK_SAMPLES = 4096

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private buf = new Int16Array(CHUNK_SAMPLES)
  private used = 0
  private stopped = false
  // ARMED (AQU-646 take-shift fix): constructed with {processorOptions:
  // {armed: true}}, the processor runs but emits NOTHING until a "mark"
  // message arrives — the graph is brought up during the pre-record countdown
  // and GO becomes a bookmark instead of a starter pistol. Marking here, on
  // the audio thread, is what makes sample 0 land within one render quantum
  // (~2.7ms) of the GO instant; it also means the take can never contain the
  // countdown's own beeps — they end a second before zero, outside any ring
  // this file is allowed to keep. Without the option the processor emits from
  // construction, which is what the un-prewarmed fallback path and the
  // voice-clone recorder still rely on.
  //
  // PRE-ROLL (same day, round 3): while armed, the newest `preRollFrames` of
  // audio are KEPT in a ring rather than discarded, and the mark releases them
  // as the head of the take. An operator who has three steady beeps to come in
  // on will sometimes come in a breath EARLY — that is the count-in working,
  // not an error — and without the ring that attack is simply not in the file.
  // The exact frame count is reported with the mark so the host can anchor the
  // take that much earlier on the timeline: kept audio that ISN'T repositioned
  // would push everything late, which is the original take-shift bug wearing a
  // new hat.
  private waitingForMark: boolean
  private preRollFrames = 0
  private ring: Int16Array[] = []
  private ringFrames = 0

  constructor(options?: unknown) {
    super(options)
    const po = (options as { processorOptions?: { armed?: boolean; preRollFrames?: number } } | undefined)
      ?.processorOptions
    this.waitingForMark = po?.armed === true
    const pr = po?.preRollFrames
    this.preRollFrames = typeof pr === "number" && Number.isFinite(pr) && pr > 0 ? Math.floor(pr) : 0
    this.port.onmessage = (e: MessageEvent) => {
      const type = (e.data as { type?: string } | null)?.type
      if (type === "mark") {
        // Release the ring — oldest first — then the partial buffer, which
        // holds the newest pre-mark samples and is contiguous with what
        // process() captures next. Every sample kept is counted, and the count
        // travels with the mark: the host cannot anchor what it cannot measure.
        let kept = 0
        for (const chunk of this.ring) {
          kept += chunk.length
          this.port.postMessage({ pcm: chunk }, [chunk.buffer])
        }
        this.ring = []
        this.ringFrames = 0
        kept += this.used
        // Order matters: emit() ring-buffers while waiting, so the flag flips
        // FIRST and the partial buffer is posted, not re-ringed.
        this.waitingForMark = false
        this.emit()
        this.port.postMessage({ marked: true, preRollFrames: kept })
        return
      }
      if (type === "rearm") {
        // Back to ARMED for the next take — same processor, same graph, same
        // device stream. This exists because tearing the graph down between
        // takes is exactly the churn that makes the OS reconfigure the input:
        // Sam's takes came back with their first second at a fifteenth of its
        // real level while the device recovered from the previous take's
        // teardown. One graph per session; takes are cycles, not lifetimes.
        this.stopped = false
        this.waitingForMark = true
        this.used = 0
        this.ring = []
        this.ringFrames = 0
        return
      }
      if (type !== "flush") return
      // Stop first: the graph is still running while the host tears it down,
      // and a chunk posted after `done` would be dropped on the floor.
      this.stopped = true
      this.emit()
      this.port.postMessage({ done: true })
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return true
    if (this.waitingForMark && this.preRollFrames === 0) return true
    const channel = inputs[0]?.[0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        // Byte-identical to quantisePcm16 in wav-encode.ts — deliberately
        // duplicated, because this file cannot import anything. If the two
        // ever drift, a live take and an offline encode of the same audio
        // stop agreeing, silently.
        const v = channel[i]
        const s = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0
        this.buf[this.used++] = Math.round(s * (s < 0 ? 0x8000 : 0x7fff))
        if (this.used === this.buf.length) this.emit()
      }
    }
    // Always true: the host decides when capture ends (by disconnecting and
    // closing the context), and returning false would silently kill the
    // processor mid-take. Nothing is written to `outputs` — the sink is a
    // MediaStreamDestination nobody listens to.
    return true
  }

  private emit(): void {
    if (this.used === 0) return
    const full = this.used === this.buf.length
    const out = full ? this.buf : this.buf.slice(0, this.used)
    if (this.waitingForMark) {
      // Pre-mark with a pre-roll: ringed, not posted. Whole chunks are
      // evicted from the head while what remains still covers the request, so
      // the ring holds preRollFrames..preRollFrames+CHUNK_SAMPLES — the exact
      // kept count is what travels with the mark, so the slack is measured,
      // never guessed at.
      this.ring.push(out)
      this.ringFrames += out.length
      while (this.ring.length > 1 && this.ringFrames - this.ring[0].length >= this.preRollFrames) {
        this.ringFrames -= this.ring[0].length
        this.ring.shift()
      }
    } else {
      this.port.postMessage({ pcm: out }, [out.buffer])
    }
    // Transferring detaches the buffer, so a fresh one is mandatory, not
    // hygiene — writing into the old view after this would throw.
    this.buf = new Int16Array(CHUNK_SAMPLES)
    this.used = 0
  }
}

registerProcessor(PROCESSOR_NAME, PcmCaptureProcessor)
