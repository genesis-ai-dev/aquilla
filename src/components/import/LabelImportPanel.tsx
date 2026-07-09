/**
 * FRO-438: Cell-label / cast import via downloadable spreadsheet template.
 * FRO-439: Now splits angle-embedded labels ("Mary Magdalene   (on)") into
 *           voice name + cameraState before emitting cast.assign.
 *
 * Flow:
 *   1. User downloads a pre-populated CSV template (one row per source cell ref)
 *   2. PM fills in the cast_name (and optionally note) column.
 *      cast_name may contain a trailing "(angle)" group, e.g. "Mary (on)".
 *   3. User re-uploads the filled template
 *   4. Labels are applied to cells via the cast.assign event (non-chain-mutating;
 *      does NOT touch target text). If an angle was present it is split out and
 *      set on cameraState in the same event.
 *
 * This panel is shown from the ImportDialog landing (new "Cell Labels" card).
 * It requires `sourceCells` to generate the template and to match incoming
 * cast data back to cell ids.
 */

import { useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { SourceCellRef } from "@/lib/import"
import { generateLabelTemplate, parseCsvRows, splitCastName } from "@/lib/parsers/spreadsheet"
import { emitCastAssign } from "@/lib/sync/events-emit"

export interface LabelImportPanelProps {
  projectId: string
  username: string
  sourceCells: SourceCellRef[]
  getToken: (fileId: string) => Promise<string | null>
  onImported: () => void
  onCancel: () => void
}

export function LabelImportPanel({
  projectId,
  username,
  sourceCells,
  onImported,
  onCancel,
}: LabelImportPanelProps) {
  const [phase, setPhase] = useState<"idle" | "importing" | "done">("idle")
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{
    ref: string
    castName: string
    /** FRO-439: camera angle extracted from the cast_name string, or undefined */
    cameraState: "on" | "mixed" | "off" | undefined
  }[] | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)

  /** Download the template CSV. */
  function handleDownloadTemplate() {
    const refs = sourceCells
      .map((c) => c.canonicalRef)
      .filter((r): r is string => Boolean(r))
    const csv = generateLabelTemplate(refs)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "cell-labels-template.csv"
    a.click()
    URL.revokeObjectURL(url)
  }

  /** Parse the uploaded file and show a preview. */
  const handleFileInput = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setPreview(null)
    setPendingFile(file)
    try {
      const text = await file.text()
      const rows = parseCsvRows(text)
      if (rows.length === 0) {
        setError("No rows found in file.")
        return
      }
      // Detect header: first row should have "ref" and "cast_name"
      const hasHeader = rows[0].some((h) => h.trim().toLowerCase() === "ref" || h.trim().toLowerCase() === "cast_name")
      const headerRow = hasHeader ? rows[0] : null
      const lc = (headerRow ?? []).map((h) => h.trim().toLowerCase())
      const refCol = lc.indexOf("ref") !== -1 ? lc.indexOf("ref") : 0
      const castCol = lc.indexOf("cast_name") !== -1 ? lc.indexOf("cast_name") : 1

      const dataRows = hasHeader ? rows.slice(1) : rows
      const entries: { ref: string; castName: string; cameraState: "on" | "mixed" | "off" | undefined }[] = []
      for (const row of dataRows) {
        const ref = (row[refCol] ?? "").trim()
        const rawCast = (row[castCol] ?? "").trim()
        if (ref && rawCast) {
          // FRO-439: split angle suffix from name ("Mary (on)" → voice + cameraState)
          const { voice, cameraState } = splitCastName(rawCast)
          entries.push({ ref, castName: voice, cameraState })
        }
      }
      setPreview(entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse file")
    }
  }, [])

  /** Apply the cast labels via cast.assign events (FRO-438).
   *
   * For each row in the preview:
   *   - Look up the cellId from sourceCells by canonicalRef.
   *   - Emit a cast.assign event (non-chain-mutating; does NOT write target text).
   *   - Collect unmatched refs and report them to the user.
   */
  async function handleImport() {
    if (!preview || preview.length === 0) return
    setPhase("importing")
    setError(null)

    // Build a lookup: canonicalRef → { cellId, fileId }
    const byRef = new Map<string, { cellId: string; fileId: string }>()
    for (const cell of sourceCells) {
      if (cell.canonicalRef && !byRef.has(cell.canonicalRef)) {
        byRef.set(cell.canonicalRef, { cellId: cell.cellId, fileId: cell.fileId })
      }
    }

    const unmatched: string[] = []
    const emits: Promise<string>[] = []

    for (const { ref, castName, cameraState } of preview) {
      const cell = byRef.get(ref)
      if (!cell) {
        unmatched.push(ref)
        continue
      }
      emits.push(
        emitCastAssign({
          projectId,
          fileId: cell.fileId,
          cellId: cell.cellId,
          castName,
          // FRO-439: forward camera angle when it was present in the import row
          ...(cameraState !== undefined ? { cameraState } : {}),
          author: username,
        }),
      )
    }

    try {
      await Promise.all(emits)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply labels")
      setPhase("idle")
      return
    }

    const matched = preview.length - unmatched.length
    if (unmatched.length > 0) {
      setError(
        `Applied ${matched} label${matched !== 1 ? "s" : ""}. ` +
        `${unmatched.length} ref${unmatched.length !== 1 ? "s" : ""} not matched to any cell: ` +
        unmatched.slice(0, 10).join(", ") +
        (unmatched.length > 10 ? ` …and ${unmatched.length - 10} more` : ""),
      )
    }
    setPhase("done")
    onImported()
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <div>
        <p className="text-sm font-medium">Cell Labels / Cast Import</p>
        <p className="text-xs text-muted-foreground">
          Download a template with your project's cell references, fill in cast names, then re-upload.
        </p>
      </div>

      {/* Step 1: Download template */}
      <div className="rounded-lg border p-4 flex flex-col gap-2">
        <p className="text-xs font-semibold">Step 1 — Download template</p>
        <p className="text-xs text-muted-foreground">
          {sourceCells.filter(c => c.canonicalRef).length} cells with references found in this project.
        </p>
        <Button variant="outline" size="sm" className="w-fit" onClick={handleDownloadTemplate}>
          Download CSV template
        </Button>
      </div>

      {/* Step 2: Upload filled template */}
      <div className="rounded-lg border p-4 flex flex-col gap-2">
        <p className="text-xs font-semibold">Step 2 — Upload filled template</p>
        <label className="cursor-pointer">
          <span className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors">
            Choose file
          </span>
          <input
            type="file"
            accept=".csv,.tsv"
            className="sr-only"
            onChange={handleFileInput}
          />
        </label>
        {pendingFile && (
          <p className="text-xs text-muted-foreground">{pendingFile.name}</p>
        )}
      </div>

      {/* Preview */}
      {preview && preview.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium">
            {preview.length} label{preview.length !== 1 ? "s" : ""} to import
          </p>
          <ScrollArea className="max-h-40 rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ref</TableHead>
                  <TableHead>Voice</TableHead>
                  <TableHead>Camera</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.slice(0, 20).map((p, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono">{p.ref}</TableCell>
                    <TableCell>{p.castName}</TableCell>
                    <TableCell className="text-muted-foreground">{p.cameraState ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
          {preview.length > 20 && (
            <p className="mt-1 text-xs text-muted-foreground">…and {preview.length - 20} more</p>
          )}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Actions */}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {preview && preview.length > 0 && phase === "idle" && (
          <Button size="sm" onClick={handleImport}>
            Import {preview.length} label{preview.length !== 1 ? "s" : ""}
          </Button>
        )}
        {phase === "importing" && (
          <Button size="sm" disabled>
            Importing…
          </Button>
        )}
      </div>
    </div>
  )
}
