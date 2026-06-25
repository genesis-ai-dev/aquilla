// ExportDialog: pick format + scope, then trigger the appropriate exporter or
// server-side USFM download. Project scope zips each file's cells client-side
// (except USFM, which uses the server side-car route).
//
// For non-USFM formats, project scope uses useProjectCells to fan-out over all
// project files (up to MAX_FILES=40) and buildProjectZip to produce a zip.
//
// FRO-253 (b fix): auto-closes when canExport flips false after settings load,
// so a settings change mid-session doesn't leave the dialog open for a user who
// lost access.
//
// FRO-437: Filename control — editable base name with optional timestamp/lang
// tag appended at export time. The chosen name drives the downloaded filename
// for both single-file and project-scope exports.

import { useState, useEffect, useRef } from "react"
import { Download, AlertTriangle, CheckCircle2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import { downloadBlob } from "@/lib/export/export-service"
import { downloadSourceFile, downloadProjectZip, fetchSourceSidecar } from "@/lib/sync/source-export"
import { exportPlainText } from "@/lib/export/exporters/plaintext"
import { exportMarkdown } from "@/lib/export/exporters/markdown"
import { exportTsv } from "@/lib/export/exporters/tsv"
import { exportCsv } from "@/lib/export/exporters/csv"
import { exportXliff } from "@/lib/export/exporters/xliff"
import { exportTmx } from "@/lib/export/exporters/tmx"
import { exportVtt } from "@/lib/export/exporters/vtt"
import { exportPlainTextDump } from "@/lib/export/exporters/plain-text-dump"
import { buildProjectZip } from "@/lib/export/project-zip-export"
import type { TextExportFormat } from "@/lib/export/project-zip-export"
import { previewAudioByCharacter } from "@/lib/export/audio-by-character"
import { useProjectCells } from "@/hooks/useProjectCells"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

export type ExportFormat = "usfm" | "txt" | "md" | "tsv" | "csv" | "xlf" | "tmx" | "vtt" | "audio-by-character" | "docx" | "plain-text-dump"
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
    description: "Round-trip USFM with translations injected back into the original markup. Requires the original file data on the server (re-import to enable for older files).",
    lossy: false,
  },
  {
    // FRO-233: DOCX export with paragraph/heading structure preserved.
    // Only shown for files imported as .docx (isDocxFile prop).
    id: "docx",
    label: "Word (.docx)",
    ext: ".docx",
    description: "Translations injected back into the original Word document. Paragraph/heading structure is preserved; per-run bold/italic inside translated paragraphs is not preserved. Requires the original file to have been imported after round-trip export support was added (files larger than 512 KB at import may not support this).",
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
  {
    id: "vtt",
    label: "WebVTT (subtitles)",
    ext: ".vtt",
    description: "Subtitle file with timed cues. Cast-assigned cells are wrapped in <v Name> voice tags for round-trip speaker identity.",
    lossy: true,
  },
  {
    id: "audio-by-character",
    label: "Audio by character",
    ext: ".zip",
    description: "One WAV per cast member — each character's clips concatenated, best-available audio (recording → generated). Concatenated order = document order. Trim-honoring deferred; clips export full-length.",
    lossy: false,
  },
  // Advanced-only option — not shown in the main format list.
  {
    id: "plain-text-dump",
    label: "Plain-text dump",
    ext: ".txt",
    description: "Every translated segment, one per line. Quick content extraction only.",
    lossy: true,
  },
]

interface ExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * FRO-253 (b fix): whether org policy allows export. When this flips false
   * while the dialog is open (e.g. an owner raises the floor mid-session), the
   * dialog auto-closes so the user isn't left in an inconsistent state.
   * Defaults to true for non-org contexts.
   */
  canExport?: boolean
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
  /**
   * FRO-233: Whether the active file was imported as a .docx — enables the
   * Word (.docx) round-trip export option when a side-car blob exists.
   */
  isDocxFile?: boolean
  /** All project files — used only for project-scope USFM zip. */
  projectFiles: { id: string; name: string; type: string }[]
  sourceLanguage?: string
  targetLanguage?: string
  /** Project TTS settings including cast assignments and voice library.
   *  Required for "audio-by-character" export; safe to omit for other formats. */
  ttsSettings?: ProjectTtsSettings
  getToken: (fileId: string) => Promise<string | null>
}

