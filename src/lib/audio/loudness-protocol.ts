// AQU-2664: the messages between the page and the loudness worker
// (loudness.worker.ts), and the worker's answer as a plain function, so the
// same code is tested in-process and runs in the worker.

import { measureLoudness, meterSteps, type LoudnessReading } from "./loudness"

export type LoudnessRequest =
  /** "Are you there?" — sent before any samples, so a worker that can't
   *  start never takes a take's samples with it. */
  | { type: "ping" }
  /** Measure these channels. Their buffers are TRANSFERRED, not copied. */
  | { type: "measure"; id: number; rate: number; channels: Float32Array[] }

export type LoudnessResponse =
  | { type: "pong" }
  | { type: "result"; id: number; reading: LoudnessReading }
  /** Still measuring: sent about every second of samples, so the page can
   *  tell a busy worker from a dead one. */
  | { type: "beat"; id: number }
  /** It failed: the samples come back (transferred again) for the page. */
  | { type: "error"; id: number; message: string; channels: Float32Array[] }

/** The worker's whole job, and what to transfer back with the answer. */
export function answerLoudnessRequest(req: LoudnessRequest): { response: LoudnessResponse; transfer: Transferable[] } {
  if (req.type === "ping") return { response: { type: "pong" }, transfer: [] }
  try {
    return { response: { type: "result", id: req.id, reading: measureLoudness(req.channels, req.rate) }, transfer: [] }
  } catch (cause) {
    return {
      response: { type: "error", id: req.id, message: cause instanceof Error ? cause.message : String(cause), channels: req.channels },
      transfer: buffersOf(req.channels),
    }
  }
}

/**
 * The worker's job as it runs in the worker: the same meter, beating as it
 * goes (`post` is the worker's postMessage). The answer is posted last.
 */
export function runLoudnessRequest(req: LoudnessRequest, post: (msg: LoudnessResponse, transfer?: Transferable[]) => void): void {
  if (req.type !== "measure") {
    post({ type: "pong" })
    return
  }
  try {
    const steps = meterSteps(req.channels, req.rate)
    for (;;) {
      const r = steps.next()
      if (r.done) {
        post({ type: "result", id: req.id, reading: r.value })
        return
      }
      post({ type: "beat", id: req.id })
    }
  } catch (cause) {
    post(
      { type: "error", id: req.id, message: cause instanceof Error ? cause.message : String(cause), channels: req.channels },
      buffersOf(req.channels),
    )
  }
}

/** Each distinct buffer once (two channels may be views of one). */
export function buffersOf(channels: readonly Float32Array[]): ArrayBuffer[] {
  return [...new Set(channels.map((c) => c.buffer as ArrayBuffer))]
}
