/**
 * File-scoped target import: populate the OPEN file's target column from a
 * USFM file or a spreadsheet (CSV/TSV/XLSX). Target-only — source cells are
 * never created or modified.
 *
 * Flow:
 *   1. User drops/picks a file
 *   2. USFM → refs are intrinsic, straight to review (match by canonical ref)
 *      Spreadsheet → [sheet selector] → column mapping (target required,
 *      ref optional; no ref column → rows match cells by order)
 *   3. Review: each incoming row beside the matched cell's source text;
 *      conflicts (cells that already have a translation) need an explicit tick
 *   4. Apply via the shared eBible-target pipeline (target.cell.commit, AD-2)
 */

import { useCallback, useState } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { applyEBibleTargetImport } from "@/lib/import"
import {
  matchTargetRowsByRef,
  matchTargetRowsByOrder,
  usfmToTargetRows,
  type FileTargetCellRef,
  type FileTargetMatchResult,
  type TargetRow,
} from "@/lib/import-file-target"
import {
  parseCsvToSheet,
  parseXlsxToSheets,
  type SpreadsheetSheet,
  type ColumnMapping,
} from "@/lib/parsers/spreadsheet"
import { ColumnMappingPanel } from "./ColumnMappingPanel"

export interface FileTargetImportPanelProps {
  projectId: string
  username: string
  /** Display name of the open file — shown so the user knows the import scope. */
  fileName: string
  /** The open file's cells, in display order. */
  cells: FileTargetCellRef[]
  getToken: (fileId: string) => Promise<string | null>
  onImported: (committedCount: number) => void
  onCancel: () => void
}

type PanelStep = "file" | "sheet" | "mapping" | "review" | "importing"

const USFM_EXTENSIONS = new Set(["usfm", "sfm", "usf"])
const SHEET_EXTENSIONS = new Set(["csv", "tsv", "xlsx", "xls"])

