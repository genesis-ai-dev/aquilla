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
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor,
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

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type !== "flush") return
      // Stop first: the graph is still running while the host tears it down,
      // and a chunk posted after `done` would be dropped on the floor.
      this.stopped = true
      this.emit()
      this.port.postMessage({ done: true })
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return true
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
    this.port.postMessage({ pcm: out }, [out.buffer])
    // Transferring detaches the buffer, so a fresh one is mandatory, not
    // hygiene — writing into the old view after this would throw.
    this.buf = new Int16Array(CHUNK_SAMPLES)
    this.used = 0
  }
}

registerProcessor(PROCESSOR_NAME, PcmCaptureProcessor)