export function ExportDialog({
  open,
  onOpenChange,
  canExport = true,
  cells,
  projectId,
  projectName,
  activeFileId,
  activeFileName,
  isUsfmFile,
  isDocxFile = false,
  projectFiles,
  sourceLanguage = "und",
  targetLanguage = "und",
  ttsSettings,
  getToken,
}: ExportDialogProps) {
  // FRO-253 (b fix): close the dialog if canExport flips to false after it opened.
  // Track the previous open state to detect the transition.
  const prevCanExportRef = useRef(canExport)
  useEffect(() => {
    if (open && prevCanExportRef.current && !canExport) {
      // canExport just flipped false while the dialog was open — close it.
      onOpenChange(false)
    }
    prevCanExportRef.current = canExport
  }, [open, canExport, onOpenChange])

  const [format, setFormat] = useState<ExportFormat>(isUsfmFile ? "usfm" : isDocxFile ? "docx" : "tsv")
  const [scope, setScope] = useState<ExportScope>("file")
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [dumpIncludeRefs, setDumpIncludeRefs] = useState(false)

  // FRO-437: Filename control state. Default changes with scope/format.
  // The base name is editable; timestamp and language tag are optional suffixes.
  const defaultBaseName = (activeFileName ?? "export").replace(/\.[^.]+$/, "")
  const [customBaseName, setCustomBaseName] = useState<string>(defaultBaseName)
  const [appendTimestamp, setAppendTimestamp] = useState(false)
  const [appendLangTag, setAppendLangTag] = useState(false)

  // Keep the base name in sync when the active file changes (e.g. dialog reopened on a new file).
  useEffect(() => {
    setCustomBaseName((activeFileName ?? "export").replace(/\.[^.]+$/, ""))
  }, [activeFileName])

  // audio-by-character, vtt, docx, and plain-text-dump only support file scope.
  const fileOnlyFormats = ["audio-by-character", "vtt", "docx", "plain-text-dump"] as const
  const isFileOnlyFormat = fileOnlyFormats.includes(format as typeof fileOnlyFormats[number])
  const effectiveScope: ExportScope = isFileOnlyFormat ? "file" : scope

  // Reset scope to "file" when switching to a file-only format.
  useEffect(() => {
    if (isFileOnlyFormat && scope === "project") {
      setScope("file")
    }
  }, [isFileOnlyFormat, scope])
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "busy"; msg: string }
    | { kind: "error"; msg: string }
    | { kind: "ok"; msg: string }
    | { kind: "ok-lossy"; msg: string; lossyVerseCount: number }
  >({ kind: "idle" })

  const selectedFormat = FORMAT_OPTIONS.find((f) => f.id === format)!
  const isLossy = selectedFormat.lossy

  // Load cells for all project files when project scope is selected and the
  // format is a client-side one. Disabled until the user actually picks
  // project scope so we don't fan-out N fetches on dialog open.
  const projectScopeEnabled = scope === "project" && format !== "usfm" && format !== "audio-by-character" && format !== "vtt" && format !== "docx" && format !== "plain-text-dump"

  const { files: projectFileCells, isLoading: projectCellsLoading, isTruncated } =
    useProjectCells({
      projectId,
      projectFiles,
      getToken,
      enabled: projectScopeEnabled,
    })

  /**
   * FRO-437: Build the final filename stem from the user's inputs.
   * - Starts with customBaseName (or projectName for project scope).
   * - Appends _YYYYMMDD-HHMM suffix when appendTimestamp is set.
   * - Appends _<langTag> suffix when appendLangTag is set and a language is available.
   * The caller appends the format-specific extension (.txt, .csv, etc.).
   */
  function buildExportStem(useProjectScope: boolean): string {
    const base = useProjectScope
      ? (projectName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "project")
      : (customBaseName.trim() || "export")
    let stem = base
    if (appendTimestamp) {
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, "0")
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
      stem = `${stem}_${stamp}`
    }
    if (appendLangTag) {
      const lang = targetLanguage && targetLanguage !== "und" ? targetLanguage : sourceLanguage
      if (lang && lang !== "und") {
        stem = `${stem}_${lang}`
      }
    }
    return stem
  }

  async function handleExport() {
    if (!activeFileId) return
    setStatus({ kind: "busy", msg: "Exporting…" })
    try {
      if (format === "usfm") {
        if (effectiveScope === "project") {
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
          // FRO-437: use user-chosen stem with .SFM extension.
          const stem = buildExportStem(false)
          const downloadName = `${stem}.SFM`
          // FRO-276: read lossy-verse count from response header.
          const result = await downloadSourceFile({ projectId, fileId: activeFileId, downloadName, getToken })
          const lossyCount = result.lossyVerseCount
          if (lossyCount !== null && lossyCount > 0) {
            setStatus({
              kind: "ok-lossy",
              msg: `Exported ${downloadName}`,
              lossyVerseCount: lossyCount,
            })
          } else {
            setStatus({ kind: "ok", msg: `Exported ${downloadName}` })
          }
        }
      } else if (format === "docx") {
        // FRO-233: DOCX round-trip export. Fetch the raw DOCX side-car from the
        // server, then inject translations client-side using JSZip + DOMParser.
        setStatus({ kind: "busy", msg: "Fetching original document…" })
        const rawBytes = await fetchSourceSidecar({ projectId, fileId: activeFileId, getToken })
        setStatus({ kind: "busy", msg: "Injecting translations…" })
        const { exportDocx } = await import("@/lib/export/exporters/docx")
        const result = await exportDocx(rawBytes, cells)
        const baseName = buildExportStem(false) // FRO-437: user-chosen stem
        downloadBlob(result.blob, `${baseName}.docx`)
        const note = result.injected === 0
          ? " (no translations to inject — download original structure)"
          : ` (${result.injected} paragraph${result.injected === 1 ? "" : "s"} translated)`
        setStatus({ kind: "ok", msg: `Downloaded ${baseName}.docx${note}` })
      } else if (format === "audio-by-character") {
        setStatus({ kind: "busy", msg: "Decoding audio…" })
        const { exportAudioByCharacter } = await import("@/lib/export/audio-by-character")
        const { decodeToMono48k } = await import("@/lib/audio/decode-mono")
        const { fetchCellAudio } = await import("@/lib/audio/upload")
        // getToken is (fileId) => Promise<string|null>; SyncTokenForFile expects
        // (projectId, fileId) — wrap it to match the fetchCellAudio signature.
        const getSyncToken = (_pid: string, fileId: string) => getToken(fileId)
        const result = await exportAudioByCharacter({
          cells,
          settings: ttsSettings,
          projectId,
          langCode: targetLanguage || "und",
          fetchBytes: ({ projectId: pid, fileId, audioId, ext }) =>
            fetchCellAudio({ projectId: pid, fileId, audioId, ext, getSyncToken }),
          decode: decodeToMono48k,
          onProgress: (d, t) => setStatus({ kind: "busy", msg: `Decoding ${d}/${t}…` }),
        })
        const safe = buildExportStem(false) // FRO-437: user-chosen stem
        downloadBlob(result.blob, `${safe}_audio-by-character.zip`)
        const skippedNote = result.skipped > 0 ? ` (${result.skipped} clip${result.skipped === 1 ? "" : "s"} skipped)` : ""
        setStatus({ kind: "ok", msg: `Exported audio by character${skippedNote}` })
      } else if (effectiveScope === "project") {
        // Client-side project-scope zip: use already-loaded per-file cells.
        if (projectCellsLoading) {
          setStatus({ kind: "busy", msg: "Still loading file cells, please wait…" })
          return
        }
        setStatus({ kind: "busy", msg: `Building zip for ${projectFileCells.length} files…` })
        const zipBlob = await buildProjectZip({
          files: projectFileCells,
          format: format as TextExportFormat,
          sourceLanguage,
          targetLanguage,
        })
        const safeName = buildExportStem(true) // FRO-437: project scope uses project name + suffixes
        const ext = selectedFormat.ext
        downloadBlob(zipBlob, `${safeName}${ext}.zip`)
        const truncNote = isTruncated ? " (first 40 files only)" : ""
        setStatus({ kind: "ok", msg: `Downloaded ${projectFileCells.length} files${truncNote}` })
      } else {
        // Client-side single-file exporter
        let blob: Blob
        const baseName = buildExportStem(false) // FRO-437: user-chosen stem
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
          case "vtt":
            blob = exportVtt(cells, ttsSettings)
            break
          case "plain-text-dump":
            blob = exportPlainTextDump(cells, {
              title: activeFileName ?? undefined,
              includeRefs: dumpIncludeRefs,
            })
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
          <RadioGroup
            value={format}
            onValueChange={(value) => setFormat(value as ExportFormat)}
            className="flex flex-col gap-0.5 max-h-64 overflow-y-auto overscroll-contain pr-0.5"
            aria-label="Export format"
          >
            {FORMAT_OPTIONS.filter((f) => {
              if (f.id === "usfm") return isUsfmFile
              if (f.id === "docx") return isDocxFile // FRO-233: only for docx imports
              if (f.id === "plain-text-dump") return false // shown in Advanced section only
              return true
            }).map((f) => (
              <label
                key={f.id}
                className={
                  "flex items-start gap-2.5 rounded-xl px-2.5 py-2 cursor-pointer transition-colors " +
                  (format === f.id
                    ? "bg-accent/60 ring-1 ring-ring/20"
                    : "hover:bg-accent/40")
                }
              >
                <RadioGroupItem
                  value={f.id}
                  className="mt-0.5 shrink-0"
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
          </RadioGroup>
        </fieldset>

        {/* Scope selector */}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
            Scope
          </legend>
          <RadioGroup
            value={effectiveScope}
            onValueChange={(value) => setScope(value as ExportScope)}
            className="inline-flex w-auto items-center gap-0.5 rounded-full bg-muted/40 p-0.5 self-start"
            aria-label="Export scope"
          >
            {(["file", "project"] as const).map((s) => {
              const isProjectDisabled = s === "project" && isFileOnlyFormat
              return (
                <label
                  key={s}
                  className={
                    "inline-flex h-6 items-center rounded-full px-3 text-[11px] font-medium tracking-tight transition-colors " +
                    (isProjectDisabled
                      ? "cursor-not-allowed opacity-40 text-muted-foreground"
                      : "cursor-pointer ") +
                    (effectiveScope === s && !isProjectDisabled
                      ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/5"
                      : (!isProjectDisabled ? "text-muted-foreground hover:text-foreground" : ""))
                  }
                >
                  <RadioGroupItem
                    value={s}
                    disabled={isProjectDisabled}
                    className="sr-only"
                  />
                  {s === "file" ? "Current file" : "Whole project"}
                </label>
              )
            })}
          </RadioGroup>
          {isFileOnlyFormat && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Project scope not supported for this format.
            </p>
          )}

          {/* Project-scope notices */}
          {effectiveScope === "project" && format !== "usfm" && projectCellsLoading && (
            <div className="flex items-center gap-1.5 mt-1">
              <Skeleton className="h-2 w-2 rounded-full shrink-0" />
              <Skeleton className="h-3 w-40" />
            </div>
          )}
          {effectiveScope === "project" && format !== "usfm" && isTruncated && (
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400 mt-1">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              This project has more than 40 files — zip will include the first 40 only.
              {/* SWARM-TODO(project-export-scale): server batch-export endpoint for
                  large projects; see src/hooks/useProjectCells.ts for the proposed shape. */}
            </p>
          )}
        </fieldset>

        {/* FRO-437: Filename control — editable base name + optional suffixes */}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
            Filename
          </legend>
          <div className="flex flex-col gap-2">
            {/* Base name input — disabled for project scope (project name drives it) */}
            <Input
              value={effectiveScope === "project" ? projectName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "project" : customBaseName}
              onChange={(e) => setCustomBaseName(e.target.value)}
              disabled={effectiveScope === "project"}
              placeholder="filename"
              aria-label="Export filename (without extension)"
              className="h-7 text-sm font-mono"
            />
            {effectiveScope === "project" && (
              <p className="text-[10px] text-muted-foreground -mt-0.5">
                Project-scope exports use the project name.
              </p>
            )}
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors">
                <Checkbox
                  checked={appendTimestamp}
                  onCheckedChange={(c) => setAppendTimestamp(c === true)}
                />
                Append timestamp
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors">
                <Checkbox
                  checked={appendLangTag}
                  onCheckedChange={(c) => setAppendLangTag(c === true)}
                />
                Append language tag
              </label>
            </div>
          </div>
        </fieldset>

        {/* Audio-by-character inline preview */}
        {format === "audio-by-character" && effectiveScope === "file" && (() => {
          const preview = previewAudioByCharacter(cells, ttsSettings)
          return (
          <div className="flex flex-col gap-1 text-xs">
            <p className="font-medium text-muted-foreground uppercase tracking-wide text-[10px]">Preview</p>
            {preview.length === 0 ? (
              <p className="text-muted-foreground">No cells with audio found in this file.</p>
            ) : (
              preview.map((p) => (
                <div key={p.voiceId} className="flex items-center gap-2">
                  {p.color && (
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: p.color }}
                      aria-hidden="true"
                    />
                  )}
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-foreground">
                    {p.clipCount} {p.clipCount === 1 ? "clip" : "clips"}
                    {p.totalDurationMs != null && (
                      <> · {Math.floor(p.totalDurationMs / 60000)}:{String(Math.floor((p.totalDurationMs % 60000) / 1000)).padStart(2, "0")}</>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
          )
        })()}

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

        {/* Advanced section: plain-text dump */}
        <details
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
          className="group"
        >
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground uppercase tracking-wide select-none list-none flex items-center gap-1 hover:text-foreground transition-colors">
            <span
              className={
                "inline-block transition-transform " +
                (advancedOpen ? "rotate-90" : "rotate-0")
              }
              aria-hidden="true"
            >
              ›
            </span>
            Advanced
          </summary>
          <div className="mt-2.5 flex flex-col gap-2.5 pl-3 border-l border-border/40">
            {/* Plain-text dump — shares the `format` state with the main list
                above, but lives in its own RadioGroup wrapper since Base UI
                radios need a group ancestor. */}
            <RadioGroup
              value={format}
              onValueChange={(value) => setFormat(value as ExportFormat)}
              aria-label="Advanced export formats"
            >
            <label
              className={
                "flex items-start gap-2.5 rounded-xl px-2.5 py-2 cursor-pointer transition-colors " +
                (format === "plain-text-dump"
                  ? "bg-accent/60 ring-1 ring-ring/20"
                  : "hover:bg-accent/40")
              }
            >
              <RadioGroupItem
                value="plain-text-dump"
                className="mt-0.5 shrink-0"
                aria-label="Plain-text dump (.txt)"
              />
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm font-medium leading-tight flex items-baseline gap-1.5 flex-wrap">
                  Plain-text dump
                  <span className="text-xs text-muted-foreground font-normal font-mono">.txt</span>
                  <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold uppercase tracking-wider">
                    lossy
                  </span>
                </span>
                <span className="text-xs text-muted-foreground leading-relaxed">
                  Every translated segment, one per line — for quick content extraction.{" "}
                  <strong className="font-medium text-foreground/70">What this loses:</strong>{" "}
                  footnotes, cross-references, poetry layout, headings, paragraph markers,
                  bold/italic character markup, back-translations, validation state, and
                  untranslated segments. Not suitable for re-import.
                </span>
                {format === "plain-text-dump" && (
                  <label className="flex items-center gap-1.5 mt-1 cursor-pointer">
                    <Checkbox
                      checked={dumpIncludeRefs}
                      onCheckedChange={(checked) => setDumpIncludeRefs(checked === true)}
                    />
                    <span className="text-xs text-muted-foreground">
                      Prefix each line with canonical ref (e.g. <code className="font-mono">GEN 1:1</code>)
                    </span>
                  </label>
                )}
              </span>
            </label>
            </RadioGroup>
          </div>
        </details>

        {/* Status feedback */}
        {status.kind !== "idle" && (
          <div
            role="status"
            aria-live="polite"
            className={
              "flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm " +
              (status.kind === "error"
                ? "bg-destructive/10 text-destructive"
                : status.kind === "ok" || status.kind === "ok-lossy"
                  ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400"
                  : "bg-muted/60 text-muted-foreground")
            }
          >
            {status.kind === "busy" && (
              <Spinner className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            )}
            {(status.kind === "ok" || status.kind === "ok-lossy") && (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            {status.kind === "error" && (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            <span className="flex flex-col gap-1">
              <span>{status.msg}</span>
              {status.kind === "ok-lossy" && (
                <span className="flex items-start gap-1 text-amber-600 dark:text-amber-400 text-xs font-medium">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                  {status.lossyVerseCount === 1
                    ? "1 verse contained footnotes, poetry, or character markers in the source USFM — its structure is replaced by plain translated text."
                    : `${status.lossyVerseCount} verses contained footnotes, poetry, or character markers in the source USFM — their structure is replaced by plain translated text.`}
                </span>
              )}
            </span>
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
              <Spinner aria-hidden="true" />
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
