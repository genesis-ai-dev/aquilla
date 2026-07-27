// Monday.com mapping tables — read-only preview (AI proposal review) and the
// manual row editor for a linked board. Split out of MondayIntegrationSection
// to keep both files under the ~500-line budget.
//
// Column titles come from the cached/fetched board structure when available;
// we fall back to the raw column id so the tables stay usable when the caller
// can't fetch structure (e.g. project maintainer without org maintainer role).

import { useMemo, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { MondayBoardStructure } from "@/lib/monday/api"
import {
  MONDAY_METRIC_KEYS,
  MONDAY_METRIC_LABELS,
  MONDAY_READONLY_COLUMN_TYPES,
  type MondayColumnMapping,
  type MondayMetricKey,
} from "@/lib/monday/types"

function columnTitle(structure: MondayBoardStructure | null, columnId: string): string {
  return structure?.columns.find((c) => c.id === columnId)?.title ?? columnId
}

/** Read-only mapping preview — used in the AI proposal review step. */
export function MondayMappingTable({
  columns,
  structure,
}: {
  columns: MondayColumnMapping[]
  structure: MondayBoardStructure | null
}) {
  if (columns.length === 0) {
    return <p className="text-sm text-muted-foreground">No columns mapped.</p>
  }
  return (
    <Table data-testid="monday-mapping-preview">
      <TableHeader>
        <TableRow>
          <TableHead>Monday column</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Metric</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {columns.map((c) => (
          <TableRow key={`${c.columnId}:${c.metric}`}>
            <TableCell>{columnTitle(structure, c.columnId)}</TableCell>
            <TableCell className="text-muted-foreground">{c.columnType}</TableCell>
            <TableCell>{MONDAY_METRIC_LABELS[c.metric] ?? c.metric}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

interface EditorRow {
  columnId: string
  metric: MondayMetricKey
}

/**
 * Manual mapping editor — rows of (Monday column, metric) with add/remove and
 * an explicit Save (maps to PATCH { config }). Column types are resolved from
 * the board structure at save time; obviously read-only column types are kept
 * out of the picker (the server enforces this too).
 */
export function MondayMappingEditor({
  initialColumns,
  structure,
  disabled,
  saving,
  onSave,
}: {
  initialColumns: MondayColumnMapping[]
  structure: MondayBoardStructure | null
  disabled: boolean
  saving: boolean
  onSave: (columns: MondayColumnMapping[]) => void
}) {
  const [rows, setRows] = useState<EditorRow[]>(
    initialColumns.map((c) => ({ columnId: c.columnId, metric: c.metric })),
  )

  const writableColumns = useMemo(
    () => (structure?.columns ?? []).filter((c) => !MONDAY_READONLY_COLUMN_TYPES.has(c.type)),
    [structure],
  )

  // Options for the column Select: writable structure columns, plus any
  // already-mapped column id not present in structure (stale/unfetchable) so
  // an existing row still renders its value.
  const columnItems = useMemo(() => {
    const items: Record<string, string> = {}
    for (const c of writableColumns) items[c.id] = c.title
    for (const r of rows) {
      if (r.columnId && !(r.columnId in items)) items[r.columnId] = columnTitle(structure, r.columnId)
    }
    return items
  }, [writableColumns, rows, structure])

  const metricItems = useMemo(() => {
    const items: Record<string, string> = {}
    for (const k of MONDAY_METRIC_KEYS) items[k] = MONDAY_METRIC_LABELS[k]
    return items
  }, [])

  const isDirty = useMemo(() => {
    const current = rows.map((r) => `${r.columnId}:${r.metric}`).join("|")
    const base = initialColumns.map((c) => `${c.columnId}:${c.metric}`).join("|")
    return current !== base
  }, [rows, initialColumns])

  const complete = rows.every((r) => r.columnId !== "")

  function updateRow(index: number, patch: Partial<EditorRow>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  function handleSave() {
    const columns: MondayColumnMapping[] = rows
      .filter((r) => r.columnId)
      .map((r) => ({
        columnId: r.columnId,
        columnType:
          structure?.columns.find((c) => c.id === r.columnId)?.type ??
          initialColumns.find((c) => c.columnId === r.columnId)?.columnType ??
          "text",
        metric: r.metric,
      }))
    onSave(columns)
  }

  return (
    <div className="space-y-3" data-testid="monday-mapping-editor">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Monday column</TableHead>
            <TableHead>Metric</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            // Index key is fine here: rows are edited in place and removals
            // re-render the whole small list.
            <TableRow key={i}>
              <TableCell>
                <Select
                  items={columnItems}
                  value={row.columnId || null}
                  onValueChange={(value) => updateRow(i, { columnId: (value as string) ?? "" })}
                  disabled={disabled}
                >
                  <SelectTrigger aria-label="Monday column" className="w-full">
                    <SelectValue placeholder="Pick a column" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {Object.entries(columnItems).map(([id, title]) => (
                        <SelectItem key={id} value={id}>
                          {title}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell>
                <Select
                  items={metricItems}
                  value={row.metric}
                  onValueChange={(value) => updateRow(i, { metric: value as MondayMetricKey })}
                  disabled={disabled}
                >
                  <SelectTrigger aria-label="Metric" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {MONDAY_METRIC_KEYS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {MONDAY_METRIC_LABELS[k]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove mapping row"
                  disabled={disabled}
                  onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => setRows((prev) => [...prev, { columnId: "", metric: "completion_pct" }])}
        >
          <Plus data-icon="inline-start" /> Add row
        </Button>
        <Button
          size="sm"
          disabled={disabled || saving || !isDirty || !complete}
          onClick={handleSave}
        >
          {saving ? "Saving…" : "Save mapping"}
        </Button>
      </div>
    </div>
  )
}
