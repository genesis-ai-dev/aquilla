// "Add the missing columns for me" — shown wherever a Monday mapping is
// reviewed or edited, when some of Aquilla's numbers have no board column to
// land in. Aquilla creates those columns on the board (reusing any already
// there under the same title), then maps them, so a fresh board can be linked
// without leaving for Monday.

import { useState } from "react"
import { Columns3 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  addMondayColumns,
  type MondayAddColumnsResult,
  type MondayBoardStructure,
} from "@/lib/monday/api"
import {
  MONDAY_NEW_COLUMN_TITLES,
  mergeAddedColumns,
  missingColumnMetrics,
  type MondayColumnMapping,
} from "@/lib/monday/types"
import { useT } from "@/lib/i18n/I18nProvider"

export function MondayMissingColumns({
  jwt,
  projectId,
  boardId,
  rows,
  disabled = false,
  onAdded,
}: {
  jwt: string | null
  projectId: string
  boardId: string
  rows: MondayColumnMapping[]
  disabled?: boolean
  /** The rows with the new columns mapped, and the board's columns now. */
  onAdded: (rows: MondayColumnMapping[], structure: MondayBoardStructure) => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<MondayAddColumnsResult | null>(null)

  const missing = missingColumnMetrics(rows)
  if (missing.length === 0 && !result && !error) return null
  const titles = (metrics: string[]) =>
    metrics.map((m) => MONDAY_NEW_COLUMN_TITLES[m as keyof typeof MONDAY_NEW_COLUMN_TITLES] ?? m).join(", ")

  async function handleAdd() {
    if (!jwt || !boardId || busy) return
    setBusy(true)
    setError(null)
    try {
      const out = await addMondayColumns(jwt, projectId, { boardId, metrics: missing })
      setResult(out)
      onAdded(mergeAddedColumns(rows, [...out.reused, ...out.created]), out.structure)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed p-3 text-sm" data-testid="monday-missing-columns">
      {missing.length > 0 && (
        <>
          <p className="text-muted-foreground">
            {t("projectSettings.monday.missingColumnsLine", { columns: titles(missing) })}
          </p>
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleAdd()}
              disabled={disabled || busy || !jwt || !boardId}
            >
              {busy ? <Spinner data-icon="inline-start" /> : <Columns3 data-icon="inline-start" />}
              {t("projectSettings.monday.addMissingColumnsButton")}
            </Button>
          </div>
        </>
      )}
      {result && result.created.length > 0 && (
        <p role="status">{t("projectSettings.monday.addMissingColumnsDone", { count: result.created.length })}</p>
      )}
      {result && result.created.length === 0 && result.reused.length > 0 && (
        <p role="status">{t("projectSettings.monday.addMissingColumnsMatchedOnly", { count: result.reused.length })}</p>
      )}
      {result && result.failed.length > 0 && (
        <p className="text-destructive">
          {t("projectSettings.monday.addMissingColumnsFailed", {
            columns: result.failed.map((f) => f.title).join(", "),
            reason: result.failed[0]?.error ?? "",
          })}
        </p>
      )}
      {error && <p className="text-destructive">{error}</p>}
    </div>
  )
}