export function FileTargetImportPanel({
  projectId,
  username,
  fileName,
  cells,
  getToken,
  onImported,
  onCancel,
}: FileTargetImportPanelProps) {
  const [step, setStep] = useState<PanelStep>("file")
  const [error, setError] = useState<string | null>(null)
  const [sheets, setSheets] = useState<SpreadsheetSheet[]>([])
  const [selectedSheet, setSelectedSheet] = useState<SpreadsheetSheet | null>(null)
  const [matchResult, setMatchResult] = useState<FileTargetMatchResult | null>(null)
  const [matchedByOrder, setMatchedByOrder] = useState(false)
  const [selectedCellIds, setSelectedCellIds] = useState<Set<string>>(new Set())

  const showReview = useCallback((result: FileTargetMatchResult, byOrder: boolean) => {
    setMatchResult(result)
    setMatchedByOrder(byOrder)
    // Pre-select only non-conflicting cells — overwriting an existing
    // translation requires an explicit tick.
    setSelectedCellIds(new Set(result.matched.filter((m) => !m.hasConflict).map((m) => m.cellId)))
    setStep("review")
  }, [])

  const handleFile = useCallback(async (file: File) => {
    setError(null)
    const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
    try {
      if (USFM_EXTENSIONS.has(ext)) {
        const rows = usfmToTargetRows(await file.text())
        if (rows.length === 0) {
          setError("No verses found in this USFM file.")
          return
        }
        showReview(matchTargetRowsByRef(rows, cells), false)
      } else if (ext === "xlsx" || ext === "xls") {
        const parsed = await parseXlsxToSheets(await file.arrayBuffer())
        if (parsed.length === 0) {
          setError("No sheets found in XLSX file.")
          return
        }
        setSheets(parsed)
        if (parsed.length === 1) {
          setSelectedSheet(parsed[0])
          setStep("mapping")
        } else {
          setStep("sheet")
        }
      } else if (SHEET_EXTENSIONS.has(ext)) {
        const sheet = parseCsvToSheet(await file.text(), file.name)
        setSheets([sheet])
        setSelectedSheet(sheet)
        setStep("mapping")
      } else {
        setError("Unsupported file type. Use USFM (.usfm/.sfm) or a spreadsheet (.csv/.tsv/.xlsx).")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse file")
    }
  }, [cells, showReview])

  function handleMappingConfirm(mapping: ColumnMapping, hasHeader: boolean) {
    if (!selectedSheet || mapping.targetCol === null) return
    const dataRows = hasHeader ? selectedSheet.rows.slice(1) : selectedSheet.rows
    // Keep empty rows in place — order matching needs every row to hold its slot.
    const rows: TargetRow[] = dataRows.map((r) => ({
      ref: mapping.labelCol !== null ? (r[mapping.labelCol] ?? "").trim() || undefined : undefined,
      text: (r[mapping.targetCol!] ?? "").trim(),
    }))
    const byOrder = mapping.labelCol === null
    showReview(
      byOrder ? matchTargetRowsByOrder(rows, cells) : matchTargetRowsByRef(rows, cells),
      byOrder,
    )
  }

  async function handleApply() {
    if (!matchResult) return
    setStep("importing")
    setError(null)
    try {
      const { committedCount } = await applyEBibleTargetImport(
        matchResult,
        selectedCellIds,
        { projectId, author: username, getToken },
      )
      onImported(committedCount)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed")
      setStep("review")
    }
  }

  // ── Step: file selection ────────────────────────────────────────────────────
  if (step === "file") {
    return (
      <div className="flex flex-col gap-4 py-2">
        <div>
          <p className="text-sm font-medium">Import translations into "{fileName}"</p>
          <p className="text-xs text-muted-foreground">
            Fills this file's target column from a USFM file or spreadsheet.
            Source text is never changed. You'll review every match before anything is saved.
          </p>
        </div>
        <div
          className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-muted p-8 gap-3"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const file = e.dataTransfer.files[0]
            if (file) handleFile(file)
          }}
        >
          <p className="text-sm text-muted-foreground">Drop a file here, or</p>
          <label className="cursor-pointer">
            <span className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-accent transition-colors">
              Choose file
            </span>
            <input
              type="file"
              accept=".usfm,.sfm,.usf,.csv,.tsv,.xlsx,.xls"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFile(file)
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">USFM, CSV, TSV, or XLSX</p>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    )
  }

  // ── Step: sheet selection (XLSX with multiple sheets) ──────────────────────
  if (step === "sheet") {
    return (
      <div className="flex flex-col gap-4 py-2">
        <div>
          <p className="text-sm font-medium">Select a sheet</p>
          <p className="text-xs text-muted-foreground">This XLSX has multiple sheets. Pick one to import.</p>
        </div>
        <div className="flex flex-col gap-2">
          {sheets.map((s, i) => (
            <button
              key={i}
              type="button"
              className="rounded-lg border p-3 text-left hover:border-primary hover:bg-primary/5 transition-colors"
              onClick={() => {
                setSelectedSheet(s)
                setStep("mapping")
              }}
            >
              <p className="text-sm font-medium">{s.name}</p>
              <p className="text-xs text-muted-foreground">{s.rows.length} row{s.rows.length !== 1 ? "s" : ""}</p>
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    )
  }

  // ── Step: column mapping (spreadsheets only) ────────────────────────────────
  if (step === "mapping" && selectedSheet) {
    return (
      <ColumnMappingPanel
        sheet={selectedSheet}
        mode="target"
        onConfirm={handleMappingConfirm}
        onCancel={onCancel}
      />
    )
  }

  // ── Step: review matches ────────────────────────────────────────────────────
  if (step === "review" && matchResult) {
    const { matched, orphans, unmatchedSourceCount } = matchResult
    const conflicts = matched.filter((m) => m.hasConflict)

    function toggleCell(cellId: string) {
      setSelectedCellIds((prev) => {
        const next = new Set(prev)
        if (next.has(cellId)) next.delete(cellId)
        else next.add(cellId)
        return next
      })
    }

    return (
      <div className="flex flex-col gap-4 py-2">
        <div>
          <p className="text-sm font-medium">Review matches</p>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>{matched.length} matched</span>
            {conflicts.length > 0 && <span className="text-amber-600">{conflicts.length} conflict{conflicts.length !== 1 ? "s" : ""}</span>}
            {orphans.length > 0 && <span>{orphans.length} unmatched row{orphans.length !== 1 ? "s" : ""}</span>}
            {unmatchedSourceCount > 0 && <span>{unmatchedSourceCount} cell{unmatchedSourceCount !== 1 ? "s" : ""} not covered</span>}
          </div>
          {matchedByOrder && (
            <p className="mt-1.5 text-xs text-amber-600">
              No ref column mapped — rows were matched to cells in order. Check the
              source text next to each row to confirm alignment before importing.
            </p>
          )}
        </div>

        <ScrollArea className="max-h-60 rounded-md border">
          <div className="divide-y">
            {matched.map((m) => (
              <label key={m.cellId} className="flex cursor-pointer items-start gap-2 px-3 py-2 hover:bg-muted/30">
                <input
                  type="checkbox"
                  className="mt-0.5 rounded"
                  checked={selectedCellIds.has(m.cellId)}
                  onChange={() => toggleCell(m.cellId)}
                />
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-[10px] text-muted-foreground">{m.ref}</p>
                  <p className="truncate text-[10px] text-muted-foreground/80">{m.sourceText}</p>
                  <p className="truncate text-xs text-foreground/80">{m.incomingText}</p>
                  {m.hasConflict && (
                    <p className="truncate text-[10px] text-amber-600">
                      Replaces: {m.currentText}
                    </p>
                  )}
                </div>
              </label>
            ))}
          </div>
        </ScrollArea>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex items-center justify-between">
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              const allIds = new Set(matched.map((m) => m.cellId))
              const allSelected = allIds.size > 0 && [...allIds].every((id) => selectedCellIds.has(id))
              setSelectedCellIds(allSelected ? new Set() : allIds)
            }}
          >
            {selectedCellIds.size === matched.length ? "Deselect all" : "Select all"}
          </button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
            <Button
              size="sm"
              disabled={selectedCellIds.size === 0}
              onClick={handleApply}
            >
              Import {selectedCellIds.size} cell{selectedCellIds.size !== 1 ? "s" : ""}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ── Step: importing ─────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-8">
      <p className="text-sm font-medium">Importing…</p>
      <p className="text-xs text-muted-foreground">Applying translations to "{fileName}".</p>
    </div>
  )
}
