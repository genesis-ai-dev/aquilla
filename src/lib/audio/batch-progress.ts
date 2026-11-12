// The progress store behind AudioBulkProgressBanner: which batch is running,
// how far it has got, and whether it is waiting out the transcription limit.
//
// AQU-2093: kept apart from the batch drivers in `batch-audio.ts` so the
// banner, which sits on every page, can watch for a batch without loading the
// transcription, voice and import code on first load. A batch only ever runs
// after that code has loaded.

import { useSyncExternalStore } from "react"

export type BatchKind = "transcribe" | "synth" | "measure" | "changeVoice"

export interface BatchProgress {
  kind: BatchKind
  total: number
  done: number
  /** Signals were cancelled; in-flight cells may still complete. */
  cancelled: boolean
  /** AQU-1681: the hosted transcription limit refused a request; the batch
   *  carries on at this time (epoch ms). */
  waitingUntil?: number
}

let _progress: BatchProgress | null = null
/** AQU-1681: when every waiter is due to carry on, so the banner can say so.
 *  A list because the two concurrent jobs can both be waiting. */
const _waits: number[] = []
const _listeners = new Set<() => void>()

function notify() {
  for (const l of _listeners) l()
}

export function getBatchProgress(): BatchProgress | null {
  return _progress
}

export function setBatchProgress(p: BatchProgress | null) {
  _progress = p && _waits.length > 0 ? { ...p, waitingUntil: Math.max(..._waits) } : p
  notify()
}

/** AQU-1681: a batch job is waiting out the transcription limit until `until`. */
export function addBatchWait(until: number) {
  _waits.push(until)
  if (_progress) setBatchProgress(_progress)
}

export function removeBatchWait(until: number) {
  _waits.splice(_waits.indexOf(until), 1)
  if (_progress) {
    const { waitingUntil: _done, ...rest } = _progress
    setBatchProgress(rest)
  }
}

function subscribe(listener: () => void): () => void {
  _listeners.add(listener)
  return () => { _listeners.delete(listener) }
}

export function useBatchProgress(): BatchProgress | null {
  return useSyncExternalStore(subscribe, getBatchProgress, () => null)
}
