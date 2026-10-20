// On-device noise removal with RNNoise (@sapphi-red/web-noise-suppressor).
//
// The caller passes mono 48 kHz Float32 (see decode-mono.ts) — RNNoise's native
// format. We render that buffer through the RNNoise AudioWorklet *in real time*
// into a MediaRecorder, yielding a WebM/Opus blob that matches the format of
// our recorded takes. Real-time (not OfflineAudioContext) because
// RnnoiseWorkletNode requires a live AudioContext and assumes a 48 kHz rate.
// AQU-1575: a WAV take is collected off the same graph as PCM instead (the WAV
// recorder's capture worklet, see pcm-capture.ts), so it comes back a WAV.
//
// The library + its wasm/worklet assets are loaded lazily inside the worker
// path (dynamic import) so they're split out of the main bundle and never
// touched until a user actually removes noise — which also keeps this module's
// static graph free of `?url` asset imports that don't resolve under vitest.
//
// Browser-only — verified via the audio-mode UI walkthrough, not unit tests
// (same rationale as decode-mono.ts: Web Audio + AudioWorklet have no jsdom).

import type { RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor"
import { TARGET_RATE } from "./decode-mono"
import { tapPcm } from "./pcm-capture"
import { encodeWavPcm16Chunks, type Pcm16Chunk } from "./wav-encode"

// RNNoise has a short algorithmic delay; let the graph flush past the source's
// end before stopping the recorder so the tail of the clip isn't clipped.
const FLUSH_TAIL_MS = 300

interface RnnoiseModule {
  loadRnnoise: (opts: { url: string; simdUrl: string }) => Promise<ArrayBuffer>
  RnnoiseWorkletNode: typeof RnnoiseWorkletNode
  workletPath: string
  wasmUrl: string
  simdUrl: string
}

let modulePromise: Promise<RnnoiseModule> | null = null
function loadRnnoiseModule(): Promise<RnnoiseModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const [lib, worklet, wasm, simd] = await Promise.all([
        import("@sapphi-red/web-noise-suppressor"),
        import("@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url"),
        import("@sapphi-red/web-noise-suppressor/rnnoise.wasm?url"),
        import("@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url"),
      ])
      return {
        loadRnnoise: lib.loadRnnoise,
        RnnoiseWorkletNode: lib.RnnoiseWorkletNode,
        workletPath: (worklet as { default: string }).default,
        wasmUrl: (wasm as { default: string }).default,
        simdUrl: (simd as { default: string }).default,
      }
    })().catch((e) => {
      modulePromise = null
      throw e
    })
  }
  return modulePromise
}

// The wasm binary is identical for every clip — load it once and reuse.
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null
function getRnnoiseWasm(mod: RnnoiseModule): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = mod
      .loadRnnoise({ url: mod.wasmUrl, simdUrl: mod.simdUrl })
      .catch((e) => {
        // Don't cache a rejected promise — a transient failure shouldn't poison
        // every later attempt.
        wasmBinaryPromise = null
        throw e
      })
  }
  return wasmBinaryPromise
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

function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined
  const prefs = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ]
  for (const m of prefs) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return undefined
}

export interface DenoiseResult {
  blob: Blob
  /** Duration of the source clip in ms (the output matches it within the tail). */
  durationMs: number
  mimeType: string
}

/** True when this browser can run the denoiser (Web Audio + worklet + recorder). */
export function isDenoiseSupported(): boolean {
  if (typeof MediaRecorder === "undefined") return false
  const w = globalThis as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown }
  const Ctor = (w.AudioContext ?? w.webkitAudioContext) as
    | { prototype?: object }
    | undefined
  if (!Ctor || typeof Ctor.prototype === "undefined") return false
  // AudioWorklet is required; it lives on the context instance, so probe the
  // prototype rather than constructing a throwaway context here.
  return "audioWorklet" in Ctor.prototype
}

