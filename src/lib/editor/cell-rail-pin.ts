// AQU-621: decide whether a cell row's floating action rail should be *pinned*
// open (i.e. never idle-collapsed by useRailIdleHide). A pinned rail stays
// visible so clicking into a cell never leaves the user staring at a blank rail
// — the sparkle/generate affordance (and, on a translated cell, its separate
// validation control) stays discoverable without hovering.
//
// Focusing the row's target cell pins the rail, EXCEPT while AQU-354's "changed
// elsewhere while you were editing" conflict banner is showing: that banner's
// Discard button sits directly under the rail, so there we must let the rail
// idle-collapse (per AQU-354) instead of pinning it, keeping Discard reachable.

export interface RailPinInputs {
  /** The cell's expansion (details) panel is open. */
  expanded: boolean
  /** A control inside the rail currently holds focus (an in-flight interaction). */
  railHasFocus: boolean
  /** The mic-denied help popover is open. */
  showMicDeniedHelp: boolean
  /** The "replace existing translation?" confirmation is open. */
  showGenerateConfirm: boolean
  /** Focus is somewhere within the row (e.g. the target editor is focused). */
  hasFocusWithin: boolean
  /** A remote change arrived while editing — the conflict banner is showing. */
  remoteChangedWhileFocused: boolean
}

/**
 * Returns true when the rail must stay revealed (pinned) rather than being
 * subject to the idle auto-collapse in `useRailIdleHide`.
 */
export function computeRailPinned({
  expanded,
  railHasFocus,
  showMicDeniedHelp,
  showGenerateConfirm,
  hasFocusWithin,
  remoteChangedWhileFocused,
}: RailPinInputs): boolean {
  // In-flight interactions always pin (unchanged AQU-354 behavior): an open
  // panel/popover or a focused rail control must never be yanked away.
  if (expanded || railHasFocus || showMicDeniedHelp || showGenerateConfirm) {
    return true
  }
  // AQU-621: a focused target cell pins the rail so it never idle-collapses to a
  // blank state — unless the conflict banner is up, where AQU-354's collapse
  // must win so the Discard button underneath stays clickable.
  return hasFocusWithin && !remoteChangedWhileFocused
}
