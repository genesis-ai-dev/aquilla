// ExportDialog: pick format + scope, then trigger the appropriate exporter or
// server-side USFM download. Project scope zips each file's cells client-side
// (except USFM, which uses the server side-car route).
//
// For non-USFM formats, project scope uses useProjectCells to fan-out over all
// project files (up to MAX_FILES=40) and buildProjectZip to produce a zip.
//
// AQU-253 (b fix): auto-closes when canExport flips false after settings load,
// so a settings change mid-session doesn't leave the dialog open for a user who
// lost access.
//
// AQU-437: Filename control — editable base name with optional timestamp/lang
// tag appended at export time. The chosen name drives the downloaded filename
// for both single-file and project-scope exports.
//
// AQU-439: Voice filter — when cells have cast assignments (metadata.cast_name),
// a "Voice" filter appears letting users export only one voice's cells across
// all camera angles.

import { useState, useEffect, useMemo, useRef } from "react"
import { Download, AlertTriangle, CheckCircle2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { SegmentTabs } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import { downloadBlob } from "@/lib/export/export-service"
import { collectInlineStyleWarnings, type ExportFidelityWarning } from "@/lib/export/fidelity"
import { downloadSourceFile, downloadProjectZip, fetchSourceSidecar } from "@/lib/sync/source-export"
import { exportPlainTextStructured } from "@/lib/export/exporters/plaintext"
import { exportMarkdownStructured } from "@/lib/export/exporters/markdown"
import { exportTsv } from "@/lib/export/exporters/tsv"
import { exportCsv } from "@/lib/export/exporters/csv"
import { exportXliff12Structured } from "@/lib/export/exporters/xliff12-structured"
import { exportTmxStructured } from "@/lib/export/exporters/tmx-structured"
import { exportVtt } from "@/lib/export/exporters/vtt"
import { exportSrt } from "@/lib/export/exporters/srt"
import { exportPlainTextDump } from "@/lib/export/exporters/plain-text-dump"
import { buildProjectZip } from "@/lib/export/project-zip-export"
import type { TextExportFormat } from "@/lib/export/project-zip-export"
import { previewAudioByCharacter } from "@/lib/export/audio-by-character"
import { exportMetadataCsv } from "@/lib/export/exporters/metadata-csv"
import { injectSdbhXml } from "@/lib/parsers/sdbh"
import { useProjectCells } from "@/hooks/useProjectCells"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

export type ExportFormat = "usfm" | "txt" | "md" | "tsv" | "csv" | "xlf" | "tmx" | "vtt" | "srt" | "audio-by-character" | "docx" | "pptx" | "plain-text-dump" | "metadata-csv" | "sdbh-xml"
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
    id: "pptx",
    label: "PowerPoint (.pptx)",
    ext: ".pptx",
    description: "Translations injected back into the original presentation. Slides, shapes, and paragraph structure are preserved; mixed run formatting is simplified to the first run and reported.",
    lossy: false,
  },
  {
    // AQU-233: DOCX export with paragraph/heading structure preserved.
    // Only shown for files imported as .docx (isDocxFile prop).
    id: "docx",
    label: "Word (.docx)",
    ext: ".docx",
    description: "Translations injected back into the original Word document. Paragraph/heading structure is preserved; per-run bold/italic inside translated paragraphs is not preserved. Requires the original file to have been imported after round-trip export support was added — files imported before then may lack a stored original (re-import to enable).",
    lossy: false,
  },
  {
    // SDBH lexicon round-trip: translations reinjected into the MARBLE XML
    // edition, keyed by LEXID. Only shown when the project has SDBH files.
    id: "sdbh-xml",
    label: "SDBH XML (MARBLE)",
    ext: ".XML",
    description: "Localized lexicon reinjected into the original MARBLE XML edition — pick the original SDBH-<lang>.XML as the skeleton. Whole-project export across all lexicon files.",
    lossy: false,
  },
  {
    id: "txt",
    label: "Plain text",
    ext: ".txt",
    description: "Round-trip plain text: paragraph structure preserved; untranslated paragraphs keep source.",
    lossy: true,
  },
  {
    id: "md",
    label: "Markdown",
    ext: ".md",
    description: "Round-trip markdown: headings, ordered/unordered lists and quotes reconstructed; untranslated blocks keep source.",
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
    description: "Bilingual XLIFF for CAT tools — schema-valid, segment states mapped, imported inline tags preserved for unedited segments.",
    lossy: false,
  },
  {
    id: "tmx",
    label: "TMX 1.4b",
    ext: ".tmx",
    description: "Translation memory exchange — DTD-valid, imported inline tags preserved for unedited pairs.",
    lossy: true,
  },
  {
    id: "srt",
    label: "SRT (subtitles)",
    ext: ".srt",
    description: "SubRip subtitles: numbered cues with millisecond timecodes; translated text per cue, source kept for untranslated cues.",
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
  // AQU-441: Metadata/cast spreadsheet — listed in Advanced section.
  {
    id: "metadata-csv",
    label: "Metadata spreadsheet",
    ext: ".csv",
    description: "Cast (voice/character), camera angle, and cell ref — one row per cell. Export only; the project remains the source of truth.",
    lossy: false,
  },
]

