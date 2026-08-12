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

/** Resolve a column's Monday type from live structure, falling back to the type
 *  already recorded on the row (structure may be unfetchable for this caller). */
function resolveColumnType(
  structure: MondayBoardStructure | null,
  columnId: string,
  previous: MondayColumnMapping[],
): string {
  return (
    structure?.columns.find((c) => c.id === columnId)?.type ??
    previous.find((c) => c.columnId === columnId)?.columnType ??
    "text"
  )
}

/**
 * Controlled (Monday column → metric) rows with add/remove. Shared by the
 * linked-board editor below and by the setup wizard's review step, so an AI
 * proposal is corrected with exactly the same controls used to edit a saved
 * mapping — one implementation, one set of affordances.
 *
 * Read-only column types are kept out of the picker (the server enforces this
 * too); an already-mapped id missing from structure still renders so a stale
 * row stays visible and removable.
 */
export function MondayMappingRows({
  rows,
  structure,
  disabled,
  onChange,
}: {
  rows: MondayColumnMapping[]
  structure: MondayBoardStructure | null
  disabled: boolean
  onChange: (rows: MondayColumnMapping[]) => void
}) {
  const writableColumns = useMemo(
    () => (structure?.columns ?? []).filter((c) => !MONDAY_READONLY_COLUMN_TYPES.has(c.type)),
    [structure],
  )

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

  function updateRow(index: number, patch: Partial<MondayColumnMapping>) {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  return (
    <div className="space-y-3">
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
                  onValueChange={(value) => {
                    const columnId = (value as string) ?? ""
                    updateRow(i, {
                      columnId,
                      columnType: resolveColumnType(structure, columnId, rows),
                    })
                  }}
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
                  onClick={() => onChange(rows.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() =>
          onChange([...rows, { columnId: "", columnType: "text", metric: "completion_pct" }])
        }
      >
        <Plus data-icon="inline-start" /> Add row
      </Button>
    </div>
  )
}

/**
 * Manual mapping editor for a linked board — the shared rows plus an explicit
 * Save (maps to PATCH { config }).
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
  const [rows, setRows] = useState<MondayColumnMapping[]>(initialColumns)

  const isDirty = useMemo(() => {
    const current = rows.map((r) => `${r.columnId}:${r.metric}`).join("|")
    const base = initialColumns.map((c) => `${c.columnId}:${c.metric}`).join("|")
    return current !== base
  }, [rows, initialColumns])

  const complete = rows.every((r) => r.columnId !== "")

  return (
    <div className="space-y-3" data-testid="monday-mapping-editor">
      <MondayMappingRows
        rows={rows}
        structure={structure}
        disabled={disabled}
        onChange={setRows}
      />
      <Button
        size="sm"
        disabled={disabled || saving || !isDirty || !complete}
        onClick={() => onSave(rows.filter((r) => r.columnId))}
      >
        {saving ? "Saving…" : "Save mapping"}
      </Button>
    </div>
  )
}
