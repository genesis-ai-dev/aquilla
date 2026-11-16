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
 *
 * Given `match` (Project settings, AQU-2262), it lists, undoes and reports
 * only the steps that names; steps made elsewhere stay where they are.
 */
import { useState, type ReactNode } from "react"
import { History, Redo2, Undo2, UndoDot } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { redoLast, refreshHistory, undoLast, undoTo, type HistoryResult, type SkipLogEntry, type StepSummary } from "@/lib/history/history"
import { redoNewestMatching, undoMatchingTo, undoNewestMatching, useMatchingHistory, type StepMatch } from "@/lib/history/step-sphere"
import { stepLabel } from "@/lib/history/step-label"
import { cn } from "@/lib/utils"

export interface HistoryPanelProps {
  /** Say what happened (the workspace's toast reporter). */
  onResult: (which: "undo" | "redo", result: HistoryResult) => void
  /** A language tag's name, the way the language switcher shows it. */
  laneName?: (lane: string) => string
  /**
   * Which edge of the button the panel lines up with. The media bar sits on
   * the left, so the panel opens to the right (`start`). The chapter row's
   * button sits on the right, so the panel opens back into the page (`end`).
   */
  align?: "start" | "end"
  /** Act only on the steps this names (Project settings: isSettingsStep). */
  match?: StepMatch
}

// Its button is a square like its neighbours in every view's bar, without
// the count (canvas board 55, option E; in every view since Sam, Oct 28).
export function HistoryPanel({ onResult, laneName, align = "end", match }: HistoryPanelProps) {
  const t = useT()
  const fmt = useFormat()
  const view = useMatchingHistory(match)
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
    const pressed = match
      ? which === "undo" ? undoNewestMatching(match) : redoNewestMatching(match)
      : which === "undo" ? undoLast() : redoLast()
    void pressed.then((r) => {
      if (r) onResult(which, r)
    })
  }
  const undoToHere = (id: string) => {
    // Each step reports as it finishes: walking back five slow steps took
    // twenty seconds with nothing said until the end.
    const report = (r: HistoryResult) => onResult("undo", r)
    void (match ? undoMatchingTo(id, match, report) : undoTo(id, report))
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
              className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <History className="h-3.5 w-3.5" />
            </button>
          }
        />
      </AppTooltip>
      <PopoverContent
        align={align}
        side="bottom"
        sideOffset={6}
        className="flex max-h-[min(560px,calc(100vh-6rem))] w-[420px] max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-hidden pt-2 pr-0 pb-0 pl-2"
        data-testid="history-panel"
      >
        <header className="flex shrink-0 items-center justify-between gap-2 pr-2">
          <h3 className="text-base font-semibold tracking-tight">{t("editor.history.panelTitle")}</h3>
          <div className="flex items-center gap-1">
            <HistoryIconButton
              label={t("editor.history.undoAria")}
              reason={view.canUndo ? undefined : t("editor.history.nothingToUndo")}
              disabled={!view.canUndo}
              testId="history-panel-undo"
              onClick={() => run("undo")}
            >
              <Undo2 />
            </HistoryIconButton>
            <HistoryIconButton
              label={t("editor.history.redoAria")}
              reason={view.canRedo ? undefined : t("editor.history.nothingToRedo")}
              disabled={!view.canRedo}
              testId="history-panel-redo"
              onClick={() => run("redo")}
            >
              <Redo2 />
            </HistoryIconButton>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin pr-2 pb-2">
          {undoSteps.length === 0 && redoSteps.length === 0 && view.skipped.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-3 py-10 text-center">
              <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <History className="size-4" aria-hidden />
              </span>
              <p className="max-w-64 text-sm text-muted-foreground">{t("editor.history.empty")}</p>
            </div>
          ) : (
            <>
              {redoSteps.length > 0 && (
                <section aria-label={t("editor.history.redoSection")}>
                  <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
                    {t("editor.history.redoSection")}
                  </div>
                  <ul>
                    {redoSteps.map((s) => (
                      <li key={s.id} className="rounded-md hover:bg-accent/40" data-testid="history-redo-step">
                        <HistoryStepRow
                          title={name(s)}
                          place={place(s)}
                          time={fmt.time(s.at, { hour: "numeric", minute: "2-digit" })}
                          muted
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <section aria-label={t("editor.history.undoSection")}>
                {redoSteps.length > 0 && (
                  <div className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                    {t("editor.history.undoSection")}
                  </div>
                )}
                {undoSteps.length === 0 ? (
                  <p className="px-2 py-3 text-xs text-muted-foreground">
                    {redoSteps.length > 0 ? t("editor.history.emptyAllUndone") : t("editor.history.empty")}
                  </p>
                ) : (
                  <ul data-testid="history-panel-steps">
                    {undoSteps.map((s, i) => {
                      const action = i === 0 ? t("editor.history.undoThis") : t("editor.history.undoToHere")
                      return (
                        <li key={s.id} className="flex items-center rounded-md hover:bg-accent/40" data-testid="history-step">
                          <HistoryStepRow
                            title={name(s)}
                            place={place(s)}
                            time={fmt.time(s.at, { hour: "numeric", minute: "2-digit" })}
                            emphasized={i === 0}
                          />
                          <HistoryIconButton
                            label={action}
                            disabled={view.busy}
                            testId="history-undo-to-here"
                            size="icon-xs"
                            className="me-1 text-muted-foreground"
                            onClick={() => undoToHere(s.id)}
                          >
                            {i === 0 ? <Undo2 /> : <UndoDot />}
                          </HistoryIconButton>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
              {view.skipped.length > 0 && (
                <section aria-label={t("editor.history.skippedSection")}>
                  <div className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                    {t("editor.history.skippedSection")}
                  </div>
                  <ul data-testid="history-panel-skipped">
                    {[...view.skipped].reverse().map((s) => (
                      <li key={`${s.id}-${s.at}`} className="rounded-md px-2 py-1.5">
                        <span className="block truncate text-sm font-medium">
                          {s.which === "redo" ? t("editor.history.notRedone", { step: name(s) }) : name(s)}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{reasonText(s)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** A ghost icon button. Hover names it; a disabled one explains itself on click. */
function HistoryIconButton({
  label,
  reason,
  disabled,
  testId,
  onClick,
  size = "icon-sm",
  className,
  children,
}: {
  label: string
  /** Why it is greyed out. Shown on click, only while disabled. */
  reason?: string
  disabled?: boolean
  testId: string
  onClick: () => void
  size?: "icon-sm" | "icon-xs"
  className?: string
  children: ReactNode
}) {
  return (
    <AppTooltip content={disabled && reason ? reason : label}>
      <Button
        type="button"
        variant="ghost"
        size={size}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        data-testid={testId}
        className={className}
      >
        {children}
      </Button>
    </AppTooltip>
  )
}

/** One history row: the step, where it happened, and the time, like an inbox notice. */
function HistoryStepRow({
  title,
  place,
  time,
  muted = false,
  emphasized = false,
}: {
  title: string
  place: string | null
  time: string
  muted?: boolean
  emphasized?: boolean
}) {
  return (
    <span className="min-w-0 flex-1 px-2 py-1.5">
      <span className="flex items-baseline justify-between gap-3">
        <span
          className={cn(
            "truncate text-sm",
            muted
              ? "text-muted-foreground line-through decoration-muted-foreground/40"
              : emphasized
                ? "font-medium text-foreground"
                : "font-medium text-foreground/90",
          )}
        >
          {title}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{time}</span>
      </span>
      {place ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{place}</span> : null}
    </span>
  )
}