interface ExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * AQU-253 (b fix): whether org policy allows export. When this flips false
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
   * AQU-233: Whether the active file was imported as a .docx — enables the
   * Word (.docx) round-trip export option when a side-car blob exists.
   */
  isDocxFile?: boolean
  /** Whether the active file was imported from a PPTX skeleton. */
  isPptxFile?: boolean
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
  isPptxFile = false,
  projectFiles,
  sourceLanguage = "und",
  targetLanguage = "und",
  ttsSettings,
  getToken,
}: ExportDialogProps) {
  // AQU-253 (b fix): close the dialog if canExport flips to false after it opened.
  // Track the previous open state to detect the transition.
  const prevCanExportRef = useRef(canExport)
  useEffect(() => {
    if (open && prevCanExportRef.current && !canExport) {
      // canExport just flipped false while the dialog was open — close it.
      onOpenChange(false)
    }
    prevCanExportRef.current = canExport
  }, [open, canExport, onOpenChange])

  const [format, setFormat] = useState<ExportFormat>(isUsfmFile ? "usfm" : isDocxFile ? "docx" : isPptxFile ? "pptx" : "tsv")
  const [scope, setScope] = useState<ExportScope>("file")
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [dumpIncludeRefs, setDumpIncludeRefs] = useState(false)

  // AQU-437: Filename control state. Default changes with scope/format.
  // The base name is editable; timestamp and language tag are optional suffixes.
  const defaultBaseName = (activeFileName ?? "export").replace(/\.[^.]+$/, "")
  const [customBaseName, setCustomBaseName] = useState<string>(defaultBaseName)
  const [appendTimestamp, setAppendTimestamp] = useState(false)
  const [appendLangTag, setAppendLangTag] = useState(false)

  // Keep the base name in sync when the active file changes (e.g. dialog reopened on a new file).
  useEffect(() => {
    setCustomBaseName((activeFileName ?? "export").replace(/\.[^.]+$/, ""))
  }, [activeFileName])

  // Keep the format in sync when the active file changes: the dialog stays
  // mounted across file switches, so the mount-time initializer above goes
  // stale — a leftover "usfm"/"docx" selection is filtered out of the radio
  // list (nothing appears selected) yet still drives handleExport down the
  // wrong side-car path for the new file.
  useEffect(() => {
    setFormat(isUsfmFile ? "usfm" : isDocxFile ? "docx" : isPptxFile ? "pptx" : "tsv")
  }, [activeFileId, isUsfmFile, isDocxFile, isPptxFile])

  // audio-by-character, vtt, docx, and plain-text-dump only support file scope.
  const fileOnlyFormats = ["audio-by-character", "vtt", "docx", "pptx", "plain-text-dump"] as const
  const isFileOnlyFormat = fileOnlyFormats.includes(format as typeof fileOnlyFormats[number])
  // SDBH XML reinjection spans every lexicon file — inherently project scope.
  const isProjectOnlyFormat = format === "sdbh-xml"
  const effectiveScope: ExportScope = isProjectOnlyFormat ? "project" : isFileOnlyFormat ? "file" : scope

  // SDBH XML export needs the original MARBLE edition as the skeleton.
  const [sdbhSkeleton, setSdbhSkeleton] = useState<File | null>(null)
  const hasSdbhFiles = projectFiles.some((f) => f.type === "sdbh")

  // A selected format can also vanish without a file switch (sdbh-xml is
  // offered per-project, not per-file) — fall back to the always-visible tsv.
  useEffect(() => {
    if (format === "sdbh-xml" && !hasSdbhFiles) setFormat("tsv")
  }, [format, hasSdbhFiles])

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
  // Inline-style fidelity report for the last export (parity run: users must
  // see when formatting could not be carried into edited translations).
  const [fidelityWarnings, setFidelityWarnings] = useState<ExportFidelityWarning[]>([])

  const selectedFormat = FORMAT_OPTIONS.find((f) => f.id === format)!
  const isLossy = selectedFormat.lossy

  // AQU-439: Voice filter — collect distinct voice names from metadata.cast_name.
  // Only appears when at least one cell has a cast assignment.
  const [voiceFilter, setVoiceFilter] = useState<string>("") // "" = All voices

  /** Extract the cast voice name for a cell (from metadata.cast_name). */
  function getCellVoice(cell: CellData): string {
    return typeof cell.metadata?.cast_name === "string" ? cell.metadata.cast_name : ""
  }

  const distinctVoices = useMemo(() => {
    const names = new Set<string>()
    for (const c of cells) {
      const v = getCellVoice(c)
      if (v) names.add(v)
    }
    return Array.from(names).sort()
  }, [cells])

  // Reset voice filter when dialog closes or cells change.
  useEffect(() => {
    if (!open) setVoiceFilter("")
  }, [open])

  /**
   * Apply the voice filter to a cell array.
   * When voiceFilter is empty, all cells are returned.
   */
  function applyVoiceFilter(cs: CellData[]): CellData[] {
    if (!voiceFilter) return cs
    return cs.filter((c) => getCellVoice(c) === voiceFilter)
  }

  // Load cells for all project files when project scope is selected and the
  // format is a client-side one. Disabled until the user actually picks
  // project scope so we don't fan-out N fetches on dialog open.
  const projectScopeEnabled = format === "sdbh-xml" || (scope === "project" && format !== "usfm" && format !== "audio-by-character" && format !== "vtt" && format !== "docx" && format !== "plain-text-dump")

  const { files: projectFileCells, isLoading: projectCellsLoading, isTruncated } =
    useProjectCells({
      projectId,
      projectFiles,
      getToken,
      enabled: projectScopeEnabled,
    })

  /**
   * AQU-437: Build the final filename stem from the user's inputs.
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
    setFidelityWarnings([])
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
          // AQU-437: use user-chosen stem with .SFM extension.
          const stem = buildExportStem(false)
          const downloadName = `${stem}.SFM`
          // AQU-276: read lossy-verse count from response header.
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
        // AQU-233: DOCX round-trip export. Fetch the raw DOCX side-car from the
        // server, then inject translations client-side using JSZip + DOMParser.
        setStatus({ kind: "busy", msg: "Fetching original document…" })
        const rawBytes = await fetchSourceSidecar({ projectId, fileId: activeFileId, getToken })
        setStatus({ kind: "busy", msg: "Injecting translations…" })
        const { exportDocx } = await import("@/lib/export/exporters/docx")
        const result = await exportDocx(rawBytes, cells)
        const baseName = buildExportStem(false) // AQU-437: user-chosen stem
        downloadBlob(result.blob, `${baseName}.docx`)
        const note = result.injected === 0
          ? " (no translations to inject — download original structure)"
          : ` (${result.injected} paragraph${result.injected === 1 ? "" : "s"} translated)`
        setFidelityWarnings([
          ...result.warnings.map((w) => ({
            kind: "inline-style-simplified" as const,
            segment: w.segment,
            detail: w.detail,
          })),
          ...collectInlineStyleWarnings(cells),
        ])
        setStatus({ kind: "ok", msg: `Downloaded ${baseName}.docx${note}` })
      } else if (format === "pptx") {
        setStatus({ kind: "busy", msg: "Fetching original presentation…" })
        const rawBytes = await fetchSourceSidecar({ projectId, fileId: activeFileId, getToken })
        setStatus({ kind: "busy", msg: "Injecting translations…" })
        const { exportPptx } = await import("@/lib/export/exporters/pptx")
        const result = await exportPptx(rawBytes, cells)
        const baseName = buildExportStem(false)
        downloadBlob(result.blob, `${baseName}.pptx`)
        setFidelityWarnings([
          ...result.warnings.map((warning) => ({
            kind: "inline-style-simplified" as const,
            segment: warning.segment,
            detail: warning.detail,
          })),
          ...collectInlineStyleWarnings(cells),
        ])
        const note = result.injected === 0
          ? " (no translations to inject — downloaded original structure)"
          : ` (${result.injected} paragraph${result.injected === 1 ? "" : "s"} translated)`
        setStatus({ kind: "ok", msg: `Downloaded ${baseName}.pptx${note}` })
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
        const safe = buildExportStem(false) // AQU-437: user-chosen stem
        downloadBlob(result.blob, `${safe}_audio-by-character.zip`)
        const skippedNote = result.skipped > 0 ? ` (${result.skipped} clip${result.skipped === 1 ? "" : "s"} skipped)` : ""
        setStatus({ kind: "ok", msg: `Exported audio by character${skippedNote}` })
      } else if (format === "sdbh-xml") {
        // SDBH round-trip: reinject every translated lexicon cell into the
        // user-supplied MARBLE XML skeleton, keyed by LEXID-derived cell ids.
        if (!sdbhSkeleton) {
          setStatus({ kind: "error", msg: "Choose the original SDBH-<lang>.XML file as the skeleton first." })
          return
        }
        if (projectCellsLoading) {
          setStatus({ kind: "busy", msg: "Still loading file cells, please wait…" })
          return
        }
        const byCellId = new Map<string, string>()
        for (const f of projectFileCells) {
          for (const c of f.cells) {
            if (c.translated) byCellId.set(c.id, c.translated)
          }
        }
        const skeletonXml = await sdbhSkeleton.text()
        const lang = targetLanguage && targetLanguage !== "und" ? targetLanguage : undefined
        const { xml, sensesInjected, warnings } = injectSdbhXml(skeletonXml, {
          byCellId,
          languageCode: lang,
          rewriteDomainLabels: true,
        })
        if (sensesInjected === 0) {
          setStatus({ kind: "error", msg: "No LEXMeaning entries found — is that file a MARBLE SDBH XML edition?" })
          return
        }
        const stem = buildExportStem(true)
        downloadBlob(new Blob([xml], { type: "application/xml" }), `${stem}.XML`)
        const warnNote = warnings.length ? ` — ${warnings.length} gloss warning(s), check semicolons` : ""
        setStatus({ kind: "ok", msg: `Reinjected ${byCellId.size.toLocaleString()} translations into ${sensesInjected.toLocaleString()} senses${warnNote}` })
      } else if (effectiveScope === "project") {
        // Client-side project-scope zip: use already-loaded per-file cells.
        if (projectCellsLoading) {
          setStatus({ kind: "busy", msg: "Still loading file cells, please wait…" })
          return
        }
        // AQU-441: metadata-csv project scope — flatten all file cells into one sheet.
        if (format === "metadata-csv") {
          const allCells = projectFileCells.flatMap((f) => f.cells)
          const csvBlob = exportMetadataCsv(allCells, ttsSettings)
          const safeName = buildExportStem(true)
          downloadBlob(csvBlob, `${safeName}.csv`)
          const truncNote = isTruncated ? " (first 40 files only)" : ""
          setStatus({ kind: "ok", msg: `Downloaded ${safeName}.csv (${allCells.length} rows)${truncNote}` })
          return
        }
        setStatus({ kind: "busy", msg: `Building zip for ${projectFileCells.length} files…` })
        const zipBlob = await buildProjectZip({
          files: projectFileCells,
          format: format as TextExportFormat,
          sourceLanguage,
          targetLanguage,
        })
        const safeName = buildExportStem(true) // AQU-437: project scope uses project name + suffixes
        const ext = selectedFormat.ext
        downloadBlob(zipBlob, `${safeName}${ext}.zip`)
        setFidelityWarnings(projectFileCells.flatMap((f) => collectInlineStyleWarnings(f.cells)))
        const truncNote = isTruncated ? " (first 40 files only)" : ""
        setStatus({ kind: "ok", msg: `Downloaded ${projectFileCells.length} files${truncNote}` })
      } else {
        // Client-side single-file exporter
        // AQU-439: apply voice filter before passing to any exporter.
        const filteredCells = applyVoiceFilter(cells)
        let blob: Blob
        const baseName = buildExportStem(false) // AQU-437: user-chosen stem
        const ext = selectedFormat.ext
        switch (format) {
          case "txt":
            blob = exportPlainTextStructured(filteredCells)
            break
          case "md":
            blob = exportMarkdownStructured(filteredCells)
            break
          case "tsv":
            blob = exportTsv(filteredCells)
            break
          case "csv":
            blob = exportCsv(filteredCells)
            break
          case "xlf":
            blob = exportXliff12Structured(filteredCells, sourceLanguage, targetLanguage)
            break
          case "tmx":
            blob = exportTmxStructured(filteredCells, sourceLanguage, targetLanguage)
            break
          case "vtt":
            blob = exportVtt(filteredCells, ttsSettings)
            break
          case "srt":
            blob = exportSrt(filteredCells)
            break
          case "plain-text-dump":
            blob = exportPlainTextDump(filteredCells, {
              title: activeFileName ?? undefined,
              includeRefs: dumpIncludeRefs,
            })
            break
          case "metadata-csv":
            // AQU-441: export cast/camera metadata for the current file.
            // AQU-439: voice filter applied (filteredCells already scoped).
            blob = exportMetadataCsv(filteredCells, ttsSettings)
            break
          default:
            throw new Error(`Unknown format: ${format}`)
        }
        downloadBlob(blob, `${baseName}${ext}`)
        setFidelityWarnings(collectInlineStyleWarnings(filteredCells))
        setStatus({ kind: "ok", msg: `Downloaded ${baseName}${ext}` })
      }
    } catch (e) {
      setStatus({ kind: "error", msg: (e as Error).message || "Export failed." })
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setStatus({ kind: "idle" })
      setFidelityWarnings([])
    }
    onOpenChange(next)
  }

  const isBusy = status.kind === "busy"
  // AQU-519: after a successful export the dialog must make it obvious the
  // export completed and give an unmistakable way out. The success banner shows
  // the confirmation; here the footer swaps "Cancel" for a primary "Done"
  // button (and demotes "Export" to "Export again") so users aren't left
  // wondering whether anything happened. We keep the dialog open rather than
  // auto-closing so lossy/fidelity warnings stay visible.
  const isDone = status.kind === "ok" || status.kind === "ok-lossy"

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
        </DialogHeader>

        {/* AQU-458: the whole body scrolls as one region (DialogBody =
            min-h-0 flex-1 overflow-y-auto) instead of nesting a fixed-height
            scroll area inside the Format fieldset. A max-h-64 inner scroll
            on just the format list got clipped by the dialog's own
            overflow-hidden + max-h-[85dvh] on short/tablet viewports, making
            the lower format options unreachable. */}
        <DialogBody className="flex flex-col gap-4">
        {/* Format selector */}
        <fieldset className="flex flex-col gap-1.5 min-w-0">
          <legend className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
            Format
          </legend>
          <RadioGroup
            value={format}
            onValueChange={(value) => setFormat(value as ExportFormat)}
            className="flex flex-col gap-0.5"
            aria-label="Export format"
          >
            {FORMAT_OPTIONS.filter((f) => {
              if (f.id === "usfm") return isUsfmFile
              if (f.id === "docx") return isDocxFile // AQU-233: only for docx imports
              if (f.id === "pptx") return isPptxFile
              if (f.id === "sdbh-xml") return hasSdbhFiles // SDBH round-trip: only for lexicon projects
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
          <SegmentTabs<ExportScope>
            value={effectiveScope}
            aria-label="Export scope"
            className="self-start"
            options={[
              { label: "Current file", value: "file", disabled: isProjectOnlyFormat },
              { label: "Whole project", value: "project", disabled: isFileOnlyFormat },
            ]}
            onValueChange={setScope}
          />
          {isFileOnlyFormat && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Project scope not supported for this format.
            </p>
          )}
          {isProjectOnlyFormat && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              This format always exports the whole project.
            </p>
          )}

          {/* SDBH XML skeleton picker — the original MARBLE edition to reinject into. */}
          {format === "sdbh-xml" && (
            <div className="mt-1.5 flex flex-col gap-1">
              <Button variant="outline" size="sm" nativeButton={false} render={<label className="cursor-pointer self-start" />}>
                {sdbhSkeleton ? sdbhSkeleton.name : "Choose skeleton (SDBH-<lang>.XML)"}
                <input
                  type="file"
                  className="hidden"
                  accept=".xml,.XML"
                  onChange={(e) => setSdbhSkeleton(e.target.files?.[0] ?? null)}
                />
              </Button>
              <p className="text-[10px] text-muted-foreground">
                Usually the same edition you imported — its structure is preserved byte-for-byte; only the
                localized definition, gloss, comment, and domain-label text is replaced.
              </p>
            </div>
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

        {/* AQU-439: Voice filter — only shown when cells have cast assignments */}
        {distinctVoices.length > 0 && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Voice
            </legend>
            <select
              value={voiceFilter}
              onChange={(e) => setVoiceFilter(e.target.value)}
              aria-label="Filter export by voice"
              className="h-7 w-full rounded-md border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">All voices</option>
              {distinctVoices.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
            {voiceFilter && (
              <p className="text-[10px] text-muted-foreground">
                Export will include only cells assigned to <strong>{voiceFilter}</strong>, across all camera angles.
              </p>
            )}
          </fieldset>
        )}

        {/* AQU-437: Filename control — editable base name + optional suffixes */}
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
            {/* AQU-441: Metadata spreadsheet — cast, camera angle, cell ref */}
            <label
              className={
                "flex items-start gap-2.5 rounded-xl px-2.5 py-2 cursor-pointer transition-colors " +
                (format === "metadata-csv"
                  ? "bg-accent/60 ring-1 ring-ring/20"
                  : "hover:bg-accent/40")
              }
            >
              <RadioGroupItem
                value="metadata-csv"
                className="mt-0.5 shrink-0"
                aria-label="Metadata spreadsheet (.csv)"
              />
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm font-medium leading-tight flex items-baseline gap-1.5 flex-wrap">
                  Metadata spreadsheet
                  <span className="text-xs text-muted-foreground font-normal font-mono">.csv</span>
                </span>
                <span className="text-xs text-muted-foreground leading-relaxed">
                  Cast (voice/character), camera angle, and cell ref — one row per cell.
                  Export only; the project remains the source of truth.
                </span>
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

        {/* Inline-style fidelity report: formatting the export could not keep. */}
        {fidelityWarnings.length > 0 && (status.kind === "ok" || status.kind === "ok-lossy") && (
          <div
            role="note"
            className="flex flex-col gap-1 rounded-xl bg-amber-50 px-3 py-2.5 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
          >
            <span className="flex items-center gap-1 font-medium">
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
              {fidelityWarnings.length === 1
                ? "1 segment lost inline formatting in this export"
                : `${fidelityWarnings.length} segments lost inline formatting in this export`}
            </span>
            <ul className="ml-4 list-disc space-y-0.5">
              {fidelityWarnings.slice(0, 6).map((w, i) => (
                <li key={i}>
                  <span className="font-medium">{w.segment}</span>: {w.detail}
                </li>
              ))}
              {fidelityWarnings.length > 6 && <li>…and {fidelityWarnings.length - 6} more</li>}
            </ul>
          </div>
        )}
        </DialogBody>

        <DialogFooter>
          <Button
            variant={isDone ? "default" : "outline"}
            onClick={() => handleOpenChange(false)}
            disabled={isBusy}
          >
            {isDone ? "Done" : "Cancel"}
          </Button>
          <Button
            onClick={handleExport}
            disabled={!activeFileId || isBusy}
            aria-busy={isBusy}
            variant={isDone ? "outline" : "default"}
          >
            {isBusy ? (
              <Spinner aria-hidden="true" />
            ) : (
              <Download className="h-4 w-4" aria-hidden="true" />
            )}
            {isBusy ? "Exporting…" : isDone ? "Export again" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
