// Probe microphone permission once on mount (or when the audio lens activates).
// Returns a stable `micDenied` boolean — true only when the browser has
// definitively blocked the microphone. "prompt" and "granted" both return false
// so the record button remains fully interactive.
//
// The probe is intentionally at the hook level (shared by the table) rather
// than per-cell, keeping browser API calls to a minimum.

import { useEffect, useState } from "react"
import { probeMicPermission } from "@/components/AudioRecorder/probeMicPermission"

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
    void probeMicPermission().then((state) => {
      if (!cancelled) setMicDenied(state === "denied")
    })
    return () => { cancelled = true }
  }, [enabled])

  return { micDenied }
}
