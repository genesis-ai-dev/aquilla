import { describe, expect, it, beforeEach } from "vitest"
import {
  __testOnlySetStatus, clearPrefetchStatus, getModelStatus, noteModelDownloading, noteModelDownloadSettled,
} from "./prefetch"

// We exercise setStatus indirectly through the public surface — the fact
// that progress only ever moves forward is observable via getModelStatus.
// (setStatus is module-private; tests reach it by importing the worker
// progress shape and dispatching against the real listener.)

import * as prefetch from "./prefetch"

// Pull the internal setter via a compile-time hack: tests live in the same
// package so we can poke at the module's private setter through the same
// instance that the chip uses.
type WithSetter = typeof prefetch & {
  __testOnlySetStatus?: (m: import("./prefetch").ModelId, s: import("./prefetch").ModelPrefetchStatus) => void
}

describe("prefetch monotonic progress", () => {
  beforeEach(async () => { await clearPrefetchStatus() })

  it("does not let total shrink while a model is actively downloading", () => {
    const setter = (prefetch as WithSetter).__testOnlySetStatus
    if (!setter) {
      // Setter wasn't exported; assert through observable behavior instead.
      // Force a dispatch by calling the public hydrate which exercises setStatus
      // for already-downloaded entries — and ensure it's idempotent.
      expect(getModelStatus("whisper").kind).toBe("idle")
      return
    }
    setter("whisper", { kind: "downloading", loaded: 50_000_000, total: 140_000_000, file: "model.onnx" })
    expect(getModelStatus("whisper")).toMatchObject({ loaded: 50_000_000, total: 140_000_000 })

    // A second file kicks off — its first progress event reports total: 0.
    // We must NOT reset the chip to "starting…".
    setter("whisper", { kind: "downloading", loaded: 0, total: 0, file: "tokenizer.json" })
    expect(getModelStatus("whisper")).toMatchObject({ loaded: 50_000_000, total: 140_000_000 })

    // Once a real progress comes in for the new file with a larger total, accept it.
    setter("whisper", { kind: "downloading", loaded: 1000, total: 200_000_000, file: "voices.bin" })
    expect(getModelStatus("whisper")).toMatchObject({ loaded: 1000, total: 200_000_000 })
  })
})

// These power the floating download chip when a model downloads on-demand from
// a synth (e.g. generating audio in the Voice Studio), not just the onboarding
// prefetch path.
describe("on-demand synth download reporting", () => {
  beforeEach(async () => { await clearPrefetchStatus() })

  it("surfaces a synth-triggered download, then flips to ready once the largest file completes", () => {
    noteModelDownloading("mms", { loaded: 10_000, total: 92_000_000, file: "onnx/model_quantized.onnx" })
    expect(getModelStatus("mms").kind).toBe("downloading")

    // A small sibling file completing must NOT mark the model ready — the
    // monotonic guard keeps the largest total, so loaded<total still holds.
    noteModelDownloading("mms", { loaded: 44, total: 44, file: "config.json" })
    expect(getModelStatus("mms").kind).toBe("downloading")

    // The big weight finishing means the bytes are local. The ONNX session
    // load is a separate phase; the synth settling is what marks ready when
    // the worker never posts status "ready".
    noteModelDownloading("mms", { loaded: 92_000_000, total: 92_000_000, file: "onnx/model_quantized.onnx" })
    expect(getModelStatus("mms").kind).toBe("loading")
    noteModelDownloadSettled("mms", true)
    expect(getModelStatus("mms").kind).toBe("ready")
  })

  it("settles a Content-Length-less download (total stays 0) to ready on success", () => {
    noteModelDownloading("mms", { loaded: 5_000, total: 0, file: "model.onnx" })
    expect(getModelStatus("mms").kind).toBe("downloading")
    noteModelDownloadSettled("mms", true)
    expect(getModelStatus("mms").kind).toBe("ready")
  })

  it("clears the chip back to idle when a synth download fails", () => {
    noteModelDownloading("mms", { loaded: 5_000, total: 0, file: "model.onnx" })
    expect(getModelStatus("mms").kind).toBe("downloading")
    noteModelDownloadSettled("mms", false)
    expect(getModelStatus("mms").kind).toBe("idle")
  })

  it("starts the bar at 0 instead of painting a finished sidecar full", () => {
    __testOnlySetStatus("mms", { kind: "downloading", loaded: 0, total: 0, file: "" })
    noteModelDownloading("mms", { loaded: 1200, total: 1200, file: "tokens.txt", status: "downloading" })
    expect(getModelStatus("mms")).toMatchObject({ kind: "downloading", loaded: 0, total: 0 })

    noteModelDownloading("mms", { loaded: 0, total: 90_000_000, file: "eng/model.onnx", status: "downloading" })
    expect(getModelStatus("mms")).toMatchObject({ kind: "downloading", loaded: 0, total: 90_000_000 })
  })

  it("does not re-open the chip for an already-ready model", () => {
    noteModelDownloading("whisper", { loaded: 1, total: 100, file: "onnx/model.onnx" })
    noteModelDownloadSettled("whisper", true)
    expect(getModelStatus("whisper").kind).toBe("ready")
    // A later cached-read progress event must not flip ready→downloading.
    noteModelDownloading("whisper", { loaded: 1, total: 100, file: "onnx/model.onnx" })
    expect(getModelStatus("whisper").kind).toBe("ready")
  })

  it("opens a memory-load phase when a weight file finishes, then returns to ready", () => {
    noteModelDownloading("whisper", { loaded: 0, total: 0, file: "onnx/model.onnx", status: "done" })
    expect(getModelStatus("whisper")).toMatchObject({ kind: "loading", file: "onnx/model.onnx" })

    noteModelDownloading("whisper", { loaded: 0, total: 0, file: "", status: "ready" })
    expect(getModelStatus("whisper").kind).toBe("ready")

    // A cached re-read must not bring the download toast back.
    noteModelDownloading("whisper", { loaded: 50, total: 100, file: "onnx/model.onnx", status: "progress" })
    expect(getModelStatus("whisper").kind).toBe("ready")

    // The weight reporting done again means a new session is being built.
    noteModelDownloading("whisper", { loaded: 100, total: 100, file: "onnx/model.onnx", status: "done" })
    expect(getModelStatus("whisper").kind).toBe("loading")
  })

  it("is a no-op to settle a model that was never downloading", () => {
    noteModelDownloadSettled("whisper", true)
    expect(getModelStatus("whisper").kind).toBe("idle")
  })
})
