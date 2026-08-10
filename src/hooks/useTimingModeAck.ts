// Remote timing-mode changes deserve an acknowledged heads-up (Sam,
// 2026-08-06): the mode APPLIES immediately (shared state — the layout can't
// wait for an OK), but the user who didn't change it gets a small modal
// explaining what moved. Deferral rules fall out of one comparison instead of
// a queued-notification system:
//
//   - "seen" = the mode as this user last saw it while the Media lens was
//     open and the recorder was closed (set silently on first eligibility —
//     first visits and reloads never trigger the modal).
//   - The modal shows whenever current ≠ seen AND the user is eligible
//     (Media lens open, recorder closed) — so a change that lands while
//     they're in the text view or mid-recording surfaces the moment they
//     switch back / close the recorder.
//   - `surfaceNow()` is the recorder's cell-transition pulse: advancing to
//     the next cell (auto-advance or Next/Prev) means the take is confirmed,
//     so the wait ends there even though the recorder stays open.
//   - Back-and-forth flips cancel out: if the mode returns to "seen" before
//     surfacing, there is nothing to say.
//
// Pre-merge round: the mode is FILE-level now, which changes two things.
//   - "seen" is remembered PER FILE: switching files changes the observed
//     mode with no remote change having happened, so each file baselines
//     silently on its own first eligibility — navigation never opens the
//     modal.
//   - The changer no longer leaves the workspace to make the change (the
//     control is the timeline toolbar, not the Project Settings route), so
//     own-write suppression must be explicit: `noteOwnWrite(mode)` stamps
//     the new mode as already seen BEFORE the emit's refresh lands.

import { useCallback, useEffect, useRef, useState } from "react"
import type { AudioTimingMode } from "@/lib/parsers/types"

export interface TimingModeAck {
  from: AudioTimingMode
  to: AudioTimingMode
}

export function useTimingModeAck(args: {
  timingMode: AudioTimingMode
  /** The open file the mode belongs to; null while no file is active. */
  fileId: string | null
  eligible: boolean
}): {
  ack: TimingModeAck | null
  acknowledge(): void
  surfaceNow(): void
  /** Own-write suppression: the local user changed the mode themselves. */
  noteOwnWrite(mode: AudioTimingMode): void
} {
  const { timingMode, fileId, eligible } = args
  const seenByFileRef = useRef<Map<string, AudioTimingMode>>(new Map())
  const [ack, setAck] = useState<TimingModeAck | null>(null)
  const modeRef = useRef(timingMode)
  modeRef.current = timingMode
  const fileRef = useRef(fileId)
  fileRef.current = fileId

  useEffect(() => {
    if (fileId == null) {
      // No file on screen: nothing to compare, and any open modal about a
      // file that just went away is moot.
      if (ack) setAck(null)
      return
    }
    const seen = seenByFileRef.current.get(fileId) ?? null
    if (ack) {
      // Already showing: a flip BACK makes it moot; a further flip retargets.
      if (timingMode === seen) setAck(null)
      else if (timingMode !== ack.to) setAck({ from: ack.from, to: timingMode })
      return
    }
    if (seen == null) {
      if (eligible) seenByFileRef.current.set(fileId, timingMode)
      return
    }
    if (timingMode !== seen && eligible) setAck({ from: seen, to: timingMode })
  }, [timingMode, fileId, eligible, ack])

  const acknowledge = useCallback(() => {
    if (fileRef.current != null) seenByFileRef.current.set(fileRef.current, modeRef.current)
    setAck(null)
  }, [])

  /** The recorder's cell-transition pulse — the take is confirmed, stop
   *  waiting even though the recorder is still open. */
  const surfaceNow = useCallback(() => {
    if (fileRef.current == null) return
    const seen = seenByFileRef.current.get(fileRef.current) ?? null
    if (seen != null && modeRef.current !== seen) {
      setAck((prev) => prev ?? { from: seen, to: modeRef.current })
    }
  }, [])

  /** The local user changed the mode from the toolbar: stamp it as seen
   *  immediately (synchronously, before the emit/refresh round-trip), so
   *  their own change can never read as a remote one. */
  const noteOwnWrite = useCallback((mode: AudioTimingMode) => {
    if (fileRef.current == null) return
    seenByFileRef.current.set(fileRef.current, mode)
    setAck(null)
  }, [])

  return { ack, acknowledge, surfaceNow, noteOwnWrite }
}
