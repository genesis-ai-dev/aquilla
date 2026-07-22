/**
 * AQU-316: General spreadsheet importer (CSV + XLSX) with on-the-fly column
 * mapping. After mapping, parsed cells go through the standard preview →
 * confirm → bulkUploadSource pipeline (same as UploadPanel).
 *
 * XLSX support uses the shared central-directory-aware workbook reader. Each
 * sheet in an XLSX workbook is one importable unit (the user picks which sheet).
 */

import { useState, useCallback, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import type { FileReference, FileType, ProjectTtsSettings } from "@/lib/parsers/types"
import {
  parseCsvToSheet,
  parseXlsxToSheets,
  applyColumnMapping,
  mappedRowsToStrings,
  type SpreadsheetSheet,
  type ColumnMapping,
} from "@/lib/parsers/spreadsheet"
import { importFile, type ImportResult, type ImportContext } from "@/lib/import"
import type { PreparedImportFile } from "@/lib/import/import-service"
import { buildCastAdditions } from "@/lib/import/cast-from-speakers"
import { decodeImportText } from "@/lib/import/ai-recipe"
import { assertSourceUploadByteLength } from "@/lib/sync/source-upload"
import { v7 as uuidv7 } from "uuid"
import { ColumnMappingPanel } from "./ColumnMappingPanel"

export interface SpreadsheetImportPanelProps {
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  /** Active target-language lane. Empty/undefined is the default lane. */
  targetLang?: string
  getToken: (fileId: string) => Promise<string | null>
  ttsSettings?: ProjectTtsSettings
  onCastUpdated?: (settings: Partial<ProjectTtsSettings>) => void | Promise<void>
  onPreview?: (results: ImportResult[], commit: () => Promise<void>) => void
  /** Surface failures after the mapping panel unmounts for preview. */
  onCommitError?: (message: string | null) => void
  onImported: (refs: FileReference[]) => void | Promise<void>
  onCancel: () => void
  /** File handed off from the general dropzone. It is parsed exactly once on
   * mount so CSV/TSV/XLSX always receive explicit column mapping. */
  initialFile?: File | null
}

type Step = "file" | "sheet" | "mapping" | "uploading"

export function SpreadsheetImportPanel({
  projectId,
  username,
  sourceLanguage,
  targetLanguage,
  targetLang,
  getToken,
  ttsSettings,
  onCastUpdated,
  onPreview,
  onCommitError,
  onImported,
  onCancel,
  initialFile,
}: SpreadsheetImportPanelProps) {
  const [step, setStep] = useState<Step>("file")
  const [error, setError] = useState<string | null>(null)
  const [sheets, setSheets] = useState<SpreadsheetSheet[]>([])
  const [selectedSheet, setSelectedSheet] = useState<SpreadsheetSheet | null>(null)
  const [fileName, setFileName] = useState("")
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const consumedInitialFile = useRef<File | null>(null)
  const commitCheckpoint = useRef<{
    refs: FileReference[]
    speakerPairs: { cellId: string; speaker: string | undefined }[]
    castApplied: boolean
  } | null>(null)

  const handleFile = useCallback(async (file: File) => {
    setError(null)
    commitCheckpoint.current = null
    setFileName(file.name)
    setSourceFile(file)
    const ext = file.name.split(".").pop()?.toLowerCase()
    try {
      assertSourceUploadByteLength(file.size)
      if (ext === "xls") {
        setError("Legacy .xls workbooks are not supported. Save the file as .xlsx or CSV and try again.")
        return
      }
      if (ext === "xlsx") {
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
        const text = decodeImportText(await file.arrayBuffer(), file.name)
        const sheet = parseCsvToSheet(text, file.name)
        setSheets([sheet])
        setSelectedSheet(sheet)
        setStep("mapping")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse file")
    }
  }, [])

  useEffect(() => {
    if (!initialFile || consumedInitialFile.current === initialFile) return
    consumedInitialFile.current = initialFile
    void handleFile(initialFile)
  }, [handleFile, initialFile])

  async function handleMappingConfirm(mapping: ColumnMapping, hasHeader: boolean) {
    if (!selectedSheet || !sourceFile) return
    setError(null)

    const mappedRows = applyColumnMapping(selectedSheet.rows, mapping, hasHeader)
    if (mappedRows.length === 0) {
      setError("No data rows found after applying the mapping. Check that the source column is not empty.")
      return
    }

    const strings = mappedRowsToStrings(mappedRows)
    const sheetName = selectedSheet.name === fileName ? fileName : `${fileName} — ${selectedSheet.name}`
    const sourceFormat: FileType = sourceFile.name.toLowerCase().endsWith(".xlsx")
      ? "xlsx"
      : sourceFile.name.toLowerCase().endsWith(".tsv")
        ? "tsv"
        : "csv"
    const importResult: ImportResult = {
      name: sheetName,
      strings,
      rawBytes: await sourceFile.arrayBuffer(),
      rawSourceFormat: sourceFormat,
    }

    if (onPreview) {
      onPreview([importResult], async () => {
        await doCommit(importResult, mapping, sourceFormat)
      })
      return
    }

    setStep("uploading")
    await doCommit(importResult, mapping, sourceFormat)
  }

  async function doCommit(importResult: ImportResult, _mapping: ColumnMapping, sourceFormat: FileType) {
    setStep("uploading")
    onCommitError?.(null)
    try {
      const ctx: ImportContext = {
        projectId,
        author: username,
        sourceLanguage,
        targetLanguage,
        targetLang,
        getToken,
      }
      if (!sourceFile) throw new Error("The selected spreadsheet is no longer available")
      const prepared: PreparedImportFile = {
        fileType: sourceFormat,
        results: [importResult],
      }
      let checkpoint = commitCheckpoint.current
      if (!checkpoint) {
        const imported = await importFile(sourceFile, ctx, prepared)
        checkpoint = {
          refs: imported.refs,
          speakerPairs: imported.speakerPairs,
          castApplied: false,
        }
        commitCheckpoint.current = checkpoint
      }

      // Apply cast additions if any speaker/cast column was mapped
      if (!checkpoint.castApplied) {
        if (onCastUpdated && checkpoint.speakerPairs.some((p) => p.speaker)) {
          const additions = buildCastAdditions(checkpoint.speakerPairs, ttsSettings, uuidv7)
          await onCastUpdated({
            voices: additions.voices,
            castAssignments: {
              ...(ttsSettings?.castAssignments ?? {}),
              ...additions.castAssignments,
            },
          })
        }
        checkpoint.castApplied = true
      }

      await onImported(checkpoint.refs)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed"
      setError(message)
      onCommitError?.(message)
      setStep("mapping")
    }
  }

  // ── Step: file drop/select ──────────────────────────────────────────────────
  if (step === "file") {
    return (
      <div className="flex flex-col gap-4 py-2">
        <div>
          <p className="text-sm font-medium">Spreadsheet import</p>
          <p className="text-xs text-muted-foreground">
            Upload a CSV or XLSX file. You will map columns (source, target, ref, cast, timestamps) before importing.
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
              accept=".csv,.tsv,.xlsx"
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

  // ── Step: sheet selection ───────────────────────────────────────────────────
  if (step === "sheet") {
    return (
      <div className="flex flex-col gap-4 py-2">
        <div>
          <p className="text-sm font-medium">Select a sheet</p>
          <p className="text-xs text-muted-foreground">
            This XLSX has multiple sheets — each sheet is one importable unit.
          </p>
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
        {error && <p className="text-xs text-destructive">{error}</p>}
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

  // ── Step: uploading ─────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-8">
      <p className="text-sm font-medium">Uploading…</p>
      <p className="text-xs text-muted-foreground">Sending cells to the server.</p>
    </div>
  )
}
