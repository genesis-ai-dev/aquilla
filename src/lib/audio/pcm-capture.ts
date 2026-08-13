// Live PCM capture for WAV takes — the one thing MediaRecorder cannot do
// (isTypeSupported("audio/wav") is false in every browser), so takes recorded
// at WAV quality need their own path off the mic stream.
//
// AudioWorklet rather than ScriptProcessorNode: ScriptProcessor's callback
// runs on the MAIN thread, which during a take is also driving the waveform's
// rAF loop and React state. A buffer dropped there is an audible click baked
// permanently into a take the operator has already performed. The worklet runs
// on the audio thread and cannot be starved by rendering.
//
// Browser-only, and deliberately untested: happy-dom has no AudioContext and
// no AudioWorklet, the same reason denoise.ts and decode-mono.ts have never
// had unit tests. A fake would only test the fake.

import { WAV_SAMPLE_RATE } from "./recording-limits"
import type { Pcm16Chunk } from "./wav-encode"

// Must match PROCESSOR_NAME in pcm-capture.worklet.ts. Importing the constant
// from there is not an option: the worklet module calls registerProcessor at
// evaluation time, which throws anywhere but AudioWorkletGlobalScope.
const PROCESSOR_NAME = "aq-pcm-capture"

// A wedged worklet must not hang the take. 200ms is ~2 chunk periods, so a
// healthy flush always wins the race and a dead one costs the operator a fifth
// of a second rather than the whole recording.
const FLUSH_TIMEOUT_MS = 200

let modulePromise: Promise<string> | null = null
function loadWorkletUrl(): Promise<string> {
  if (!modulePromise) {
    modulePromise = (async () => {
      // The asset import lives inside this dynamic import on purpose: a static
      // `?url` import in a module the tests reach breaks vitest's resolver
      // (denoise.ts carries the same note). And `?worker&url`, never a bare
      // `?url` — the bare form would hand the browser this file's raw
      // TypeScript, which addModule cannot parse.
      const mod = await import("./pcm-capture.worklet?worker&url")
      return (mod as { default: string }).default
    })().catch((e) => {
      // Don't cache a rejected promise — one transient failure would otherwise
      // poison every later take on this page.
      modulePromise = null
      throw e
    })
  }
  return modulePromise
}

function getAudioContextCtor(): typeof AudioContext {
  const w = globalThis as unknown as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  const Ctor = w.AudioContext ?? w.webkitAudioContext
  if (!Ctor) throw new Error("Web Audio API is unavailable in this environment")
  return Ctor
}

/** True when this browser can capture PCM (Web Audio + AudioWorklet). */
export function isPcmCaptureSupported(): boolean {
  const w = globalThis as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown }
  const Ctor = (w.AudioContext ?? w.webkitAudioContext) as { prototype?: object } | undefined
  if (!Ctor || typeof Ctor.prototype === "undefined") return false
  if (typeof AudioWorkletNode === "undefined") return false
  // audioWorklet lives on the context instance, so probe the prototype rather
  // than constructing a throwaway context here (browsers cap ~6 per page).
  return "audioWorklet" in Ctor.prototype
}

/**
 * Warm the worklet so the pre-record countdown pays for it instead of the
 * operator. Never rejects — a failure here just means startPcmCapture takes
 * the hit (and, failing that, the caller falls back to MediaRecorder).
 *
 * Deliberately does NOT create an AudioContext: a cancelled countdown would
 * leak one, and browsers cap a page at roughly six.
 */
export async function preloadPcmCaptureModule(): Promise<void> {
  try {
    const url = await loadWorkletUrl()
    // Resolving the URL only loads Vite's tiny wrapper module; the worklet
    // chunk itself is not fetched until addModule asks for it. Pull it into
    // the HTTP cache now so that request is a cache hit mid-countdown.
    await fetch(url)
  } catch {
    // Ignore — startPcmCapture surfaces anything that actually matters.
  }
}

export interface PcmCaptureOptions {
  /** Live mic stream. Ownership stays with the caller: capture never stops
   *  the tracks, because the tracks must outlive the flush. */
  stream: MediaStream
  /** Stop-worthy sample count. onLimit fires once, when it is crossed. */
  maxFrames?: number
  onLimit?: () => void
}

