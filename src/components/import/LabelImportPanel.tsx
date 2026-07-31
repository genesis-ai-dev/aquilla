/**
 * AQU-438: Cell-label / cast import via downloadable spreadsheet template.
 * AQU-439: Now splits angle-embedded labels ("Mary Magdalene   (on)") into
 *           voice name + cameraState before emitting cast.assign.
 * AQU-314: Step 1 now has an explicit file picker. The panel fetches the
 *           selected file's source cells from the server on demand, so the
 *           template and the ref-matching no longer silently depend on which
 *           file happened to be open in the editor (the old `sourceCells`
 *           prop was the active file's cells only — downloading a template
 *           for one file and importing while another was active matched
 *           nothing).
 *
 * Flow:
 *   1. User picks a file and downloads a pre-populated CSV template
 *      (one row per source cell ref)
 *   2. PM fills in the cast_name (and optionally note) column.
 *      cast_name may contain a trailing "(angle)" group, e.g. "Mary (on)".
 *   3. User re-uploads the filled template
 *   4. Labels are applied to cells via the cast.assign event (non-chain-mutating;
 *      does NOT touch target text). If an angle was present it is split out and
 *      set on cameraState in the same event.
 *
 * This panel is shown from the ImportDialog landing (new "Cell Labels" card).
 */

