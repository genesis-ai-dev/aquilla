/**
 * Undo, Redo and the History panel, for a page header. (AQU-2262)
 *
 * Project settings save as you change them; this is where the Save bar was,
 * and it is the app's own Undo — the same history as the editor's buttons and
 * Cmd/Ctrl+Z, so a change made here can be taken back here, in the editor, or
 * on another device.
 *
 * Given `match`, the buttons and the panel act only on the steps it names
 * (Sam, Oct 30: in settings, Undo applies to settings): Undo takes back the
 * newest of them even when other changes were made since, and is never greyed
 * because of those (step-sphere.ts). Cmd/Ctrl+Z stays the project's newest step.
 */
import { Redo2, Undo2 } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { HistoryPanel } from "@/components/history/HistoryPanel"
import { useT } from "@/lib/i18n/I18nProvider"
import { redoLast, undoLast, type HistoryResult } from "@/lib/history/history"
import { redoNewestMatching, undoNewestMatching, useMatchingHistory, type StepMatch } from "@/lib/history/step-sphere"
import { stepLabel } from "@/lib/history/step-label"

const BUTTON =
  "inline-flex h-8 items-center rounded-md border border-border bg-background px-2 text-foreground/70 hover:bg-muted disabled:opacity-40"

export function HistoryControls({
  onResult,
  match,
}: {
  onResult: (which: "undo" | "redo", result: HistoryResult) => void
  /** Act only on the steps this names (Project settings: isSettingsStep). */
  match?: StepMatch
}) {
  const t = useT()
  const view = useMatchingHistory(match)
  const run = (which: "undo" | "redo") => {
    const pressed = match
      ? which === "undo" ? undoNewestMatching(match) : redoNewestMatching(match)
      : which === "undo" ? undoLast() : redoLast()
    void pressed.then((r) => {
      if (r) onResult(which, r)
    })
  }
  return (
    <div className="flex items-center gap-1.5" data-testid="settings-history-controls">
      {/* The hover names each button and the step it would take (AQU-2260). */}
      <AppTooltip
        content={view.nextUndo ? t("editor.history.undoTooltip", { step: stepLabel(t as never, view.nextUndo) }) : t("editor.history.nothingToUndo")}
      >
        <button
          type="button"
          aria-label={t("editor.history.undoAria")}
          data-testid="settings-undo"
          disabled={!view.canUndo}
          onClick={() => run("undo")}
          className={BUTTON}
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>
      </AppTooltip>
      <AppTooltip
        content={view.nextRedo ? t("editor.history.redoTooltip", { step: stepLabel(t as never, view.nextRedo) }) : t("editor.history.nothingToRedo")}
      >
        <button
          type="button"
          aria-label={t("editor.history.redoAria")}
          data-testid="settings-redo"
          disabled={!view.canRedo}
          onClick={() => run("redo")}
          className={BUTTON}
        >
          <Redo2 className="h-3.5 w-3.5" />
        </button>
      </AppTooltip>
      <HistoryPanel onResult={onResult} match={match} />
    </div>
  )
}
