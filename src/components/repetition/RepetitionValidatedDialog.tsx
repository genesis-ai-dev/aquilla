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

export interface RepetitionValidatedReport {
  /** The rows signed off BESIDES the one the reviewer validated themselves. */
  rows: readonly ValidatedRepetitionRow[]
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
  /** Revert the whole gesture — the votes and any fills — and close. */
  onUndo: () => void
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
          <AlertDialogTitle>
            {t("editor.repetition.validated", { count: report.rows.length })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("editor.repetition.validatedBody", { count: report.rows.length })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* Capped so a source line repeating twenty times scrolls here rather
            than pushing Undo and Done off the bottom of the screen. */}
        <ul className="-mx-1 max-h-64 overflow-y-auto">
          {report.rows.map((row) => (
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
          <Button variant="outline" onClick={() => exit(onUndo)}>
            {t("editor.repetition.undo")}
          </Button>
          <AlertDialogAction autoFocus onClick={() => exit(onClose)}>
            {t("common.done")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
