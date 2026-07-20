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
import { applyEBibleTargetImport } from "@/lib/import"
import { decodeImportText } from "@/lib/import/ai-recipe"
import { assertSourceUploadByteLength } from "@/lib/sync/source-upload"
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
  /** Target-lane storage key. Empty/absent means the project's default lane. */
  targetLang?: string
  /** Display name of the open file — shown so the user knows the import scope. */
  fileName: string
  /** The open file's cells, in display order. */
  cells: FileTargetCellRef[]
  getToken: (fileId: string) => Promise<string | null>
  onImported: (committedCount: number) => void
  onCancel: () => void
  /** Surfaced alongside the inline error so the host can instrument failures. */
  onError?: (message: string, phase: "parse" | "apply") => void
  /** Optimistically patch many cells at once so the editor reflects the
   *  imported translations before the outbox finishes flushing. */
  applyOptimisticTargetEdits: (patches: { cellId: string; value: string }[]) => void
  /** AQU-634: per-project USFM front-matter opt-out. When on, the incoming USFM
   *  target rows exclude book-name/title/TOC + intro-block cells, staying
   *  aligned with source cells imported under the same setting. */
  excludeFrontMatter?: boolean
}

type PanelStep = "file" | "sheet" | "mapping" | "review"

const USFM_EXTENSIONS = new Set(["usfm", "sfm", "usf"])
const SHEET_EXTENSIONS = new Set(["csv", "tsv", "xlsx"])

export function FileTargetImportPanel({
  projectId,
  username,
  targetLang,
  fileName,
  cells,
  getToken,
  onImported,
  onCancel,
  onError,
  applyOptimisticTargetEdits,
  excludeFrontMatter,
}: FileTargetImportPanelProps) {
  const [step, setStep] = useState<PanelStep>("file")
  const [error, setError] = useState<string | null>(null)
  const [sheets, setSheets] = useState<SpreadsheetSheet[]>([])
  const [selectedSheet, setSelectedSheet] = useState<SpreadsheetSheet | null>(null)
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [matchResult, setMatchResult] = useState<FileTargetMatchResult | null>(null)
  const [matchedByOrder, setMatchedByOrder] = useState(false)
  const [selectedCellIds, setSelectedCellIds] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)

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
    setSourceFile(file)
    const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
    try {
      assertSourceUploadByteLength(file.size)
      if (USFM_EXTENSIONS.has(ext)) {
        const rows = usfmToTargetRows(decodeImportText(await file.arrayBuffer(), file.name), {
          excludeFrontMatter,
        })
        if (rows.length === 0) {
          setError("No verses found in this USFM file.")
          return
        }
        showReview(matchTargetRowsByRef(rows, cells), false)
      } else if (ext === "xls") {
        setError("Legacy .xls workbooks are not supported. Save the file as .xlsx or CSV and try again.")
        return
      } else if (ext === "xlsx") {
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
        const sheet = parseCsvToSheet(decodeImportText(await file.arrayBuffer(), file.name), file.name)
        setSheets([sheet])
        setSelectedSheet(sheet)
        setStep("mapping")
      } else {
        setError("Unsupported file type. Use USFM (.usfm/.sfm) or a spreadsheet (.csv/.tsv/.xlsx).")
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to parse file"
      setError(message)
      onError?.(message, "parse")
    }
  }, [cells, showReview, onError, excludeFrontMatter])

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
    // Guard against double-submit: a second click while the enqueue is in
    // flight would re-optimistic-patch and re-enqueue the same cells.
    if (!matchResult || !sourceFile || applying) return
    setApplying(true)
    setError(null)
    const selected = matchResult.matched.filter((m) => selectedCellIds.has(m.cellId))
    // Optimistic: show imported translations in the open editor immediately
    // (before the local enqueue settles) so the instant-render win is kept.
    applyOptimisticTargetEdits(selected.map((m) => ({ cellId: m.cellId, value: m.incomingText })))
    try {
      // Enqueue to the outbox (fast, local). The flusher drains in the background;
      // the sync badge + inspector surface progress / retry.
      const { committedCount } = await applyEBibleTargetImport(
        matchResult,
        selectedCellIds,
        {
          projectId,
          author: username,
          getToken,
          targetLang,
          sourceArtifact: {
            name: sourceFile.name,
            bytes: await sourceFile.arrayBuffer(),
            format: USFM_EXTENSIONS.has(sourceFile.name.split(".").pop()?.toLowerCase() ?? "")
              ? "usfm"
              : sourceFile.name.toLowerCase().endsWith(".xlsx")
                ? "xlsx"
                : sourceFile.name.toLowerCase().endsWith(".tsv")
                  ? "tsv"
                  : "csv",
          },
        },
      )
      onImported(committedCount) // closes the dialog — content is already visible + queued
    } catch (err) {
      // The enqueue failed, so nothing was queued — undo the optimistic patch
      // instead of leaving phantom translations in the cell store until a later
      // revalidate. Restore each cell's pre-import value (empty for fresh cells,
      // the prior translation for conflicts).
      applyOptimisticTargetEdits(selected.map((m) => ({ cellId: m.cellId, value: m.currentText })))
      const message = err instanceof Error ? err.message : "Import failed"
      setError(message)
      onError?.(message, "apply")
      setApplying(false)
    }
  }

  // ── Step: file selection ────────────────────────────────────────────────────
  if (step === "file") {
    return (
      <div className="flex flex-col gap-4 py-2">
        <div>
          <p className="text-sm font-medium">Import target translations into "{fileName}"</p>
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
            <span className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors">
              Choose file
            </span>
            <input
              type="file"
              accept=".usfm,.sfm,.usf,.csv,.tsv,.xlsx"
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
      <div className="flex min-h-0 flex-1 flex-col gap-3 py-2">
        <div className="shrink-0">
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

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
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
        </div>

        {error && <p className="shrink-0 text-xs text-destructive">{error}</p>}

        <div className="flex shrink-0 items-center justify-between">
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
              disabled={selectedCellIds.size === 0 || applying}
              onClick={handleApply}
            >
              Import {selectedCellIds.size} cell{selectedCellIds.size !== 1 ? "s" : ""}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // No blocking "importing" screen: the optimistic patch means the editor
  // already shows the result and handleApply calls onImported (closing the
  // dialog) as soon as the local enqueue accepts. This return only covers
  // transient/impossible states (e.g. a step with its data not yet set).
  return null
}
