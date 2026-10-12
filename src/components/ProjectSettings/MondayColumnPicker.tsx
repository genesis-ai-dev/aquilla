// The column picker on the Monday linking screens: every column Aquilla can
// fill, each with a checkbox, its name and one line on what it shows. Columns
// already on the board (mapped, or there under Aquilla's title) read "On your
// board" and can't be ticked. "Add selected to my board" and "Add all" create
// the rest on the board, then map them, so a fresh board can be linked without
// leaving for Monday. Aquilla ID is required: it is how a later setup finds
// the items Aquilla made, so while it's missing it stays ticked.

import { useMemo, useState } from "react"
import { Columns3 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import {
  addMondayColumns,
  type MondayAddColumnsResult,
  type MondayBoardStructure,
} from "@/lib/monday/api"
import {
  MONDAY_COLUMN_CATALOG,
  mergeAddedColumns,
  metricOnBoard,
  type MondayColumnMapping,
  type MondayMetricKey,
} from "@/lib/monday/types"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useT } from "@/lib/i18n/I18nProvider"

const REQUIRED: MondayMetricKey = "external_id"

export function MondayColumnPicker({
  jwt,
  projectId,
  boardId,
  rows,
  boardColumns,
  disabled = false,
  onAdded,
}: {
  jwt: string | null
  projectId: string
  boardId: string
  rows: MondayColumnMapping[]
  /** The board's columns when known; without them only mapped rows count as "on your board". */
  boardColumns: MondayBoardStructure["columns"] | null | undefined
  disabled?: boolean
  /** The rows with the new columns mapped, and the board's columns now. */
  onAdded: (rows: MondayColumnMapping[], structure: MondayBoardStructure) => void
}) {
  const t = useT()
  const [picked, setPicked] = useState<ReadonlySet<MondayMetricKey>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<MondayAddColumnsResult | null>(null)

  const entries = useMemo(
    () =>
      MONDAY_COLUMN_CATALOG.map((entry) => ({
        ...entry,
        onBoard: metricOnBoard(entry.metric, rows, boardColumns),
      })),
    [rows, boardColumns],
  )
  const missing = entries.filter((e) => !e.onBoard)
  const requiredMissing = missing.some((e) => e.metric === REQUIRED)
  const isChecked = (metric: MondayMetricKey) =>
    (metric === REQUIRED && requiredMissing) || picked.has(metric)
  const selected = missing.filter((e) => isChecked(e.metric)).map((e) => e.metric)

  async function add(metrics: MondayMetricKey[]) {
    if (!jwt || !boardId || busy || metrics.length === 0) return
    // Columns already on the board under Aquilla's title but not mapped yet
    // ride along, so they get mapped too instead of sitting unused.
    const matchedUnmapped = entries
      .filter((e) => e.onBoard && !rows.some((r) => r.metric === e.metric && r.columnId))
      .map((e) => e.metric)
    setBusy(true)
    setError(null)
    try {
      const out = await addMondayColumns(jwt, projectId, {
        boardId,
        metrics: [...new Set([...metrics, ...matchedUnmapped])],
      })
      setResult(out)
      setPicked(new Set())
      onAdded(mergeAddedColumns(rows, [...out.reused, ...out.created]), out.structure)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function toggle(metric: MondayMetricKey, on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(metric)
      else next.delete(metric)
      return next
    })
  }

  const locked = disabled || busy || !jwt || !boardId

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3 text-sm" data-testid="monday-column-picker">
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">{t("projectSettings.monday.columnPickerTitle")}</p>
        <p className="text-xs text-muted-foreground">
          {missing.length === 0
            ? t("projectSettings.monday.columnPickerAllOnBoard")
            : t("projectSettings.monday.columnPickerIntro")}
        </p>
      </div>
      <ul className="flex max-h-80 flex-col divide-y overflow-y-auto">
        {entries.map((entry) => {
          const required = entry.metric === REQUIRED && !entry.onBoard
          const labelId = `monday-column-${entry.metric}`
          return (
            <li key={entry.metric} className="flex items-start gap-3 py-2" data-testid={`monday-column-${entry.metric}`}>
              <Checkbox
                aria-labelledby={labelId}
                className="mt-0.5"
                checked={entry.onBoard || isChecked(entry.metric)}
                disabled={entry.onBoard || required || locked}
                onCheckedChange={(on) => toggle(entry.metric, on === true)}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span id={labelId} className="font-medium">{entry.title}</span>
                  {entry.onBoard && (
                    <Badge variant="secondary">{t("projectSettings.monday.columnPickerOnBoard")}</Badge>
                  )}
                  {required && (
                    <Badge variant="outline">{t("projectSettings.monday.columnPickerRequired")}</Badge>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(`projectSettings.monday.columnInfo.${entry.metric}` as MessageKey)}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      {missing.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void add(selected)} disabled={locked || selected.length === 0}>
            {busy ? <Spinner data-icon="inline-start" /> : <Columns3 data-icon="inline-start" />}
            {t("projectSettings.monday.addSelectedColumnsButton")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void add(missing.map((e) => e.metric))} disabled={locked}>
            {t("projectSettings.monday.addAllColumnsButton")}
          </Button>
        </div>
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
