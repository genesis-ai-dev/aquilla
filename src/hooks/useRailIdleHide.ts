// AQU-354: idle auto-hide for the floating cell action rail.
//
// The rail is pinned to a cell row's top-right. While the row stays hovered or
// focused it overlaps the "This cell changed elsewhere while you were editing."
// conflict banner and covers its "Discard and reload" button (the banner lays
// the button out at its right edge, directly under the rail). Because the rail
// has no idle auto-hide, keeping the pointer/focus on the cell — exactly what a
// user reading the warning does — keeps the rail on top of the button.
//
// This hook adds an idle-timeout dimension on top of the existing ephemeral
// reveal triggers: after `idleMs` with no fresh reveal gesture the rail
// collapses, so the banner (and Discard button) become readable and clickable.
// A fresh gesture (re-hover, focus, tap) calls `registerActivity()` to bring it
// back and restart the clock. While an interaction is in flight (`pinned` —
// e.g. the expansion panel is open, a rail control has focus, or a rail popover
// is open) the rail is never idle-collapsed, so an open menu / in-progress
// interaction is never yanked out from under the user.
//
// Note: the rail is intentionally NOT re-revealed by mere intra-row pointer
// movement. The Discard button sits under the rail, so re-revealing on every
// mousemove would re-cover it just as the user reaches for it. Staying hidden
// until a fresh reveal gesture is what makes the banner reliably actionable.

import { useCallback, useEffect, useRef, useState } from "react"

/** Default idle period before the rail collapses. */
export const RAIL_IDLE_MS = 2200

export interface RailIdleHideOptions {
  /** Ephemeral reveal triggers OR'd together (row hover / focus-within /
   *  tap-selected). When true the rail wants to be revealed. */
  revealTriggered: boolean
  /** In-flight interactions that must never be idle-collapsed (expansion panel
   *  open, a rail control focused, a rail popover open). While true the rail is
   *  forced visible and the idle state is reset. */
  pinned: boolean
  /** Idle period in ms before an ephemerally-revealed rail collapses. */
  idleMs?: number
}

export interface RailIdleHideResult {
  /** Whether the rail should render in its revealed state. */
  revealed: boolean
  /** Call on a fresh reveal gesture (row mouse-enter / focus / tap-select) to
   *  bring the rail back and restart the idle countdown. */
  registerActivity: () => void
}

export function useRailIdleHide({
  revealTriggered,
  pinned,
  idleMs = RAIL_IDLE_MS,
}: RailIdleHideOptions): RailIdleHideResult {
  const [idleHidden, setIdleHidden] = useState(false)
  const timerRef = useRef<number | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (pinned) {
      // A pinned interaction forces the rail visible; reset the idle flag so it
      // doesn't vanish the instant the pin releases.
      clearTimer()
      setIdleHidden(false)
      return
    }
    if (!revealTriggered || idleHidden) {
      // Nothing to reveal, or already collapsed — no countdown needed.
      clearTimer()
      return
    }
    // Ephemerally revealed and not pinned: arm the collapse.
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      setIdleHidden(true)
      timerRef.current = null
    }, idleMs)
    return clearTimer
  }, [pinned, revealTriggered, idleHidden, idleMs, clearTimer])

  // Cancel any pending timer on unmount.
  useEffect(() => clearTimer, [clearTimer])

  const registerActivity = useCallback(() => {
    // Un-hide; the effect re-arms the idle countdown from the reveal triggers.
    setIdleHidden(false)
  }, [])

  const revealed = pinned || (revealTriggered && !idleHidden)
  return { revealed, registerActivity }
}
