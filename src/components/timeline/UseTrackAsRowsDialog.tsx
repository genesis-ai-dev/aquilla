// AQU-1566 (Sam's option b): turning a caption track that is already on a
// linked video's timeline into that file's own rows.
//
// It asks first, because the track LEAVES the timeline in the same step: its
// captions are now the file's rows, which the Source text row draws, and its
// hidden content file is deleted. Nothing is lost, but the timeline changes
// shape, and a menu item that silently did that would read as a track vanishing.
//
// The dialog owns only the asking and the waiting. What is written (one server
// request, its ids minted once per confirmation so a retry is answered from the
// receipt) is the workspace's `onConfirm`. A failure keeps the dialog open with
// the reason, so the person can try again or cancel.

import { useState } from "react"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"

interface UseTrackAsRowsDialogProps {
  trackName: string
  /** Resolves once the rows are in. A rejection's message is shown as is, so
   *  the caller decides what a person should read. */
  onConfirm(): Promise<void>
  onCancel(): void
}

export function UseTrackAsRowsDialog({ trackName, onConfirm, onCancel }: UseTrackAsRowsDialogProps) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function confirm() {
    if (busy) return
    setBusy(true)
    setError(null)
    onConfirm().then(
      () => onCancel(),
      (cause: unknown) => {
        setBusy(false)
        setError(cause instanceof Error && cause.message
          ? cause.message : t("editor.timeline.useAsRowsFailed"))
      },
    )
  }

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !busy) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("editor.timeline.useAsRowsTitle", { track: trackName })}</AlertDialogTitle>
          <AlertDialogDescription>{t("editor.timeline.useAsRowsBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={confirm}>
            {busy && <Spinner />}
            {t("editor.timeline.useAsRowsConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
