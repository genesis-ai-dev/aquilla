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
//
// AQU-669: `hasFocusWithin` must be derived from the single exclusive focus
// owner (see the reducers below), NOT from a per-row focus-within flag — a row
// whose focus-out never fired would otherwise keep its rail pinned indefinitely
// and the rails would accumulate as the user works down the file.

// AQU-669: the rail's focus pin is EXCLUSIVE — at most one cell is ever the
// focus owner. Rather than each row tracking its own "focus is somewhere inside
// me" flag (which stayed stuck-true whenever a focus-out failed to fire across
// TipTap/ProseMirror surfaces or re-rendered rows, leaving that row's rail
// pinned forever and letting rails accumulate), the table keeps a single owner
// id and each row derives its pin from `owner === cell.id`. Focusing another
// cell overwrites the owner, which deterministically un-pins the previous row.
// These reducers keep that owner logic pure and unit-testable.

/** A focus-in always wins: it overwrites the previous owner (exclusive). */
export function railFocusOwnerOnFocus(_current: string | null, cellId: string): string {
  return cellId
}

/**
 * A focus-out clears the owner ONLY when the leaving row still holds it. A newer
 * focus may already own the pin (out-of-order focusout after the next row's
 * focusin) — that must survive, or the just-focused row would lose its rail.
 */
export function railFocusOwnerOnBlur(current: string | null, cellId: string): string | null {
  return current === cellId ? null : current
}

/** True when `cellId` is the single exclusive focus-pin owner. */
export function isRailFocusPinned(ownerCellId: string | null, cellId: string): boolean {
  return ownerCellId != null && ownerCellId === cellId
}

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
