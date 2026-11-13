/**
 * Say what an undo or redo did, or why it did not happen, in a toast.
 * (AQU-1767; moved out of the workspace for AQU-2262, so Project settings on
 * their own page report their undos the same way.)
 */
import { useCallback } from "react"
import { toast } from "@/components/ui/toast"
import { useT } from "@/lib/i18n/I18nProvider"
import { stepLabel } from "@/lib/history/step-label"
import type { HistoryResult } from "@/lib/history/history"

export function useHistoryReporter(
  /** A language tag's name, the way the language switcher shows it. */
  laneName: (tag: string) => string = (tag) => tag,
): (which: "undo" | "redo", result: HistoryResult) => void {
  const t = useT()
  return useCallback(
    (which: "undo" | "redo", result: HistoryResult) => {
      const name = stepLabel(t as never, result.step)
      const o = result.outcome
      if (o.kind === "done" && o.partial) {
        toast.add({
          type: "info",
          title: t(which === "undo" ? "editor.history.undonePartly" : "editor.history.redonePartly", { step: name, count: o.partial.skipped }),
        })
      } else if (o.kind === "done") {
        toast.add({ type: "info", title: t(which === "undo" ? "editor.history.undone" : "editor.history.redone", { step: name }) })
      } else if (o.kind === "blocked" && o.reason === "elsewhere") {
        // AQU-1767 phase 2: made in another file; it waits on the stack.
        toast.add({
          type: "info",
          title: result.step.fileName
            ? t("editor.history.blockedElsewhere", { file: result.step.fileName, step: name })
            : t("editor.history.blockedElsewhereNoName", { step: name }),
        })
      } else if (o.kind === "blocked" && o.reason === "language") {
        toast.add({
          type: "info",
          title: t("editor.history.blockedLanguage", { step: name, language: laneName(result.step.lane ?? "") }),
        })
      } else if (o.kind === "moved") {
        // Decision 11: another of this person's devices got there first.
        toast.add({ type: "info", title: t(which === "undo" ? "editor.history.movedUndo" : "editor.history.movedRedo", { step: name }) })
      } else if (o.kind === "skipped" && o.reason === "approved") {
        toast.add({ type: "warning", title: t("editor.history.skippedApproved", { step: name, name: o.by ?? "" }) })
      } else if (o.kind === "skipped") {
        toast.add({
          type: "warning",
          title: t(
            o.reason === "gone"
              ? "editor.history.skippedGone"
              : o.reason === "unavailable"
                ? "editor.history.skippedUnavailable"
                : o.reason === "notAllowed"
                  ? "editor.history.skippedNotAllowed"
                  : o.reason === "linesChanged"
                    ? "editor.history.skippedLinesChanged"
                    : o.reason === "otherDevice"
                      ? "editor.history.skippedOtherDevice"
                      : "editor.history.skippedChanged",
            { step: name },
          ),
        })
      } else {
        toast.add({ type: "error", title: t("editor.history.failed", { step: name }) })
      }
    },
    [t, laneName],
  )
}
