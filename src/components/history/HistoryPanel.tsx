/**
 * The History panel: every step Undo can reach, newest first, with "Undo to
 * here", the steps Redo can bring back, and recent undos that were skipped and
 * why. (AQU-1767 phase 2)
 *
 * It reads the same store as Cmd/Ctrl+Z and the timeline's buttons, so the
 * three always agree. "Undo to here" walks back one step at a time — each
 * step's own guard still decides — and stops at a step that has to wait for
 * its file to be opened.
 *
 * Decision 11: the history is the project's, not one language's, so each step
 * names the language it was made in; and opening the panel catches up with the
 * steps made on the person's other devices (gap 28).
 */
import { useState } from "react"
import { History, Redo2, Undo2 } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { redoLast, refreshHistory, undoLast, undoTo, type HistoryResult, type SkipLogEntry, type StepSummary } from "@/lib/history/history"
import { useHistoryView } from "@/lib/history/useHistory"
import { stepLabel } from "@/lib/history/step-label"
import { cn } from "@/lib/utils"

export interface HistoryPanelProps {
  /** Say what happened (the workspace's toast reporter). */
  onResult: (which: "undo" | "redo", result: HistoryResult) => void
  /** A language tag's name, the way the language switcher shows it. */
  laneName?: (lane: string) => string
}

export function HistoryPanel({ onResult, laneName }: HistoryPanelProps) {
  const t = useT()
  const fmt = useFormat()
  const view = useHistoryView()
  const [open, setOpen] = useState(false)
  const name = (s: Pick<StepSummary, "labelKey" | "labelParams">) => stepLabel(t as never, s)
  // Where a step was made: its file and, when it belongs to one, its language.
  const place = (s: StepSummary): string | null => {
    const language = s.lane !== undefined ? (laneName?.(s.lane) ?? s.lane) : null
    if (s.fileName && language) return t("editor.history.stepPlace", { file: s.fileName, language })
    return s.fileName || language
  }
  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) void refreshHistory()
  }

  const run = (which: "undo" | "redo") => {
    void (which === "undo" ? undoLast() : redoLast()).then((r) => {
      if (r) onResult(which, r)
    })
  }
  const undoToHere = (id: string) => {
    // Each step reports as it finishes: walking back five slow steps took
    // twenty seconds with nothing said until the end.
    void undoTo(id, (r) => onResult("undo", r))
  }

  const undoSteps = [...view.undoSteps].reverse()
  const redoSteps = [...view.redoSteps].reverse()
  const reasonText = (entry: SkipLogEntry) =>
    entry.reason === "changed"
      ? t("editor.history.reasonChanged")
      : entry.reason === "gone"
        ? t("editor.history.reasonGone")
        : entry.reason === "unavailable"
          ? t("editor.history.reasonUnavailable")
          : entry.reason === "approved"
            ? t("editor.history.reasonApproved", { name: entry.by ?? "" })
            : entry.reason === "notAllowed"
              ? t("editor.history.reasonNotAllowed")
              : entry.reason === "linesChanged"
                ? t("editor.history.reasonLinesChanged")
                : entry.reason === "otherDevice"
                  ? t("editor.history.reasonOtherDevice")
                  : t("editor.history.reasonFailed")

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/* The hover names it (AQU-2260); what it does is the panel itself. */}
      <AppTooltip content={t("editor.history.panelAria")}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={t("editor.history.panelAria")}
              data-testid="history-panel-trigger"
              className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <History className="h-3.5 w-3.5" />
              {view.undoSteps.length > 0 && <span className="tabular-nums">{view.undoSteps.length}</span>}
            </button>
          }
        />
      </AppTooltip>
      <PopoverContent
        className="flex max-h-[min(520px,calc(100vh-6rem))] w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
        align="end"
        sideOffset={6}
        data-testid="history-panel"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-medium">{t("editor.history.panelTitle")}</span>
          <span className="flex-1" />
          <button
            type="button"
            aria-label={t("editor.history.undoAria")}
            disabled={!view.canUndo}
            onClick={() => run("undo")}
            data-testid="history-panel-undo"
            className="inline-flex items-center rounded-md border border-border px-1.5 py-1 text-foreground/70 hover:bg-muted disabled:opacity-40"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={t("editor.history.redoAria")}
            disabled={!view.canRedo}
            onClick={() => run("redo")}
            data-testid="history-panel-redo"
            className="inline-flex items-center rounded-md border border-border px-1.5 py-1 text-foreground/70 hover:bg-muted disabled:opacity-40"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {redoSteps.length > 0 && (
            <section aria-label={t("editor.history.redoSection")}>
              <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("editor.history.redoSection")}
              </div>
              <ul>
                {redoSteps.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground" data-testid="history-redo-step">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate line-through decoration-muted-foreground/40">{name(s)}</span>
                      {place(s) && <span className="block truncate text-[11px]">{place(s)}</span>}
                    </span>
                    <span className="tabular-nums">{fmt.time(s.at, { hour: "numeric", minute: "2-digit" })}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-label={t("editor.history.undoSection")}>
            {redoSteps.length > 0 && (
              <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("editor.history.undoSection")}
              </div>
            )}
            {undoSteps.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                {redoSteps.length > 0 ? t("editor.history.emptyAllUndone") : t("editor.history.empty")}
              </p>
            ) : (
              <ul data-testid="history-panel-steps">
                {undoSteps.map((s, i) => (
                  <li key={s.id} className="group flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/60" data-testid="history-step">
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate", i === 0 && "font-medium")}>{name(s)}</span>
                      {place(s) && <span className="block truncate text-[11px] text-muted-foreground">{place(s)}</span>}
                    </span>
                    <span className="tabular-nums text-muted-foreground">{fmt.time(s.at, { hour: "numeric", minute: "2-digit" })}</span>
                    <button
                      type="button"
                      disabled={view.busy}
                      onClick={() => undoToHere(s.id)}
                      data-testid="history-undo-to-here"
                      className="rounded border border-border px-1.5 py-0.5 text-[11px] text-foreground/80 opacity-0 hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40"
                    >
                      {i === 0 ? t("editor.history.undoThis") : t("editor.history.undoToHere")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {view.skipped.length > 0 && (
            <section aria-label={t("editor.history.skippedSection")} className="border-t border-border">
              <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("editor.history.skippedSection")}
              </div>
              <ul data-testid="history-panel-skipped">
                {[...view.skipped].reverse().map((s) => (
                  <li key={`${s.id}-${s.at}`} className="px-3 py-1 text-xs">
                    <span className="block truncate">
                      {s.which === "redo" ? t("editor.history.notRedone", { step: name(s) }) : name(s)}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">{reasonText(s)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
