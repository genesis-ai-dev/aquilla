// Read microphone permission once on mount (in Media, for someone who may
// record). Returns a stable `micDenied` boolean — true only when the browser has
// definitively blocked the microphone. "prompt" and "granted" both return false
// so the record button remains fully interactive.
//
// AQU-1758: READ, never asked for. This used to probe with getUserMedia when
// the state was "prompt", which put up the browser's microphone pop-up the
// moment the table loaded in Media. Only the recording window asks, as it
// opens (`probeMicPermission`).
//
// The probe is intentionally at the hook level (shared by the table) rather
// than per-cell, keeping browser API calls to a minimum.

import { useEffect, useState } from "react"
import { queryMicPermission } from "@/components/AudioRecorder/probeMicPermission"

/**
 * Returns `{ micDenied }`.
 *
 * @param enabled  Pass `false` to skip probing (e.g. when the audio lens is
 *                 not active). Defaults to `true`.
 */
export function useMicPermission(enabled = true): { micDenied: boolean } {
  const [micDenied, setMicDenied] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void queryMicPermission().then((state) => {
      if (!cancelled) setMicDenied(state === "denied")
    })
    return () => { cancelled = true }
  }, [enabled])

  return { micDenied }
}
