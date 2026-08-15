/**
 * AQU-315: Import finished translation projects (paired source+target files)
 * to populate the target column / translation memory.
 *
 * The user provides a CSV/XLSX where each row has a source text AND a target
 * translation. These are matched against existing source cells by canonical ref
 * (same mechanism as eBible → target, AQU-191) and the target column is
 * populated via enqueueTargetCommits.
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
import { useT } from "@/lib/i18n/I18nProvider"
import type { SourceCellRef } from "@/lib/import"
import { applyEBibleTargetImport } from "@/lib/import"
import { decodeImportText } from "@/lib/import/ai-recipe"
import { assertSourceUploadByteLength } from "@/lib/sync/source-upload"
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
  /** Target-lane storage key. Empty/absent means the project's default lane. */
  targetLang?: string
  sourceCells: SourceCellRef[]
  getToken: (fileId: string) => Promise<string | null>
  onImported: (committedCount: number) => void
  onCancel: () => void
}

type PanelStep = "file" | "sheet" | "mapping" | "review" | "importing"

export function PairedImportPanel({
  projectId,
  username,
  targetLang,
  sourceCells,
  getToken,
  onImported,
  onCancel,
}: PairedImportPanelProps) {
  const t = useT()
  const [step, setStep] = useState<PanelStep>("file")
  const [error, setError] = useState<string | null>(null)
  const [sheets, setSheets] = useState<SpreadsheetSheet[]>([])
  const [selectedSheet, setSelectedSheet] = useState<SpreadsheetSheet | null>(null)
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [matchResult, setMatchResult] = useState<PairedMatchResult | null>(null)
  const [selectedCellIds, setSelectedCellIds] = useState<Set<string>>(new Set())

  const handleFile = useCallback(async (file: File) => {
    setError(null)
    setSourceFile(file)
    const ext = file.name.split(".").pop()?.toLowerCase()
    try {
      assertSourceUploadByteLength(file.size)
      if (ext === "xls") {
        setError(t("importExport.spreadsheet.legacyXlsUnsupported"))
        return
      }
      if (ext === "xlsx") {
        const buf = await file.arrayBuffer()
        const parsed = await parseXlsxToSheets(buf)
        if (parsed.length === 0) {
          setError(t("importExport.spreadsheet.noSheetsFound"))
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
        const text = decodeImportText(await file.arrayBuffer(), file.name)
        const sheet = parseCsvToSheet(text, file.name)
        setSheets([sheet])
        setSelectedSheet(sheet)
        setStep("mapping")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("importExport.errors.failedToParseFile"))
    }
  }, [t])

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
    if (!matchResult || !sourceFile) return
    setStep("importing")
    setError(null)
    try {
      // PairedMatchResult is structurally identical to EBibleMatchResult
      const { committedCount } = await applyEBibleTargetImport(
        matchResult as Parameters<typeof applyEBibleTargetImport>[0],
        selectedCellIds,
        {
          projectId,
          author: username,
          getToken,
          targetLang,
          sourceArtifact: {
            name: sourceFile.name,
            bytes: await sourceFile.arrayBuffer(),
            format: sourceFile.name.toLowerCase().endsWith(".xlsx")
              ? "xlsx"
              : sourceFile.name.toLowerCase().endsWith(".tsv")
                ? "tsv"
                : "csv",
          },
        },
      )
      onImported(committedCount)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("importExport.errors.importFailed"))
      setStep("review")
    }
  }

  // ── Step: file selection ────────────────────────────────────────────────────
  if (step === "file") {
    return (
      <div className="flex flex-col gap-4 py-2">
        <div>
          <p className="text-sm font-medium">{t("importExport.paired.title")}</p>
          <p className="text-xs text-muted-foreground">
            {t("importExport.paired.description")}
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
          <p className="text-sm text-muted-foreground">{t("importExport.spreadsheet.dropZoneHint")}</p>
          <label>
            <span className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors">
              {t("editor.video.chooseFile")}
            </span>
            <input
              type="file"
              accept=".csv,.tsv,.xlsx"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFile(file)
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">{t("importExport.spreadsheet.acceptedFormats")}</p>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
        </div>
      </div>
    )
  }

  // ── Step: sheet selection (XLSX with multiple sheets) ──────────────────────
  if (step === "sheet") {
    return (
      <div className="flex flex-col gap-4 py-2">
        <div>
          <p className="text-sm font-medium">{t("importExport.spreadsheet.selectSheetTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("importExport.spreadsheet.selectSheetHint")}</p>
        </div>
        <div className="flex flex-col gap-2">
          {sheets.map((s, i) => (
            <button
              key={i}
              type="button"
              className="rounded-lg border p-3 text-start hover:border-primary hover:bg-primary/5 transition-colors"
              onClick={() => {
                setSelectedSheet(s)
                setStep("mapping")
              }}
            >
              <p className="text-sm font-medium">{s.name}</p>
              <p className="text-xs text-muted-foreground">{t("importExport.spreadsheet.sheetRowCount", { count: s.rows.length })}</p>
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
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
          <p className="text-sm font-medium">{t("importExport.review.title")}</p>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>{t("importExport.review.matchedCount", { count: matched.length })}</span>
            {conflicts.length > 0 && <span className="text-amber-600">{t("importExport.review.conflictCount", { count: conflicts.length })}</span>}
            {orphans.length > 0 && <span>{t("importExport.review.unmatchedRowCount", { count: orphans.length })}</span>}
            {unmatchedSourceCount > 0 && <span>{t("importExport.review.uncoveredSourceCellCount", { count: unmatchedSourceCount })}</span>}
          </div>
        </div>

        <ScrollArea className="max-h-60 rounded-md border">
          <div className="divide-y">
            {matched.map((m) => (
              <label key={m.cellId} className="flex items-start gap-2 px-3 py-2 hover:bg-muted/30">
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
                      {t("importExport.review.replacesExisting", { text: m.currentText })}
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
            {selectedCellIds.size === matched.length ? t("importExport.review.deselectAll") : t("common.selectAll")}
          </button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
            <Button
              disabled={selectedCellIds.size === 0}
              onClick={handleApply}
            >
              {t("importExport.review.importCellCount", { count: selectedCellIds.size })}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ── Step: importing ─────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-8">
      <p className="text-sm font-medium">{t("importExport.action.importing")}</p>
      <p className="text-xs text-muted-foreground">{t("importExport.paired.applyingTargets")}</p>
    </div>
  )
}
