// Timeline Part B — sherpa-onnx WASM diarizer loader.
//
// Lazy-loads the (large, ~55 MB) sherpa-onnx speaker-diarization WASM bundle
// and exposes a typed `diarize(samples) -> turns`. The bundle is loaded ONLY
// when diarization is actually requested (opt-in quality path) — never part of
// the main app bundle.
//
// Loading mechanism (from the official sherpa-onnx wasm example): set a global
// `Module = { locateFile, onRuntimeInitialized }`, then inject the API wrapper
// script + the emscripten glue script. The glue fetches the `.wasm` + `.data`
// (models baked into `.data`) via `locateFile`, then fires
// `onRuntimeInitialized`, after which `createOfflineSpeakerDiarization(Module)`
// is available. Input MUST be 16 kHz mono Float32 (`sd.sampleRate`).
//
// NOTE: this first cut runs on the MAIN thread — `process()` is CPU-heavy and
// will block the UI for a few seconds on real clips. Moving it into a Web
// Worker is the next step (the `diarize()` interface stays identical, so the
// import-integration code won't change). Asset base URL defaults to the local
// `public/` copy; in prod it points at R2 (aquilla-ai-models).

import type { DiarizationTurn } from "./diarization"

/** Where the wasm bundle is served from. Local dev: Vite serves `public/` at
 *  root. Prod: an R2 (aquilla-ai-models) public URL, injected via env. */
export const DIARIZATION_ASSET_BASE =
  (import.meta.env?.VITE_DIARIZATION_ASSET_BASE as string | undefined) ?? "/sherpa-diarization/"

export interface DiarizeOptions {
  /** Known speaker count; -1 = auto-detect via `threshold`. Default -1. */
  numClusters?: number
  /** Clustering threshold when auto-detecting. Larger ⇒ fewer speakers. Default 0.5. */
  threshold?: number
}

export interface Diarizer {
  /** Native sample rate the model expects (16000). */
  readonly sampleRate: number
  /** Run diarization on 16 kHz mono PCM → speaker turns (ms). Empty if none. */
  diarize(samples16k: Float32Array, opts?: DiarizeOptions): DiarizationTurn[]
}

// The wasm globals are untyped; keep the `any` boundary narrow.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface SherpaWindow {
  Module?: any
  createOfflineSpeakerDiarization?: (m: any) => any
}

let diarizerPromise: Promise<Diarizer> | null = null

/** Load (once) and return the diarizer. Subsequent calls reuse the instance. */
export function loadDiarizer(baseUrl: string = DIARIZATION_ASSET_BASE): Promise<Diarizer> {
  if (diarizerPromise) return diarizerPromise
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("diarization requires a browser environment"))
  }
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`

  diarizerPromise = new Promise<Diarizer>((resolve, reject) => {
    const w = window as unknown as SherpaWindow
    w.Module = {
      locateFile: (path: string) => base + path,
      onRuntimeInitialized: () => {
        try {
          const factory = w.createOfflineSpeakerDiarization
          if (!factory) throw new Error("createOfflineSpeakerDiarization not found after wasm init")
          const sd = factory(w.Module)
          resolve(makeDiarizer(sd))
        } catch (err) {
          reject(err as Error)
        }
      },
    }
    // API wrapper first (defines the factory), then the emscripten glue.
    injectScript(`${base}sherpa-onnx-speaker-diarization.js`)
      .then(() => injectScript(`${base}sherpa-onnx-wasm-main-speaker-diarization.js`))
      .catch((err) => reject(err as Error))
  }).catch((err) => {
    diarizerPromise = null // allow retry after a failed load
    throw err
  })

  return diarizerPromise
}

function makeDiarizer(sd: any): Diarizer {
  return {
    sampleRate: sd.sampleRate,
    diarize(samples16k, opts = {}) {
      const numClusters = opts.numClusters ?? -1
      const threshold = opts.threshold ?? 0.5
      const config = sd.config
      config.clustering = { numClusters, threshold }
      sd.setConfig(config)
      const segments = sd.process(samples16k)
      if (segments == null) return []
      return segments.map((seg: { start: number; end: number; speaker: number }) => ({
        startMs: Math.round(seg.start * 1000),
        endMs: Math.round(seg.end * 1000),
        speaker: seg.speaker,
      }))
    },
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-sherpa="${src}"]`)
    if (existing) {
      resolve()
      return
    }
    const el = document.createElement("script")
    el.src = src
    el.async = true
    el.dataset.sherpa = src
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`failed to load ${src}`))
    document.head.appendChild(el)
  })
}
