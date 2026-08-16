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
//     own-write suppression must be explicit. `noteOwnWrite(mode)` records a
//     PENDING INTENT rather than stamping the mode as seen: the hook simply
//     stays quiet about that file until the intent resolves. Stamping
//     outright was wrong — an own write that never lands (offline, so the
//     event sits in the outbox; or a rejected one) would leave "seen" holding
//     a mode the file never took, which is exactly the mismatch this hook
//     reads as a remote change — and it would announce it backwards. The
//     intent resolves when the observed mode matches it, and the caller
//     clears it on failure.

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
  /** Own-write suppression: the local user is changing the mode themselves.
   *  Stays pending — and keeps this file silent — until the change is
   *  observed or the caller gives up on it. */
  noteOwnWrite(mode: AudioTimingMode): void
  /** The own write failed or was abandoned: forget the intent and re-baseline
   *  on whatever the file actually reads as now. */
  clearOwnWrite(): void
} {
  const { timingMode, fileId, eligible } = args
  const seenByFileRef = useRef<Map<string, AudioTimingMode>>(new Map())
  const pendingOwnRef = useRef<Map<string, AudioTimingMode>>(new Map())
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
    // An own write is in flight for this file: say nothing about it. When the
    // observed mode catches up, the intent resolves into the baseline.
    const intent = pendingOwnRef.current.get(fileId)
    if (intent != null) {
      if (timingMode === intent) {
        pendingOwnRef.current.delete(fileId)
        seenByFileRef.current.set(fileId, timingMode)
      }
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
    if (pendingOwnRef.current.has(fileRef.current)) return
    const seen = seenByFileRef.current.get(fileRef.current) ?? null
    if (seen != null && modeRef.current !== seen) {
      setAck((prev) => prev ?? { from: seen, to: modeRef.current })
    }
  }, [])

  /** The local user is changing the mode from the toolbar. Recorded as an
   *  intent, not a fait accompli: until the file actually reads as `mode`,
   *  this hook says nothing about it either way. */
  const noteOwnWrite = useCallback((mode: AudioTimingMode) => {
    if (fileRef.current == null) return
    pendingOwnRef.current.set(fileRef.current, mode)
    setAck(null)
  }, [])

  /** The own write failed (or is never coming): drop the intent and treat
   *  whatever the file reads as now as the baseline, so the abandoned attempt
   *  can never surface as somebody else's change. */
  const clearOwnWrite = useCallback(() => {
    if (fileRef.current == null) return
    pendingOwnRef.current.delete(fileRef.current)
    seenByFileRef.current.set(fileRef.current, modeRef.current)
    setAck(null)
  }, [])

  return { ack, acknowledge, surfaceNow, noteOwnWrite, clearOwnWrite }
}
