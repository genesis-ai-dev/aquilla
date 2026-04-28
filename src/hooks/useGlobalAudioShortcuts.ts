// Document-level keyboard shortcuts for audio playback. Mounted once at the
// app root via <GlobalAudioShortcuts />.
//
// Bindings:
//   Space            — toggle the most recently played audio (if any). Only
//                      fires when focus isn't in an editable surface, so
//                      typing in a cell still inserts a space character.
//   Arrow Left / Right (with Shift, when audio is playing) — seek ±2s in the
//                      current track.

import { useEffect } from "react"
import {
  isAudioShortcutOverridden,
  isInEditableContext,
  togglePlayActive,
} from "@/lib/audio/audio-coordinator"

export function useGlobalAudioShortcuts(): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // Another component (e.g. the recording modal) has claimed Space. Yield
      // so its local handler can run without us toggling the previously-played
      // clip first.
      if (isAudioShortcutOverridden()) return
      if (isInEditableContext(e.target)) return

      if (e.code === "Space" && !e.shiftKey) {
        if (togglePlayActive()) {
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }

    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [])
}
