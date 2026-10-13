// "Add columns" on a linked board: the setup's step 2 list in a dialog, so a
// board can grow later. Ticks start at what the board already uses; ticking a
// new one creates it on confirm, unticking one stops filling it.

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { addMondayColumns, type MondayAddColumnsResult, type MondayBoardStructure } from "@/lib/monday/api"
import type { MondayColumnMapping, MondayMetricKey } from "@/lib/monday/types"
import {
  columnSelectionCounts,
  initialColumnSelection,
  metricsToAdd,
  selectedRows,
} from "@/lib/monday/column-selection"
import { MondayColumnChooser } from "./MondayColumnChooser"
import { useT } from "@/lib/i18n/I18nProvider"

export function MondayAddColumnsDialog({
  open,
  onOpenChange,
  jwt,
  projectId,
  boardId,
  boardName,
  rows,
  boardColumns,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  jwt: string | null
  projectId: string
  boardId: string
  boardName: string
  rows: MondayColumnMapping[]
  boardColumns: MondayBoardStructure["columns"] | null | undefined
  /** Save the new mapping; resolves false when the save failed. */
  onSave: (rows: MondayColumnMapping[], structure: MondayBoardStructure | null) => Promise<boolean>
}) {
  const t = useT()
  const [selected, setSelected] = useState<Set<MondayMetricKey>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notAdded, setNotAdded] = useState<MondayAddColumnsResult["failed"]>([])

  useEffect(() => {
    if (!open) return
    setSelected(initialColumnSelection(rows, boardColumns, { recommend: false }))
    setError(null)
    setNotAdded([])
    // Fresh ticks each time it opens, from what the board uses now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const { adds } = columnSelectionCounts(selected, rows, boardColumns)

  async function confirm() {
    if (!jwt || busy) return
    setBusy(true)
    setError(null)
    try {
      const need = metricsToAdd(selected, rows)
      const added = need.length > 0 ? await addMondayColumns(jwt, projectId, { boardId, metrics: need }) : null
      const saved = await onSave(selectedRows(rows, selected, added), added?.structure ?? null)
      if (added && added.failed.length > 0) {
        setNotAdded(added.failed)
        return
      }
      if (saved) onOpenChange(false)
    } catch (e) {
      setError(t("projectSettings.monday.wizardAddColumnsFailed", { reason: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="monday-add-columns-dialog">
        <DialogHeader>
          <DialogTitle>{t("projectSettings.monday.addColumnsDialogTitle")}</DialogTitle>
          <DialogDescription>{t("projectSettings.monday.chooser.intro")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <MondayColumnChooser
            rows={rows}
            boardColumns={boardColumns}
            boardName={boardName}
            selected={selected}
            onChange={setSelected}
            disabled={busy}
            hideIntro
          />
        </div>
        {notAdded.length > 0 && (
          <p role="alert" className="text-sm text-amber-700 dark:text-amber-500">
            {t("projectSettings.monday.wizardSomeColumnsNotAdded", {
              columns: notAdded.map((f) => f.title).join(", "),
              reason: notAdded[0]?.error ?? "",
            })}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {notAdded.length > 0 ? t("common.close") : t("common.cancel")}
          </Button>
          {notAdded.length === 0 && (
            <Button onClick={() => void confirm()} disabled={busy || !jwt}>
              {busy && <Spinner data-icon="inline-start" />}
              {adds > 0 ? t("projectSettings.monday.addColumnsConfirm", { count: adds }) : t("common.save")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
