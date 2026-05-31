// ExportDialog: pick format + scope, then trigger the appropriate exporter or
// server-side USFM download. Project scope zips each file's cells client-side
// (except USFM, which uses the server side-car route).
//
// For non-USFM formats, project scope uses useProjectCells to fan-out over all
// project files (up to MAX_FILES=40) and buildProjectZip to produce a zip.

import { useState } from "react"
import { Download, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { downloadBlob } from "@/lib/export/export-service"
import { downloadSourceFile, downloadProjectZip } from "@/lib/sync/source-export"
import { exportPlainText } from "@/lib/export/exporters/plaintext"
import { exportMarkdown } from "@/lib/export/exporters/markdown"
import { exportTsv } from "@/lib/export/exporters/tsv"
import { exportCsv } from "@/lib/export/exporters/csv"
import { exportXliff } from "@/lib/export/exporters/xliff"
import { exportTmx } from "@/lib/export/exporters/tmx"
import { buildProjectZip } from "@/lib/export/project-zip-export"
import { useProjectCells } from "@/hooks/useProjectCells"
import type { CellData } from "@/hooks/useCells"

export type ExportFormat = "usfm" | "txt" | "md" | "tsv" | "csv" | "xlf" | "tmx"
export type ExportScope = "file" | "project"

interface FormatOption {
  id: ExportFormat
  label: string
  ext: string
  description: string
  lossy: boolean
}

const FORMAT_OPTIONS: FormatOption[] = [
  {
    id: "usfm",
    label: "USFM",
    ext: ".SFM",
    description: "Round-trip USFM with translations injected back into the original markup. Requires server side-car bytes (re-import to enable for older files).",
    lossy: false,
  },
  {
    id: "txt",
    label: "Plain text",
    ext: ".txt",
    description: "Translated segments, one per line.",
    lossy: true,
  },
  {
    id: "md",
    label: "Markdown",
    ext: ".md",
    description: "Translated segments with canonical ref anchors.",
    lossy: true,
  },
  {
    id: "tsv",
    label: "Bilingual TSV",
    ext: ".tsv",
    description: "id/source/target tab-separated, one row per segment.",
    lossy: true,
  },
  {
    id: "csv",
    label: "Bilingual CSV",
    ext: ".csv",
    description: "RFC 4180 id/source/target, one row per segment.",
    lossy: true,
  },
  {
    id: "xlf",
    label: "XLIFF 1.2",
    ext: ".xlf",
    description: "Generic bilingual XLIFF for CAT tool import.",
    lossy: true,
  },
  {
    id: "tmx",
    label: "TMX 1.4b",
    ext: ".tmx",
    description: "Translation memory exchange — segments with source + target.",
    lossy: true,
  },
]

interface ExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Cells for the currently active file. */
  cells: CellData[]
  projectId: string
  projectName: string
  /** The active file's id, used for USFM file-scope export. */
  activeFileId: string | null
  /** The active file's display name. */
  activeFileName: string | null
  /** Whether the active file is a USFM file — enables USFM option. */
  isUsfmFile: boolean
  /** All project files — used only for project-scope USFM zip. */
  projectFiles: { id: string; name: string; type: string }[]
  sourceLanguage?: string
  targetLanguage?: string
  getToken: (fileId: string) => Promise<string | null>
}

