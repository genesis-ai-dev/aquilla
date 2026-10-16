/** What the "Text validated by" list should do with one open/close request. */
export interface ValidatorsListDecision {
  /** Refuse the request (Base UI's `details.cancel()`). */
  cancel: boolean
  open: boolean
  pinned: boolean
}

/**
 * The rules for the "Text validated by" list, kept pure so they are testable
 * without Base UI's hover timing.
 *
 * A click PINS the list, so a click never closes it. After hover opened it,
 * Base UI reports a click on the check that comes more than 500 ms later as
 * a close (`trigger-press`), so a reader who rested the pointer and then
 * clicked to read the list watched it vanish (PR 1 browser pass, 2026-10-02).
 * While pinned, the pointer leaving keeps it open. Escape, a click elsewhere,
 * focus leaving, or "Remove your validation" close it and unpin it.
 */
export function nextValidatorsListState(
  request: { open: boolean; reason: string },
  current: {
    open: boolean
    pinned: boolean
    /** A press on the check adds the reader's vote instead of opening the list. */
    pressValidates: boolean
    hasValidatorInfo: boolean
  },
): ValidatorsListDecision {
  const keep: ValidatorsListDecision = { cancel: true, open: current.open, pinned: current.pinned }
  if (!request.open) {
    if (request.reason === "trigger-press") return { cancel: true, open: true, pinned: true }
    if (request.reason === "trigger-hover" && current.pinned) return keep
    return { cancel: false, open: false, pinned: false }
  }
  if (request.reason === "trigger-press" || request.reason === "keyboard") {
    // The click votes; the button's own handler does that.
    if (current.pressValidates) return keep
    return { cancel: false, open: true, pinned: true }
  }
  if (request.reason === "trigger-hover" && !current.hasValidatorInfo) return keep
  return { cancel: false, open: true, pinned: current.pinned }
}
