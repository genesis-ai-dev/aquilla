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
//   - The changer never sees their own modal: Project Settings is a separate
//     route, so the workspace (and this hook's memory) unmounts while they
//     are there and re-baselines on return.

import { useCallback, useEffect, useRef, useState } from "react"
import type { AudioTimingMode } from "@/lib/parsers/types"

export interface TimingModeAck {
  from: AudioTimingMode
  to: AudioTimingMode
}

export function useTimingModeAck(args: { timingMode: AudioTimingMode; eligible: boolean }): {
  ack: TimingModeAck | null
  acknowledge(): void
  surfaceNow(): void
} {
  const { timingMode, eligible } = args
  const seenRef = useRef<AudioTimingMode | null>(null)
  const [ack, setAck] = useState<TimingModeAck | null>(null)
  const modeRef = useRef(timingMode)
  modeRef.current = timingMode

  useEffect(() => {
    const seen = seenRef.current
    if (ack) {
      // Already showing: a flip BACK makes it moot; a further flip retargets.
      if (timingMode === seen) setAck(null)
      else if (timingMode !== ack.to) setAck({ from: ack.from, to: timingMode })
      return
    }
    if (seen == null) {
      if (eligible) seenRef.current = timingMode
      return
    }
    if (timingMode !== seen && eligible) setAck({ from: seen, to: timingMode })
  }, [timingMode, eligible, ack])

  const acknowledge = useCallback(() => {
    seenRef.current = modeRef.current
    setAck(null)
  }, [])

  /** The recorder's cell-transition pulse — the take is confirmed, stop
   *  waiting even though the recorder is still open. */
  const surfaceNow = useCallback(() => {
    const seen = seenRef.current
    if (seen != null && modeRef.current !== seen) {
      setAck((prev) => prev ?? { from: seen, to: modeRef.current })
    }
  }, [])

  return { ack, acknowledge, surfaceNow }
}
