import { useEffect, useRef, useSyncExternalStore } from "react"
import {
  historyView,
  redoLast,
  subscribeHistory,
  undoLast,
  type HistoryResult,
  type HistoryView,
} from "./history"
import { isTextEntryTarget, undoShortcutOwner } from "./arbiter"

/** The active scope's history, for buttons and tooltips. */
export function useHistoryView(): HistoryView {
  return useSyncExternalStore(subscribeHistory, historyView, historyView)
}

/**
 * Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z and Ctrl+Y redo — app-wide, never inside
 * a text field, and Cmd/Ctrl+Z only when the history (not an Undo toast) owns
 * it right now (see arbiter.ts). `onResult` reports each outcome, so the caller
 * can say what was undone or why it was skipped.
 */
export function useHistoryShortcuts(onResult: (which: "undo" | "redo", result: HistoryResult) => void): void {
  const onResultRef = useRef(onResult)
  useEffect(() => {
    onResultRef.current = onResult
  }, [onResult])
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat || event.altKey) return
      if (!event.ctrlKey && !event.metaKey) return
      if (isTextEntryTarget(event.target)) return
      const key = event.key.toLowerCase()
      const redo = (key === "z" && event.shiftKey) || (key === "y" && event.ctrlKey && !event.metaKey)
      const undo = key === "z" && !event.shiftKey
      if (!undo && !redo) return
      if (undo && undoShortcutOwner() !== "history") return
      if (redo && !historyView().canRedo) return
      event.preventDefault()
      void (undo ? undoLast() : redoLast()).then((result) => {
        if (result) onResultRef.current(undo ? "undo" : "redo", result)
      })
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
}
