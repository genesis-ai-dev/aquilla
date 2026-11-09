// AQU-2176 — "which rows did that sign off?"
//
// AQU-1486's answer was a toast: "Validated 2 repeated rows", ten seconds,
// one Undo. In a long file that is unactionable — the rows were signed off on
// the reviewer's behalf, and by the time they have scrolled looking for green
// checks the message naming how many is gone. So the outcome of a repetition
// validation is now a dialog the reviewer dismisses: it NAMES each row, each
// entry is a jump to it, and it keeps the toast's Undo and "Ask me each time".
//
// It deliberately has no timeout. It is the one surface that says what was
// done in the reviewer's name, so it waits for them.
//
// AQU-2177 — the same dialog now reports a BULK validation, which can reach
// far more rows, scattered across the file, and does not do the same thing to
// all of them: some repeats were signed off, some only received the text and
// still need validating, some were left alone because the run's own rows
// disagreed. So the list is `groups`, each with its own heading and count, and
// the title/description are the caller's — a single row's "Validated N
// repeated rows", or the bulk run's own summary. A group with no rows is not
// passed in; a single ungrouped list has one group with no heading.
//
// Not every repetition outcome gets one: the fill-only toast ("Applied to N
// repeated segments") fires after nearly every typed translation with repeats
// and stays a toast — see `useRepetitionValidation`.

import { useRef, useState } from "react"
import {
  AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ValidatedRepetitionRow } from "./validated-rows"

/** What a run did to one set of repeated rows, under its own heading. */
export interface RepetitionValidatedGroup {
  /** Stable across renders; also the group's test id suffix. */
  key: "validated" | "filled" | "skipped"
  /** The heading above the rows, carrying their count. Null = one plain list. */
  heading: string | null
  rows: readonly ValidatedRepetitionRow[]
}

export interface RepetitionValidatedReport {
  /** The run's own summary — the dialog's title. */
  title: string
  /** Under the title: the run's own summary line, or how to use the list. */
  description: string
  /** Non-empty groups, in reading order. Never a group with no rows. */
  groups: readonly RepetitionValidatedGroup[]
  /** Offer "Ask me each time": this ran off a remembered "Don't ask again". */
  viaMemory: boolean
}

export function RepetitionValidatedDialog({
  report,
  onGoToRow,
  onUndo,
  onAskEachTime,
  onClose,
}: {
  report: RepetitionValidatedReport
  /** Close, then scroll the editor to that row and flash it. */
  onGoToRow: (cellId: string) => void
  /**
   * Revert the whole gesture — the votes and any fills — and close. Null when
   * the run wrote nothing to take back (every repeat was left as it was).
   */
  onUndo: (() => void) | null
  /** Forget the remembered answer so the next validation asks again. */
  onAskEachTime: () => void
  /** Done or Esc: keep the changes. */
  onClose: () => void
}) {
  const t = useT()
  const [asked, setAsked] = useState(false)
  // Where focus was when this opened — typically the row the reviewer tabbed
  // into after their typed edit. Read during the first render, BEFORE the
  // dialog takes focus, and handed back on close so typing continues there.
  const opener = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const closing = useRef(false)
  /** Done, Esc, Undo and a row jump are each one exit; the first one wins. */
  const exit = (run: () => void) => {
    if (closing.current) return
    closing.current = true
    run()
  }

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) exit(onClose) }}>
      <AlertDialogContent
        data-testid="repetition-validated-dialog"
        className="sm:max-w-md"
        finalFocus={opener}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{report.title}</AlertDialogTitle>
          <AlertDialogDescription>{report.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {/* Capped so a source line repeating twenty times — or three groups of
            them — scrolls here rather than pushing Undo and Done off the
            bottom of the screen. */}
        <div className="-mx-1 max-h-64 space-y-3 overflow-y-auto">
          {report.groups.map((group) => (
            <div key={group.key} data-testid={`repetition-validated-group-${group.key}`}>
              {group.heading && (
                <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.heading}</p>
              )}
              <ul>
                {group.rows.map((row) => (
                  <li key={row.cellId}>
                    <button
                      type="button"
                      className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/40"
                      onClick={() => exit(() => onGoToRow(row.cellId))}
                    >
                      <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
                        {row.number && (
                          <span className="tabular-nums">
                            {t("editor.repetition.validatedRowNumber", { number: row.number })}
                          </span>
                        )}
                        {row.ref && <span>{row.ref}</span>}
                      </span>
                      {row.text && <span className="line-clamp-2 text-sm">{row.text}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <AlertDialogFooter>
          {report.viaMemory && !asked && (
            <Button
              variant="ghost"
              className="sm:mr-auto"
              onClick={() => { setAsked(true); onAskEachTime() }}
            >
              {t("editor.repetition.askEachTime")}
            </Button>
          )}
          {onUndo && (
            <Button variant="outline" onClick={() => exit(onUndo)}>
              {t("editor.repetition.undo")}
            </Button>
          )}
          <AlertDialogAction autoFocus onClick={() => exit(onClose)}>
            {t("common.done")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