export function ExportDialog({
  open,
  onOpenChange,
  cells,
  projectId,
  projectName,
  activeFileId,
  activeFileName,
  isUsfmFile,
  projectFiles,
  sourceLanguage = "und",
  targetLanguage = "und",
  getToken,
}: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>(isUsfmFile ? "usfm" : "tsv")
  const [scope, setScope] = useState<ExportScope>("file")
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "busy"; msg: string }
    | { kind: "error"; msg: string }
    | { kind: "ok"; msg: string }
  >({ kind: "idle" })

  const selectedFormat = FORMAT_OPTIONS.find((f) => f.id === format)!
  const isLossy = selectedFormat.lossy

  // Load cells for all project files when project scope is selected and the
  // format is a client-side one. Disabled until the user actually picks
  // project scope so we don't fan-out N fetches on dialog open.
  const projectScopeEnabled = scope === "project" && format !== "usfm"

  const { files: projectFileCells, isLoading: projectCellsLoading, isTruncated } =
    useProjectCells({
      projectId,
      projectFiles,
      getToken,
      enabled: projectScopeEnabled,
    })

  async function handleExport() {
    if (!activeFileId) return
    setStatus({ kind: "busy", msg: "Exporting…" })
    try {
      if (format === "usfm") {
        if (scope === "project") {
          const result = await downloadProjectZip({
            projectId,
            projectName,
            files: projectFiles,
            getToken,
            onProgress: (done, total) =>
              setStatus({ kind: "busy", msg: `Downloading ${done}/${total}…` }),
          })
          const msg = result.skipped.length === 0
            ? `Exported ${result.exported} files`
            : `Exported ${result.exported}; skipped ${result.skipped.length} (older imports — re-import to enable)`
          setStatus({ kind: "ok", msg })
        } else {
          const name = activeFileName ?? "export"
          const downloadName = /\.(sfm|usfm)$/i.test(name) ? name : `${name}.SFM`
          await downloadSourceFile({ projectId, fileId: activeFileId, downloadName, getToken })
          setStatus({ kind: "ok", msg: `Exported ${downloadName}` })
        }
      } else if (scope === "project") {
        // Client-side project-scope zip: use already-loaded per-file cells.
        if (projectCellsLoading) {
          setStatus({ kind: "busy", msg: "Still loading file cells, please wait…" })
          return
        }
        setStatus({ kind: "busy", msg: `Building zip for ${projectFileCells.length} files…` })
        const zipBlob = await buildProjectZip({
          files: projectFileCells,
          format,
          sourceLanguage,
          targetLanguage,
        })
        const safeName = projectName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
        const ext = selectedFormat.ext
        downloadBlob(zipBlob, `${safeName || "project"}${ext}.zip`)
        const truncNote = isTruncated ? " (first 40 files only)" : ""
        setStatus({ kind: "ok", msg: `Downloaded ${projectFileCells.length} files${truncNote}` })
      } else {
        // Client-side single-file exporter
        let blob: Blob
        const baseName = (activeFileName ?? "export").replace(/\.[^.]+$/, "")
        const ext = selectedFormat.ext
        switch (format) {
          case "txt":
            blob = exportPlainText(cells)
            break
          case "md":
            blob = exportMarkdown(cells)
            break
          case "tsv":
            blob = exportTsv(cells)
            break
          case "csv":
            blob = exportCsv(cells)
            break
          case "xlf":
            blob = exportXliff(cells, sourceLanguage, targetLanguage)
            break
          case "tmx":
            blob = exportTmx(cells, sourceLanguage, targetLanguage)
            break
          default:
            throw new Error(`Unknown format: ${format}`)
        }
        downloadBlob(blob, `${baseName}${ext}`)
        setStatus({ kind: "ok", msg: `Downloaded ${baseName}${ext}` })
      }
    } catch (e) {
      setStatus({ kind: "error", msg: (e as Error).message || "Export failed." })
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) setStatus({ kind: "idle" })
    onOpenChange(next)
  }

  const isBusy = status.kind === "busy"

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
        </DialogHeader>

        {/* Format selector */}
        <fieldset className="flex flex-col gap-1.5 min-w-0">
          <legend className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
            Format
          </legend>
          <div
            className="flex flex-col gap-0.5 max-h-64 overflow-y-auto overscroll-contain pr-0.5"
            role="radiogroup"
            aria-label="Export format"
          >
            {FORMAT_OPTIONS.filter((f) => f.id !== "usfm" || isUsfmFile).map((f) => (
              <label
                key={f.id}
                className={
                  "flex items-start gap-2.5 rounded-xl px-2.5 py-2 cursor-pointer transition-colors " +
                  (format === f.id
                    ? "bg-accent/60 ring-1 ring-ring/20"
                    : "hover:bg-accent/40")
                }
              >
                <input
                  type="radio"
                  name="export-format"
                  value={f.id}
                  checked={format === f.id}
                  onChange={() => setFormat(f.id)}
                  className="mt-0.5 shrink-0 accent-primary"
                  aria-label={`${f.label} (${f.ext})`}
                />
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-medium leading-tight flex items-baseline gap-1.5 flex-wrap">
                    {f.label}
                    <span className="text-xs text-muted-foreground font-normal font-mono">{f.ext}</span>
                    {f.lossy && (
                      <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold uppercase tracking-wider">
                        lossy
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground leading-relaxed">{f.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* Scope selector */}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
            Scope
          </legend>
          <div
            className="inline-flex items-center gap-0.5 rounded-full bg-muted/40 p-0.5 self-start"
            role="radiogroup"
            aria-label="Export scope"
          >
            {(["file", "project"] as const).map((s) => (
              <label
                key={s}
                className={
                  "inline-flex h-6 items-center rounded-full px-3 text-[11px] font-medium tracking-tight cursor-pointer transition-colors " +
                  (scope === s
                    ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/5"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                <input
                  type="radio"
                  name="export-scope"
                  value={s}
                  checked={scope === s}
                  onChange={() => setScope(s)}
                  className="sr-only"
                />
                {s === "file" ? "Current file" : "Whole project"}
              </label>
            ))}
          </div>

          {/* Project-scope notices */}
          {scope === "project" && format !== "usfm" && projectCellsLoading && (
            <div className="flex items-center gap-1.5 mt-1">
              <Skeleton className="h-2 w-2 rounded-full shrink-0" />
              <Skeleton className="h-3 w-40" />
            </div>
          )}
          {scope === "project" && format !== "usfm" && isTruncated && (
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400 mt-1">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              This project has more than 40 files — zip will include the first 40 only.
              {/* SWARM-TODO(project-export-scale): server batch-export endpoint for
                  large projects; see src/hooks/useProjectCells.ts for the proposed shape. */}
            </p>
          )}
        </fieldset>

        {/* Lossy warning banner */}
        {isLossy && (
          <div
            className="flex items-start gap-2 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300"
            role="note"
            aria-label="Lossy format warning"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              This format is lossy — inline markup, paragraph structure, and some metadata will not
              round-trip back to the original format.
            </span>
          </div>
        )}

        {/* Status feedback */}
        {status.kind !== "idle" && (
          <div
            role="status"
            aria-live="polite"
            className={
              "flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm " +
              (status.kind === "error"
                ? "bg-destructive/10 text-destructive"
                : status.kind === "ok"
                  ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400"
                  : "bg-muted/60 text-muted-foreground")
            }
          >
            {status.kind === "busy" && (
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
            )}
            {status.kind === "ok" && (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            {status.kind === "error" && (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            <span>{status.msg}</span>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isBusy}>
            Cancel
          </Button>
          <Button
            onClick={handleExport}
            disabled={!activeFileId || isBusy}
            aria-busy={isBusy}
          >
            {isBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="h-4 w-4" aria-hidden="true" />
            )}
            {isBusy ? "Exporting…" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