export interface DenoiseOptions {
  /**
   * AQU-1575: what the cleaned take is written as. "opus" (the default) is the
   * WebM/Opus every compressed take already is. "wav" captures the cleaned
   * audio as 16-bit mono PCM instead, so a WAV take is not downgraded to a
   * compressed one by having its noise removed.
   */
  output?: "opus" | "wav"
}

/**
 * Run RNNoise over a mono 48 kHz Float32 buffer and return a WebM/Opus blob,
 * or a 16-bit WAV with `output: "wav"`. Resolves once the full clip (plus a
 * short flush tail) has been recorded.
 */
export async function denoiseMono48k(
  samples: Float32Array,
  opts?: DenoiseOptions,
): Promise<DenoiseResult> {
  if (samples.length === 0) throw new Error("denoise: empty audio")
  const mod = await loadRnnoiseModule()
  const wasmBinary = await getRnnoiseWasm(mod)

  const Ctor = getAudioContextCtor()
  const ctx = new Ctor({ sampleRate: TARGET_RATE })
  let rnnoise: RnnoiseWorkletNode | null = null
  try {
    await ctx.audioWorklet.addModule(mod.workletPath)
    await ctx.resume()
    rnnoise = new mod.RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary })

    const buffer = ctx.createBuffer(1, samples.length, TARGET_RATE)
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer

    // AQU-1575: the WAV path taps RNNoise's output as PCM — MediaRecorder can
    // only write compressed audio. Same graph, same real-time render, same
    // flush tail; only what collects the result differs.
    if (opts?.output === "wav") {
      const tap = await tapPcm(ctx, rnnoise)
      source.connect(rnnoise)
      try {
        const chunks = await new Promise<Pcm16Chunk[]>((resolve, reject) => {
          source.onended = () => {
            setTimeout(() => tap.finish().then(resolve, reject), FLUSH_TAIL_MS)
          }
          source.start()
        })
        const frames = chunks.reduce((n, c) => n + c.length, 0)
        if (frames === 0) throw new Error("denoise: produced empty output")
        // AQU-927: ms values land in BIGINT columns — round at the source.
        const durationMs = Math.round((samples.length / TARGET_RATE) * 1000)
        // The context's REAL rate, as the live recorder writes it — a browser
        // that refused 48 kHz must not get a header claiming it.
        return { blob: encodeWavPcm16Chunks(chunks, ctx.sampleRate), durationMs, mimeType: "audio/wav" }
      } finally {
        tap.dispose()
      }
    }

    const dest = ctx.createMediaStreamDestination()
    // source → rnnoise → MediaStreamDestination. Not connected to
    // ctx.destination, so nothing plays aloud during processing.
    source.connect(rnnoise).connect(dest)

    const mimeType = pickRecorderMime()
    const rec = new MediaRecorder(dest.stream, mimeType ? { mimeType } : undefined)
    const chunks: BlobPart[] = []
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    // AQU-927: ms values land in BIGINT columns — round at the source. A raw
    // float here (e.g. 2403.5) makes Postgres reject the whole event batch.
    const durationMs = Math.round((samples.length / TARGET_RATE) * 1000)
    const blob = await new Promise<Blob>((resolve, reject) => {
      let flushTimer: ReturnType<typeof setTimeout> | null = null
      rec.onstop = () => {
        if (flushTimer) clearTimeout(flushTimer)
        resolve(new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" }))
      }
      rec.onerror = (e) => {
        if (flushTimer) clearTimeout(flushTimer)
        reject((e as unknown as { error?: Error }).error ?? new Error("MediaRecorder error"))
      }
      source.onended = () => {
        flushTimer = setTimeout(() => {
          if (rec.state !== "inactive") rec.stop()
        }, FLUSH_TAIL_MS)
      }
      rec.start()
      source.start()
    })

    if (blob.size === 0) throw new Error("denoise: produced empty output")
    return { blob, durationMs, mimeType: blob.type }
  } finally {
    rnnoise?.destroy()
    void ctx.close()
  }
}
