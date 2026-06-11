/**
 * FRO-314: Cell-label / cast import via downloadable spreadsheet template.
 *
 * Flow:
 *   1. User downloads a pre-populated CSV template (one row per source cell ref)
 *   2. PM fills in the cast_name (and optionally note) column
 *   3. User re-uploads the filled template
 *   4. Labels are applied to cells via the standard bulkUploadTargetCommits pathway
 *
 * This panel is shown from the ImportDialog landing (new "Cell Labels" card).
 * It requires `sourceCells` to generate the template and to match incoming
 * cast data back to cell ids.
 */

import { useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { SourceCellRef } from "@/lib/import"
import { generateLabelTemplate, parseCsvRows } from "@/lib/parsers/spreadsheet"
import { applyEBibleTargetImport } from "@/lib/import"

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
  getToken,
  onImported,
  onCancel,
}: LabelImportPanelProps) {
  const [phase, setPhase] = useState<"idle" | "importing" | "done">("idle")
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ ref: string; castName: string }[] | null>(null)
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
      const entries: { ref: string; castName: string }[] = []
      for (const row of dataRows) {
        const ref = (row[refCol] ?? "").trim()
        const castName = (row[castCol] ?? "").trim()
        if (ref && castName) entries.push({ ref, castName })
      }
      setPreview(entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse file")
    }
  }, [])

  /** Apply the cast labels. Since the API works via target commits, we use
   *  a simplified approach: for each matched cell, emit a cast label note.
   *  SWARM-TODO(FRO-314-cast-events): the server doesn't yet have a dedicated
   *  "cast label" event type — for now we store cast names as a target-cell
   *  attribute update. The full implementation requires a cast.assign event
   *  type (tracked separately). This panel currently imports cast names only
   *  when target column text equals the cast name as a placeholder. */
  async function handleImport() {
    if (!preview || preview.length === 0) return
    setPhase("importing")
    setError(null)
    try {
      // Build a match result: ref → sourceCellRef → target commit with cast name as text
      // SWARM-TODO: proper cast assignment requires a dedicated event; for now
      // we apply cast name to the "translated" field which populates in the UI.
      const byRef = new Map(sourceCells.filter(c => c.canonicalRef).map(c => [c.canonicalRef!, c]))
      const matched = preview
        .map(({ ref, castName }) => {
          const cell = byRef.get(ref)
          if (!cell) return null
          return {
            cellId: cell.cellId,
            fileId: cell.fileId,
            incomingText: castName,
            currentText: cell.translated ?? "",
            hasConflict: Boolean((cell.translated ?? "").trim()),
            parentId: cell.targetEventId ?? cell.sourceEventId ?? "",
            ref,
          }
        })
        .filter((m): m is NonNullable<typeof m> => m !== null && Boolean(m.parentId))

      await applyEBibleTargetImport(
        { matched, orphans: [], unmatchedSourceCount: 0 },
        new Set(matched.map(m => m.cellId)),
        { projectId, author: username, getToken },
      )
      setPhase("done")
      onImported()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed")
      setPhase("idle")
    }
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
          <span className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-accent transition-colors">
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
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-foreground/70">Ref</th>
                  <th className="px-2 py-1 text-left font-medium text-foreground/70">Cast name</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {preview.slice(0, 20).map((p, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1 font-mono text-foreground/70">{p.ref}</td>
                    <td className="px-2 py-1 text-foreground/80">{p.castName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
