/**
 * FRO-316: Column mapping UI for spreadsheet imports.
 *
 * Shown after the user selects a CSV or XLSX file. They choose:
 *   - which column is the source text (required)
 *   - which column is the target translation (optional)
 *   - which column is the cell label / canonical ref (optional)
 *   - which column is the cast / character name (optional)
 *   - which column is the start/end timestamp (optional)
 *
 * After confirming the mapping the parent proceeds to preview → upload.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { ColumnMapping, SpreadsheetSheet } from "@/lib/parsers/spreadsheet"

export interface ColumnMappingPanelProps {
  /** The sheet whose header + first few rows are shown to help the user map. */
  sheet: SpreadsheetSheet
  /** Called when the user confirms the mapping. */
  onConfirm: (mapping: ColumnMapping, hasHeader: boolean) => void
  /** Called when the user cancels — return to file selection. */
  onCancel: () => void
}

const PREVIEW_ROWS = 5

/** One column selector row. */
function ColSelect({
  label,
  headers,
  value,
  onChange,
  required,
}: {
  label: string
  headers: string[]
  value: number | null
  onChange: (v: number | null) => void
  required?: boolean
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-40 shrink-0 text-xs font-medium text-foreground/80">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      <select
        className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value
          onChange(v === "" ? null : parseInt(v, 10))
        }}
      >
        <option value="">— ignore —</option>
        {headers.map((h, i) => (
          <option key={i} value={i}>
            {h || `Column ${i + 1}`}
          </option>
        ))}
      </select>
    </div>
  )
}

export function ColumnMappingPanel({ sheet, onConfirm, onCancel }: ColumnMappingPanelProps) {
  const rows = sheet.rows
  const firstRow = rows[0] ?? []
  const [hasHeader, setHasHeader] = useState(true)
  const headers: string[] = hasHeader
    ? firstRow.map((h, i) => h || `Column ${i + 1}`)
    : firstRow.map((_, i) => `Column ${i + 1}`)

  // Auto-detect common header names
  function autoDetect(names: string[]): number | null {
    if (!hasHeader) return null
    const lc = firstRow.map((h) => h.trim().toLowerCase())
    for (const name of names) {
      const idx = lc.indexOf(name)
      if (idx !== -1) return idx
    }
    return null
  }

  const [mapping, setMapping] = useState<ColumnMapping>(() => ({
    sourceCol: autoDetect(["source", "src", "original", "source_text", "sourcetext", "en", "english"]) ?? (firstRow.length >= 1 ? 0 : null),
    targetCol: autoDetect(["target", "tgt", "translation", "translated", "target_text", "targettext"]) ?? (firstRow.length >= 2 ? 1 : null),
    labelCol: autoDetect(["ref", "id", "label", "cell", "verse", "canonical_ref", "key"]),
    castCol: autoDetect(["cast", "character", "speaker", "cast_name", "character_name"]),
    startCol: autoDetect(["start", "start_time", "timein", "time_in", "startms"]),
    endCol: autoDetect(["end", "end_time", "timeout", "time_out", "endms"]),
  }))

  function set(field: keyof ColumnMapping, v: number | null) {
    setMapping((m) => ({ ...m, [field]: v }))
  }

  const previewRows = (hasHeader ? rows.slice(1) : rows).slice(0, PREVIEW_ROWS)

  const canConfirm = mapping.sourceCol !== null

  return (
    <div className="flex flex-col gap-4 py-2">
      <div>
        <p className="text-sm font-medium">Map columns</p>
        <p className="text-xs text-muted-foreground">
          Tell us which column contains each piece of data. Only "Source text" is required.
        </p>
      </div>

      {/* Header toggle */}
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          className="rounded"
          checked={hasHeader}
          onChange={(e) => setHasHeader(e.target.checked)}
        />
        First row is a header
      </label>

      {/* Column selectors */}
      <div className="flex flex-col gap-2">
        <ColSelect
          label="Source text"
          headers={headers}
          value={mapping.sourceCol}
          onChange={(v) => set("sourceCol", v)}
          required
        />
        <ColSelect
          label="Target translation"
          headers={headers}
          value={mapping.targetCol}
          onChange={(v) => set("targetCol", v)}
        />
        <ColSelect
          label="Cell label / ref"
          headers={headers}
          value={mapping.labelCol}
          onChange={(v) => set("labelCol", v)}
        />
        <ColSelect
          label="Cast / character"
          headers={headers}
          value={mapping.castCol}
          onChange={(v) => set("castCol", v)}
        />
        <ColSelect
          label="Start timestamp"
          headers={headers}
          value={mapping.startCol}
          onChange={(v) => set("startCol", v)}
        />
        <ColSelect
          label="End timestamp"
          headers={headers}
          value={mapping.endCol}
          onChange={(v) => set("endCol", v)}
        />
      </div>

      {/* Data preview table */}
      {previewRows.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-foreground/70">Preview (first {previewRows.length} data rows)</p>
          <ScrollArea className="max-h-40 rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  {headers.map((h, i) => (
                    <th key={i} className="whitespace-nowrap px-2 py-1 text-left font-medium text-foreground/70">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {previewRows.map((row, ri) => (
                  <tr key={ri}>
                    {headers.map((_, ci) => (
                      <td key={ci} className="max-w-[160px] truncate px-2 py-1 text-foreground/80">
                        {row[ci] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!canConfirm}
          onClick={() => onConfirm(mapping, hasHeader)}
        >
          Map columns
        </Button>
      </div>
    </div>
  )
}
