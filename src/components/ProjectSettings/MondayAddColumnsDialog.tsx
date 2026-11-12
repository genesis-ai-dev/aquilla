// "Add columns" on a linked board: the setup's step 2 list in a dialog, so a
// board can grow later. Ticks start at what the board already uses; ticking a
// new one creates it on confirm, unticking one stops filling it.
//
// An Airtable table grows the same way (AQU-804): it passes its own
// `addColumns` (create the fields), `profile` and words.

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
import {
  MONDAY_ADD_COLUMNS_COPY,
  MONDAY_CHOOSER_COPY,
  type AddColumnsCopy,
  type ChooserCopy,
  type ColumnProfile,
} from "@/lib/integrations/sync-ui"
import { MONDAY_COLUMN_PROFILE } from "@/lib/monday/types"

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
  addColumns,
  profile = MONDAY_COLUMN_PROFILE,
  copy = MONDAY_ADD_COLUMNS_COPY,
  chooserCopy = MONDAY_CHOOSER_COPY,
  testIdPrefix = "monday",
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
  /** Create the columns for these metrics (Monday's columns route by default). */
  addColumns?: (metrics: MondayMetricKey[]) => Promise<MondayAddColumnsResult>
  profile?: ColumnProfile
  copy?: AddColumnsCopy
  chooserCopy?: ChooserCopy
  testIdPrefix?: string
}) {
  const t = useT()
  const [selected, setSelected] = useState<Set<MondayMetricKey>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notAdded, setNotAdded] = useState<MondayAddColumnsResult["failed"]>([])

  useEffect(() => {
    if (!open) return
    setSelected(initialColumnSelection(rows, boardColumns, { recommend: false }, profile))
    setError(null)
    setNotAdded([])
    // Fresh ticks each time it opens, from what the board uses now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const { adds } = columnSelectionCounts(selected, rows, boardColumns, profile)

  async function confirm() {
    if (!jwt || busy) return
    setBusy(true)
    setError(null)
    try {
      const need = metricsToAdd(selected, rows, profile)
      const add = addColumns ?? ((metrics: MondayMetricKey[]) => addMondayColumns(jwt, projectId, { boardId, metrics }))
      const added = need.length > 0 ? await add(need) : null
      const saved = await onSave(selectedRows(rows, selected, added, profile), added?.structure ?? null)
      if (added && added.failed.length > 0) {
        setNotAdded(added.failed)
        return
      }
      if (saved) onOpenChange(false)
    } catch (e) {
      setError(t(copy.failed, { reason: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid={`${testIdPrefix}-add-columns-dialog`}>
        <DialogHeader>
          <DialogTitle>{t(copy.title)}</DialogTitle>
          <DialogDescription>{t(chooserCopy.intro)}</DialogDescription>
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
            profile={profile}
            copy={chooserCopy}
            testIdPrefix={testIdPrefix}
          />
        </div>
        {notAdded.length > 0 && (
          <p role="alert" className="text-sm text-amber-700 dark:text-amber-500">
            {t(copy.notAdded, {
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
              {adds > 0 ? t(copy.confirm, { count: adds }) : t("common.save")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