import { useState, useCallback, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
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
import { fetchAllFileCells } from "@/lib/sync/cells-read"
import { generateLabelTemplate, parseCsvRows, splitCastName } from "@/lib/parsers/spreadsheet"
import { emitCastAssign } from "@/lib/sync/events-emit"
import { decodeImportText, MAX_UNKNOWN_TEXT_BYTES } from "@/lib/import/ai-recipe"

/** Outcome of an apply run, surfaced by the host as a result notice after the
 *  dialog closes (the panel itself unmounts on completion). */
export interface LabelImportResult {
  /** cast.assign events emitted (refs that matched a cell). */
  applied: number
  /** CSV refs that matched no cell in the selected file. */
  unmatched: number
  /** Display name of the file the labels were applied to. */
  fileName: string
}

export interface LabelImportPanelProps {
  projectId: string
  username: string
  /** Project files selectable in step 1. */
  files: { id: string; name: string }[]
  /** Pre-selected file — the workspace's active file when the dialog opened. */
  defaultFileId?: string | null
  /** Mints a sync token scoped to (projectId, fileId) for the cell read. */
  getToken: (fileId: string) => Promise<string | null>
  onImported: (result: LabelImportResult) => void
  onCancel: () => void
}

/** The slice of a source cell the label importer needs. */
interface LabelCellRef {
  cellId: string
  fileId: string
  canonicalRef: string | null
}

export function LabelImportPanel({
  projectId,
  username,
  files,
  defaultFileId,
  getToken,
  onImported,
  onCancel,
}: LabelImportPanelProps) {
  const [phase, setPhase] = useState<"idle" | "importing" | "done">("idle")
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{
    ref: string
    castName: string
    /** AQU-439: camera angle extracted from the cast_name string, or undefined */
    cameraState: "on" | "mixed" | "off" | undefined
  }[] | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)

  // AQU-314: file picker + server-fresh cells for the selected file.
  const [selectedFileId, setSelectedFileId] = useState<string>(() =>
    defaultFileId && files.some((f) => f.id === defaultFileId)
      ? defaultFileId
      : files[0]?.id ?? "",
  )
  const [fileCells, setFileCells] = useState<LabelCellRef[] | null>(null)
  const [cellsError, setCellsError] = useState<string | null>(null)

  const selectedFile = files.find((f) => f.id === selectedFileId)

  useEffect(() => {
    if (!selectedFileId) return
    let cancelled = false
    setFileCells(null)
    setCellsError(null)
    void (async () => {
      try {
        const token = await getToken(selectedFileId)
        if (!token) throw new Error("Could not mint a sync token for this file.")
        const rows = await fetchAllFileCells(projectId, selectedFileId, token, "source")
        if (cancelled) return
        setFileCells(
          rows.map((r) => ({
            cellId: r.cellId,
            fileId: selectedFileId,
            canonicalRef: r.canonicalRef,
          })),
        )
      } catch (err) {
        if (!cancelled) {
          setCellsError(err instanceof Error ? err.message : "Failed to load cells for this file")
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, selectedFileId, getToken])

  const refCount = fileCells?.filter((c) => c.canonicalRef).length ?? 0

  /** Download the template CSV for the selected file. */
  function handleDownloadTemplate() {
    if (!fileCells) return
    const refs = fileCells
      .map((c) => c.canonicalRef)
      .filter((r): r is string => Boolean(r))
    const csv = generateLabelTemplate(refs)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    // Name the download after the file so a template can't silently be
    // filled for one file and re-imported against another.
    a.download = selectedFile ? `cell-labels-${selectedFile.name}.csv` : "cell-labels-template.csv"
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
      if (file.size === 0) throw new Error("The label CSV is empty.")
      if (file.size > MAX_UNKNOWN_TEXT_BYTES) throw new Error("The label CSV exceeds the 10 MB safety limit.")
      const text = decodeImportText(await file.arrayBuffer(), file.name)
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
          // AQU-439: split angle suffix from name ("Mary (on)" → voice + cameraState)
          const { voice, cameraState } = splitCastName(rawCast)
          entries.push({ ref, castName: voice, cameraState })
        }
      }
      setPreview(entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse file")
    }
  }, [])

  /** Apply the cast labels via cast.assign events (AQU-438).
   *
   * For each row in the preview:
   *   - Look up the cellId from the selected file's cells by canonicalRef.
   *   - Emit a cast.assign event (non-chain-mutating; does NOT write target text).
   *   - Collect unmatched refs and report them to the user.
   */
  async function handleImport() {
    if (!preview || preview.length === 0 || !fileCells) return
    setPhase("importing")
    setError(null)

    // Build a lookup: canonicalRef → { cellId, fileId }
    const byRef = new Map<string, { cellId: string; fileId: string }>()
    for (const cell of fileCells) {
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
          // AQU-439: forward camera angle when it was present in the import row
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

    // The host closes the dialog on completion, so the outcome (including
    // unmatched refs) is reported via the result callback — an inline error
    // here would unmount before it could be read.
    setPhase("done")
    onImported({
      applied: preview.length - unmatched.length,
      unmatched: unmatched.length,
      fileName: selectedFile?.name ?? "",
    })
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <div>
        <p className="text-sm font-medium">Cell Labels / Cast Import</p>
        <p className="text-xs text-muted-foreground">
          Download a template with a file's cell references, fill in cast names, then re-upload.
        </p>
      </div>

      {/* Step 1: Pick file + download template */}
      <div className="rounded-lg border p-4 flex flex-col gap-2">
        <p className="text-xs font-semibold">Step 1 — Choose file &amp; download template</p>
        <Select
          items={files.map((f) => ({ value: f.id, label: f.name }))}
          value={selectedFileId}
          onValueChange={(v) => setSelectedFileId(v ?? "")}
        >
          <SelectTrigger size="sm" className="w-full text-xs">
            <SelectValue placeholder="Choose a file…" />
          </SelectTrigger>
          <SelectContent>
            {files.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {fileCells === null && !cellsError
            ? "Loading cells…"
            : `${refCount} cells with references in ${selectedFile?.name ?? "this file"}.`}
        </p>
        {cellsError && <p className="text-xs text-destructive">{cellsError}</p>}
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={handleDownloadTemplate}
          disabled={refCount === 0}
        >
          Download CSV template
        </Button>
      </div>

      {/* Step 2: Upload filled template */}
      <div className="rounded-lg border p-4 flex flex-col gap-2">
        <p className="text-xs font-semibold">Step 2 — Upload filled template</p>
        <label>
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
          <Button size="sm" onClick={handleImport} disabled={fileCells === null}>
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
