/**
 * Who gets Cmd/Ctrl+Z. (AQU-1767)
 *
 * Two things in the app answer it: the edit history (src/lib/history) and the
 * newest toast carrying an Undo button (repetition propagation, rename
 * suggestions…). Before the history existed the toast owned the shortcut
 * outright. Now the NEWER of the two wins — whichever the user did last is what
 * they mean to take back — and only one of them ever fires.
 *
 * A text field always keeps the shortcut for itself; both listeners check that
 * before asking here.
 */
import { newestStepAt } from "./history"

let toastUndoAt: number | null = null

/** The toast list reports when its newest Undo toast appeared (null = none). */
export function setToastUndoAt(at: number | null): void {
  toastUndoAt = at
}

export function undoShortcutOwner(): "history" | "toast" | null {
  const historyAt = newestStepAt()
  if (historyAt == null) return toastUndoAt == null ? null : "toast"
  if (toastUndoAt == null) return "history"
  return historyAt > toastUndoAt ? "history" : "toast"
}

/** Ctrl/Cmd+Z belongs to the field when the user is typing. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}