export interface PcmCaptureHandle {
  /**
   * The context's REAL sample rate, which is what the WAV header must be
   * written from. Firefox may refuse the rate we ask for; a header that
   * hardcodes 48000 in that case makes every take play at the wrong pitch,
   * silently, and unrecoverably once it has been uploaded.
   */
  readonly sampleRate: number
  /** Samples captured so far; final once finish() resolves. */
  frames(): number
  /** Flush the worklet's partial buffer and tear the graph down. Resolves to
   *  every chunk captured, in order, ready for encodeWavPcm16Chunks. */
  finish(): Promise<Pcm16Chunk[]>
  /** Abandon the take. Safe to call at any point, including after finish(). */
  dispose(): void
}

/**
 * Start capturing mono PCM off `stream`.
 *
 * finish()'s ordering is load-bearing: flush the worklet, wait for its `done`,
 * and only then may the caller stop the mic tracks. Stopping the tracks first
 * loses the last ~85ms of every take — a clipped final word, on every single
 * recording, which is exactly the kind of defect nobody attributes to a
 * teardown ordering bug.
 */
export async function startPcmCapture(opts: PcmCaptureOptions): Promise<PcmCaptureHandle> {
  const url = await loadWorkletUrl()
  const Ctor = getAudioContextCtor()
  // 48 kHz is the rate every other audio path here assumes (decode-mono's
  // TARGET_RATE, the peaks cache, RNNoise). "interactive" keeps the render
  // quantum small so a stop lands promptly.
  const ctx = new Ctor({ sampleRate: WAV_SAMPLE_RATE, latencyHint: "interactive" })

  try {
    await ctx.audioWorklet.addModule(url)
    // A context can be born suspended when the page has not handled a gesture
    // yet. Without this the worklet never runs and the take is empty.
    if (ctx.state === "suspended") await ctx.resume()

    const source = ctx.createMediaStreamSource(opts.stream)
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      // Explicit mono: if the device hands us a stereo track, this downmixes
      // it. Reading channel 0 off an undownmixed pair would throw away half
      // the signal and sound thin rather than obviously wrong.
      channelCount: 1,
      channelCountMode: "explicit",
    })

    // The graph has to terminate somewhere for the worklet to be pulled, and
    // that somewhere is a MediaStreamDestination NOBODY LISTENS TO — never
    // ctx.destination behind a zero gain. A gain node wired to the speakers is
    // one typo, or one well-meaning refactor, away from howling feedback in a
    // live operator's headphones mid-session, with the mic's echo cancellation
    // switched off. Do not "simplify" this.
    const sink = ctx.createMediaStreamDestination()
    source.connect(node).connect(sink)

    const chunks: Pcm16Chunk[] = []
    let frames = 0
    let limitFired = false
    let resolveDone: (() => void) | null = null

    node.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as { pcm?: Pcm16Chunk; done?: boolean }
      if (msg.pcm) {
        chunks.push(msg.pcm)
        frames += msg.pcm.length
        if (!limitFired && opts.maxFrames !== undefined && frames >= opts.maxFrames) {
          limitFired = true
          opts.onLimit?.()
        }
      }
      if (msg.done) {
        const done = resolveDone
        resolveDone = null
        done?.()
      }
    }

    let torndown = false
    const teardown = () => {
      if (torndown) return
      torndown = true
      node.port.onmessage = null
      try { source.disconnect() } catch {}
      try { node.disconnect() } catch {}
      // Every exit path closes the context — finish, dispose, error. Browsers
      // cap a page at roughly six and the live waveform already builds one per
      // take, so a leak here costs the operator the recorder itself after a
      // handful of attempts.
      try { void ctx.close().catch(() => {}) } catch {}
    }

    let finishing: Promise<Pcm16Chunk[]> | null = null
    const finish = (): Promise<Pcm16Chunk[]> => {
      if (!finishing) {
        finishing = (async () => {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              resolveDone = null
              resolve()
            }, FLUSH_TIMEOUT_MS)
            resolveDone = () => {
              clearTimeout(timer)
              resolve()
            }
            try {
              node.port.postMessage({ type: "flush" })
            } catch {
              clearTimeout(timer)
              resolveDone = null
              resolve()
            }
          })
          teardown()
          return chunks
        })()
      }
      return finishing
    }

    return {
      sampleRate: ctx.sampleRate,
      frames: () => frames,
      finish,
      dispose: teardown,
    }
  } catch (e) {
    try { void ctx.close().catch(() => {}) } catch {}
    throw e
  }
}
