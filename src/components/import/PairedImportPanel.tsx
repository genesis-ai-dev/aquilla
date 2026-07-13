/**
 * AQU-315: Import finished translation projects (paired source+target files)
 * to populate the target column / translation memory.
 *
 * The user provides a CSV/XLSX where each row has a source text AND a target
 * translation. These are matched against existing source cells by canonical ref
 * (same mechanism as eBible → target, AQU-191) and the target column is
 * populated via bulkUploadTargetCommits.
 *
 * Flow:
 *   1. User selects a CSV or XLSX file
 *   2. If XLSX: sheet selector (each sheet = one import unit)
 *   3. Column mapping: which col = source, target, ref (required for matching)
 *   4. Preview (reuses matchPairedRowsToSourceCells → EBibleMatchResult shape)
 *   5. User resolves conflicts (keep vs replace)
 *   6. Apply target commits
 *
 * This panel plugs into the ImportDialog's "Paired Translation" landing card.
 */

import { useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { SourceCellRef } from "@/lib/import"
import { applyEBibleTargetImport } from "@/lib/import"
import {
  parseCsvToSheet,
  parseXlsxToSheets,
  applyColumnMapping,
  matchPairedRowsToSourceCells,
  type SpreadsheetSheet,
  type ColumnMapping,
  type PairedMatchResult,
} from "@/lib/parsers/spreadsheet"
import { ColumnMappingPanel } from "./ColumnMappingPanel"

export interface PairedImportPanelProps {
  projectId: string
  username: string
  sourceCells: SourceCellRef[]
  getToken: (fileId: string) => Promise<string | null>
  onImported: (committedCount: number) => void
  onCancel: () => void
}

type PanelStep = "file" | "sheet" | "mapping" | "review" | "importing"

export function PairedImportPanel({
  projectId,
  username,
  sourceCells,
  getToken,
  onImported,
  onCancel,
}: PairedImportPanelProps) {
  const [step, setStep] = useState<PanelStep>("file")
  const [error, setError] = useState<string | null>(null)
  const [sheets, setSheets] = useState<SpreadsheetSheet[]>([])
  const [selectedSheet, setSelectedSheet] = useState<SpreadsheetSheet | null>(null)
  const [matchResult, setMatchResult] = useState<PairedMatchResult | null>(null)
  const [selectedCellIds, setSelectedCellIds] = useState<Set<string>>(new Set())

  const handleFile = useCallback(async (file: File) => {
    setError(null)
    const ext = file.name.split(".").pop()?.toLowerCase()
    try {
      if (ext === "xlsx" || ext === "xls") {
        const buf = await file.arrayBuffer()
        const parsed = await parseXlsxToSheets(buf)
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
      } else {
        // CSV/TSV
        const text = await file.text()
        const sheet = parseCsvToSheet(text, file.name)
        setSheets([sheet])
        setSelectedSheet(sheet)
        setStep("mapping")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse file")
    }
  }, [])

  function handleMappingConfirm(mapping: ColumnMapping, hasHeader: boolean) {
    if (!selectedSheet) return
    const mapped = applyColumnMapping(selectedSheet.rows, mapping, hasHeader)
    const result = matchPairedRowsToSourceCells(mapped, sourceCells)
    setMatchResult(result)
    // Pre-select all non-conflicting cells
    const preSelected = new Set(
      result.matched.filter((m) => !m.hasConflict).map((m) => m.cellId),
    )
    setSelectedCellIds(preSelected)
    setStep("review")
  }

  async function handleApply() {
    if (!matchResult) return
    setStep("importing")
    setError(null)
    try {
      // PairedMatchResult is structurally identical to EBibleMatchResult
      const { committedCount } = await applyEBibleTargetImport(
        matchResult as Parameters<typeof applyEBibleTargetImport>[0],
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
          <p className="text-sm font-medium">Import paired source + target</p>
          <p className="text-xs text-muted-foreground">
            Upload a CSV or XLSX file where each row has both source and target text.
            Rows are matched to existing source cells by canonical reference.
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
          <p className="text-sm text-muted-foreground">Drop a CSV or XLSX file here, or</p>
          <label className="cursor-pointer">
            <span className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors">
              Choose file
            </span>
            <input
              type="file"
              accept=".csv,.tsv,.xlsx,.xls"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFile(file)
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">CSV, TSV, or XLSX</p>
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

  // ── Step: column mapping ────────────────────────────────────────────────────
  if (step === "mapping" && selectedSheet) {
    return (
      <ColumnMappingPanel
        sheet={selectedSheet}
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
            {unmatchedSourceCount > 0 && <span>{unmatchedSourceCount} source cell{unmatchedSourceCount !== 1 ? "s" : ""} not covered</span>}
          </div>
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
              const allIds = new Set(matched.map(m => m.cellId))
              const allSelected = allIds.size > 0 && [...allIds].every(id => selectedCellIds.has(id))
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
      <p className="text-xs text-muted-foreground">Applying target translations to cells.</p>
    </div>
  )
}
