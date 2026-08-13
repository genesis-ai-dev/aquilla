// ExportDialog: the headline action is "download your file back" — the active
// file's ORIGINAL format with current translations injected (USFM/DOCX/PPTX
// via the server side-car, structured re-serialization for md/txt/subtitles/
// CAT formats). Converting to a different format lives in a collapsed
// "Export to another format" section (format radio + scope + advanced).
//
// For non-USFM formats, project scope uses useProjectCells to load every file
// with bounded concurrency and buildProjectZip to produce a zip.
//
// AQU-253 (revised): when org policy forbids export, the dialog renders an
// explicit permission gate (with a link to the roles & permissions help page)
// instead of silently closing/hiding — users must be able to see WHY they
// can't export.
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
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import { RichMessage } from "@/lib/i18n/RichMessage"
import type { MessageKey } from "@/lib/i18n/messages/en"
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
import posthog from "@/lib/posthog"
import {
  CURRENT_IDML_FORMAT_COPY,
  idmlFormatCopy,
  idmlOrgEligible,
} from "@/lib/idml/release-gate"
import { idmlTelemetryProperties } from "@/lib/idml/telemetry"

export type ExportFormat = "usfm" | "txt" | "md" | "tsv" | "csv" | "xlf" | "tmx" | "vtt" | "srt" | "audio-by-character" | "docx" | "pptx" | "idml" | "plain-text-dump" | "metadata-csv" | "sdbh-xml"
export type ExportScope = "file" | "project"

interface FormatOption {
  id: ExportFormat
  labelKey: MessageKey
  ext: string
  descriptionKey: MessageKey
  lossy: boolean
}

// AQU-832: label/description are catalog keys, not English strings — this
// table is module-level, evaluated once before any I18nProvider exists, so
// it cannot call t() itself. Resolved at render time by the format list below.
const BASE_FORMAT_OPTIONS: FormatOption[] = [
  {
    id: "usfm",
    labelKey: "importExport.format.usfm.label",
    ext: ".SFM",
    descriptionKey: "importExport.format.usfm.description",
    lossy: false,
  },
  {
    // AQU-233: DOCX export with paragraph/heading structure preserved.
    // Only shown for files imported as .docx.
    id: "docx",
    labelKey: "importExport.format.docx.label",
    ext: ".docx",
    descriptionKey: "importExport.format.docx.description",
    lossy: false,
  },
  {
    // AQU-152a: PPTX export with slide/shape/paragraph structure preserved.
    // Only shown for files imported as .pptx (activeFileType).
    id: "pptx",
    labelKey: "importExport.format.pptx.label",
    ext: ".pptx",
    descriptionKey: "importExport.format.pptx.description",
    lossy: false,
  },
  {
    // IDML v2 export remains experimental until the Adobe validation gate.
    // Only shown for files imported as .idml (activeFileType).
    id: "idml",
    labelKey: CURRENT_IDML_FORMAT_COPY.label,
    ext: ".idml",
    descriptionKey: CURRENT_IDML_FORMAT_COPY.description,
    lossy: false,
  },
  {
    // SDBH lexicon round-trip: translations reinjected into the MARBLE XML
    // edition, keyed by LEXID. Only shown when the project has SDBH files.
    id: "sdbh-xml",
    labelKey: "importExport.format.sdbhXml.label",
    ext: ".XML",
    descriptionKey: "importExport.format.sdbhXml.description",
    lossy: false,
  },
  {
    id: "txt",
    labelKey: "importExport.format.txt.label",
    ext: ".txt",
    descriptionKey: "importExport.format.txt.description",
    lossy: true,
  },
  {
    id: "md",
    labelKey: "importExport.format.md.label",
    ext: ".md",
    descriptionKey: "importExport.format.md.description",
    lossy: true,
  },
  {
    id: "tsv",
    labelKey: "importExport.format.tsv.label",
    ext: ".tsv",
    descriptionKey: "importExport.format.tsv.description",
    lossy: true,
  },
  {
    id: "csv",
    labelKey: "importExport.format.csv.label",
    ext: ".csv",
    descriptionKey: "importExport.format.csv.description",
    lossy: true,
  },
  {
    id: "xlf",
    labelKey: "importExport.format.xlf.label",
    ext: ".xlf",
    descriptionKey: "importExport.format.xlf.description",
    lossy: false,
  },
  {
    id: "tmx",
    labelKey: "importExport.format.tmx.label",
    ext: ".tmx",
    descriptionKey: "importExport.format.tmx.description",
    lossy: true,
  },
  {
    id: "srt",
    labelKey: "importExport.format.srt.label",
    ext: ".srt",
    descriptionKey: "importExport.format.srt.description",
    lossy: true,
  },
  {
    id: "vtt",
    labelKey: "importExport.format.vtt.label",
    ext: ".vtt",
    descriptionKey: "importExport.format.vtt.description",
    lossy: true,
  },
  {
    id: "audio-by-character",
    labelKey: "importExport.format.audioByCharacter.label",
    ext: ".zip",
    descriptionKey: "importExport.format.audioByCharacter.description",
    lossy: false,
  },
  // Advanced-only option — not shown in the main format list.
  {
    id: "plain-text-dump",
    labelKey: "importExport.format.plainTextDump.label",
    ext: ".txt",
    descriptionKey: "importExport.format.plainTextDump.description",
    lossy: true,
  },
  // AQU-441: Metadata/cast spreadsheet — listed in Advanced section.
  {
    id: "metadata-csv",
    labelKey: "importExport.format.metadataCsv.label",
    ext: ".csv",
    descriptionKey: "importExport.format.metadataCsv.description",
    lossy: false,
  },
]

/**
 * FileType → the ExportFormat that reproduces the file in its own format.
 * usfm/docx/pptx round-trip through the original bytes (server side-car);
 * the rest re-serialize from structure. Types absent here (ebible, helloao,
 * obs, sdbh, audio, video) have no single-file native download.
 */
const NATIVE_EXPORT_BY_FILE_TYPE: Partial<Record<string, ExportFormat>> = {
  usfm: "usfm",
  docx: "docx",
  pptx: "pptx",
  idml: "idml",
  md: "md",
  txt: "txt",
  vtt: "vtt",
  srt: "srt",
  xliff: "xlf",
  tmx: "tmx",
  csv: "csv",
  tsv: "tsv",
}

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
  /**
   * The active file's import type (FileType: "usfm" | "docx" | "pptx" | "md" |
   * "txt" | …). Drives the primary "Download <file>" action — the file's own
   * format is the default export. `null`/unknown types get no primary download
   * and open the format list instead.
   */
  activeFileType?: string | null
  /** All project files — used only for project-scope USFM zip. */
  projectFiles: { id: string; name: string; type: string }[]
  sourceLanguage?: string
  targetLanguage?: string
  /** Storage lane for the active target. Distinct from its display language. */
  targetLang?: string
  /** Project TTS settings including cast assignments and voice library.
   *  Required for "audio-by-character" export; safe to omit for other formats. */
  ttsSettings?: ProjectTtsSettings
  getToken: (fileId: string) => Promise<string | null>
  /** Organization identifier used for internal/beta rollout allowlists. */
  orgId?: string
  /** Opens the import flow when an IDML locator or anchor needs repair. */
  onReimport?: () => void
  /**
   * AQU-654: count of outstanding (non-waived) LQA/validation "health"
   * infractions on the active file. Export NEVER hard-blocks on these — the
   * only export gate is org policy (`canExport`). When there are outstanding
   * infractions we surface a calm, non-blocking note so users understand the
   * flags won't stop the download (the reported bug was users believing these
   * "HTML/validation health errors" blocked export). Defaults to 0.
   */
  outstandingInfractionCount?: number
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
  activeFileType = null,
  projectFiles,
  sourceLanguage = "und",
  targetLanguage = "und",
  targetLang = "",
  ttsSettings,
  getToken,
  orgId,
  onReimport,
  outstandingInfractionCount = 0,
}: ExportDialogProps) {
  const { locale } = useI18n()
  const t = useT()
  // The file's own format is the default export — "give me my file back".
  // Types without a 1:1 native exporter (ebible, obs, audio, video, sdbh, …)
  // have no primary download; the format list opens instead.
  const nativeFormatId = activeFileType ? NATIVE_EXPORT_BY_FILE_TYPE[activeFileType] ?? null : null
  const effectiveIdmlCopy = idmlOrgEligible(orgId, import.meta.env)
    ? CURRENT_IDML_FORMAT_COPY
    : idmlFormatCopy({})
  const formatOptions = useMemo(() => BASE_FORMAT_OPTIONS.map((option) => (
    option.id === "idml"
      ? { ...option, labelKey: effectiveIdmlCopy.label, descriptionKey: effectiveIdmlCopy.description }
      : option
  )), [effectiveIdmlCopy.description, effectiveIdmlCopy.label])
  const nativeOption = nativeFormatId ? formatOptions.find((f) => f.id === nativeFormatId)! : null

  const [format, setFormat] = useState<ExportFormat>(nativeFormatId ?? "tsv")
  const [scope, setScope] = useState<ExportScope>("file")
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // "Export to another format" section — collapsed when the primary download
  // covers the common case, open when there is no native format to offer.
  const [formatsOpen, setFormatsOpen] = useState(nativeFormatId == null)

  // Re-derive defaults when the dialog opens on a (possibly different) file.
  const prevOpenRef = useRef(open)
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setFormat(nativeFormatId ?? "tsv")
      setFormatsOpen(nativeFormatId == null)
    }
    prevOpenRef.current = open
  }, [open, nativeFormatId])
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
    setFormat(nativeFormatId ?? "tsv")
  }, [activeFileId, nativeFormatId])

  // audio-by-character, vtt, docx, pptx, and plain-text-dump only support file scope.
  const fileOnlyFormats = ["audio-by-character", "vtt", "docx", "pptx", "idml", "plain-text-dump"] as const
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
  const [idmlRecovery, setIdmlRecovery] = useState<{
    bytes: ArrayBuffer
    downloadName: string
  } | null>(null)

  const selectedFormat = formatOptions.find((f) => f.id === format)!
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
  const projectScopeEnabled = format === "sdbh-xml" || (scope === "project" && format !== "usfm" && format !== "audio-by-character" && format !== "vtt" && format !== "docx" && format !== "pptx" && format !== "plain-text-dump")

  const { files: projectFileCells, isLoading: projectCellsLoading, error: projectCellsError } =
    useProjectCells({
      projectId,
      projectFiles,
      getToken,
      enabled: projectScopeEnabled,
      lane: targetLang,
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

  async function handleExport(overrideFormat?: ExportFormat) {
    if (!activeFileId) return
    // The primary "Download <file>" button passes the native format explicitly
    // and always targets the current file; the footer Export button uses the
    // selected radio format + scope.
    const fmt = overrideFormat ?? format
    const fmtOption = formatOptions.find((f) => f.id === fmt)!
    const runScope: ExportScope = overrideFormat
      ? "file"
      : fmt === "sdbh-xml"
        ? "project"
        : (fileOnlyFormats as readonly string[]).includes(fmt)
          ? "file"
          : scope
    setStatus({ kind: "busy", msg: t("importExport.status.exporting") })
    setFidelityWarnings([])
    setIdmlRecovery(null)
    let recoverableIdmlOriginal: { bytes: ArrayBuffer; downloadName: string } | null = null
    let idmlTelemetryStartedAt: number | null = null
    try {
      if (fmt === "usfm") {
        if (runScope === "project") {
          const result = await downloadProjectZip({
            projectId,
            projectName,
            files: projectFiles,
            getToken,
            targetLang,
            onProgress: (done, total) =>
              setStatus({ kind: "busy", msg: t("importExport.status.downloadingCount", { done, total }) }),
          })
          // Two independent counts (exported, skipped) — composed from two
          // separately-pluralized phrases instead of one template agreeing
          // with both numbers.
          const msg = result.skipped.length === 0
            ? t("importExport.status.exportedFilesCount", { count: result.exported })
            : `${t("importExport.status.exportedFilesCount", { count: result.exported })}; ${t("importExport.status.skippedOlderImports", { count: result.skipped.length })}`
          setStatus({ kind: "ok", msg })
        } else {
          // AQU-437: use user-chosen stem with .SFM extension.
          const stem = buildExportStem(false)
          const downloadName = `${stem}.SFM`
          // AQU-276: read lossy-verse count from response header.
          const result = await downloadSourceFile({ projectId, fileId: activeFileId, downloadName, getToken, targetLang })
          const lossyCount = result.lossyVerseCount
          if (lossyCount !== null && lossyCount > 0) {
            setStatus({
              kind: "ok-lossy",
              msg: t("importExport.status.exportedFile", { fileName: downloadName }),
              lossyVerseCount: lossyCount,
            })
          } else {
            setStatus({ kind: "ok", msg: t("importExport.status.exportedFile", { fileName: downloadName }) })
          }
        }
      } else if (fmt === "docx") {
        // AQU-233: DOCX round-trip export. Fetch the raw DOCX side-car from the
        // server, then inject translations client-side using JSZip + DOMParser.
        setStatus({ kind: "busy", msg: t("importExport.status.fetchingOriginalDocument") })
        const rawBytes = await fetchSourceSidecar({ projectId, fileId: activeFileId, getToken, targetLang })
        setStatus({ kind: "busy", msg: t("importExport.status.injectingTranslations") })
        const { exportDocx } = await import("@/lib/export/exporters/docx")
        const result = await exportDocx(rawBytes, cells)
        const baseName = buildExportStem(false) // AQU-437: user-chosen stem
        downloadBlob(result.blob, `${baseName}.docx`)
        setFidelityWarnings([
          ...result.warnings.map((w) => ({
            kind: "inline-style-simplified" as const,
            segment: w.segment,
            detail: w.detail,
          })),
          ...collectInlineStyleWarnings(cells),
        ])
        const fileName = `${baseName}.docx`
        setStatus({
          kind: "ok",
          msg: result.injected === 0
            ? t("importExport.status.downloadedNoTranslations", { fileName })
            : t("importExport.status.downloadedParagraphsTranslated", { fileName, count: result.injected }),
        })
      } else if (fmt === "pptx") {
        // AQU-152a: PPTX round-trip export. Fetch the raw PPTX side-car from
        // the server, then inject translations client-side (JSZip + DOMParser),
        // mirroring the DOCX path above.
        setStatus({ kind: "busy", msg: t("importExport.status.fetchingOriginalPresentation") })
        const rawBytes = await fetchSourceSidecar({ projectId, fileId: activeFileId, getToken, targetLang })
        setStatus({ kind: "busy", msg: t("importExport.status.injectingTranslations") })
        const { exportPptx } = await import("@/lib/export/exporters/pptx")
        const result = await exportPptx(rawBytes, cells)
        const baseName = buildExportStem(false)
        downloadBlob(result.blob, `${baseName}.pptx`)
        setFidelityWarnings([
          ...result.warnings.map((w) => ({
            kind: "inline-style-simplified" as const,
            segment: w.segment,
            detail: w.detail,
          })),
          ...collectInlineStyleWarnings(cells),
        ])
        const fileName = `${baseName}.pptx`
        setStatus({
          kind: "ok",
          msg: result.injected === 0
            ? t("importExport.status.downloadedNoTranslations", { fileName })
            : t("importExport.status.downloadedParagraphsTranslated", { fileName, count: result.injected }),
        })
      } else if (fmt === "idml") {
        idmlTelemetryStartedAt = performance.now()
        // IDML v2 export is fail-closed: the shared engine proves every
        // translated locator and protected anchor before changing package bytes.
        setStatus({ kind: "busy", msg: t("importExport.status.fetchingOriginalDocument") })
        const rawBytes = await fetchSourceSidecar({ projectId, fileId: activeFileId, getToken, targetLang })
        const baseName = buildExportStem(false)
        recoverableIdmlOriginal = { bytes: rawBytes.slice(0), downloadName: `${baseName}-original.idml` }
        setStatus({ kind: "busy", msg: t("importExport.status.validatingProtectedTranslations") })
        const { exportIdml } = await import("@/lib/export/exporters/idml")
        const result = await exportIdml(rawBytes, cells)
        posthog.capture("idml export completed", idmlTelemetryProperties({
          cells,
          report: result.report,
          diagnostics: result.diagnostics,
          durationMs: performance.now() - idmlTelemetryStartedAt,
        }))
        downloadBlob(result.blob, `${baseName}.idml`)
        const fileName = `${baseName}.idml`
        setStatus({
          kind: "ok",
          msg: result.report.translated === 0
            ? t("importExport.status.downloadedIdmlUnchanged", { fileName })
            : t("importExport.status.downloadedParagraphsTranslated", { fileName, count: result.report.translated }),
        })
      } else if (fmt === "audio-by-character") {
        setStatus({ kind: "busy", msg: t("importExport.status.decodingAudio") })
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
          onProgress: (d, tot) => setStatus({ kind: "busy", msg: t("importExport.status.decodingCount", { done: d, total: tot }) }),
        })
        const safe = buildExportStem(false) // AQU-437: user-chosen stem
        downloadBlob(result.blob, `${safe}_audio-by-character.zip`)
        setStatus({
          kind: "ok",
          msg: result.skipped > 0
            ? t("importExport.status.exportedAudioByCharacterWithSkipped", { count: result.skipped })
            : t("importExport.status.exportedAudioByCharacter"),
        })
      } else if (fmt === "sdbh-xml") {
        // SDBH round-trip: reinject every translated lexicon cell into the
        // user-supplied MARBLE XML skeleton, keyed by LEXID-derived cell ids.
        if (!sdbhSkeleton) {
          setStatus({ kind: "error", msg: t("importExport.status.chooseSkeletonFirst") })
          return
        }
        if (projectCellsLoading) {
          setStatus({ kind: "busy", msg: t("importExport.status.stillLoadingCells") })
          return
        }
        if (projectCellsError) {
          setStatus({ kind: "error", msg: t("importExport.status.couldNotLoadProject", { message: projectCellsError.message }) })
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
          setStatus({ kind: "error", msg: t("importExport.status.noLexMeaningEntries") })
          return
        }
        const stem = buildExportStem(true)
        downloadBlob(new Blob([xml], { type: "application/xml" }), `${stem}.XML`)
        // Two independent counts (senses reinjected, gloss warnings) — composed
        // from two separately-authored phrases rather than one template.
        const base = t("importExport.status.reinjectedTranslations", {
          translations: formatNumber(byCellId.size, locale),
          senses: formatNumber(sensesInjected, locale),
        })
        const warnNote = warnings.length ? t("importExport.status.glossWarnings", { count: warnings.length }) : ""
        setStatus({ kind: "ok", msg: `${base}${warnNote}` })
      } else if (runScope === "project") {
        // Client-side project-scope zip: use already-loaded per-file cells.
        if (projectCellsLoading) {
          setStatus({ kind: "busy", msg: t("importExport.status.stillLoadingCells") })
          return
        }
        if (projectCellsError) {
          setStatus({ kind: "error", msg: t("importExport.status.couldNotLoadProject", { message: projectCellsError.message }) })
          return
        }
        // AQU-441: metadata-csv project scope — flatten all file cells into one sheet.
        if (fmt === "metadata-csv") {
          const allCells = projectFileCells.flatMap((f) => f.cells)
          const csvBlob = exportMetadataCsv(allCells, ttsSettings)
          const safeName = buildExportStem(true)
          downloadBlob(csvBlob, `${safeName}.csv`)
          setStatus({
            kind: "ok",
            msg: t("importExport.status.downloadedMetadataCsvRows", { fileName: `${safeName}.csv`, count: allCells.length }),
          })
          return
        }
        setStatus({ kind: "busy", msg: t("importExport.status.buildingZip", { count: projectFileCells.length }) })
        const zipBlob = await buildProjectZip({
          files: projectFileCells,
          format: fmt as TextExportFormat,
          sourceLanguage,
          targetLanguage,
        })
        const safeName = buildExportStem(true) // AQU-437: project scope uses project name + suffixes
        const ext = fmtOption.ext
        downloadBlob(zipBlob, `${safeName}${ext}.zip`)
        setFidelityWarnings(projectFileCells.flatMap((f) => collectInlineStyleWarnings(f.cells)))
        setStatus({ kind: "ok", msg: t("importExport.status.downloadedFilesCount", { count: projectFileCells.length }) })
      } else {
        // Client-side single-file exporter
        // AQU-439: apply voice filter before passing to any exporter.
        const filteredCells = applyVoiceFilter(cells)
        let blob: Blob
        const baseName = buildExportStem(false) // AQU-437: user-chosen stem
        const ext = fmtOption.ext
        switch (fmt) {
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
            throw new Error(`Unknown format: ${fmt}`)
        }
        downloadBlob(blob, `${baseName}${ext}`)
        setFidelityWarnings(collectInlineStyleWarnings(filteredCells))
        setStatus({ kind: "ok", msg: t("importExport.status.downloadedFile", { fileName: `${baseName}${ext}` }) })
      }
    } catch (e) {
      if (recoverableIdmlOriginal) setIdmlRecovery(recoverableIdmlOriginal)
      if (idmlTelemetryStartedAt !== null) {
        posthog.capture("idml export blocked", idmlTelemetryProperties({
          cells,
          diagnostics: (
            e && typeof e === "object" && Array.isArray((e as { diagnostics?: unknown }).diagnostics)
              ? (e as { diagnostics: [] }).diagnostics
              : []
          ),
          durationMs: performance.now() - idmlTelemetryStartedAt,
        }))
      }
      setStatus({ kind: "error", msg: (e as Error).message || t("importExport.status.exportFailed") })
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setStatus({ kind: "idle" })
      setFidelityWarnings([])
      setIdmlRecovery(null)
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
          <DialogTitle>{t("nav.workspaceActions.export")}</DialogTitle>
        </DialogHeader>

        {/* AQU-458: the whole body scrolls as one region (DialogBody =
            min-h-0 flex-1 overflow-y-auto) instead of nesting a fixed-height
            scroll area inside the Format fieldset. A max-h-64 inner scroll
            on just the format list got clipped by the dialog's own
            overflow-hidden + max-h-[85dvh] on short/tablet viewports, making
            the lower format options unreachable. */}
        <DialogBody className="flex flex-col gap-4">
        {!canExport ? (
          /* Permission gate (AQU-253 revised): explain the block instead of
             hiding it, and point at the roles & permissions docs. */
          <div
            role="note"
            aria-label={t("importExport.dialog.permissionRequiredAriaLabel")}
            className="flex flex-col gap-2 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 px-3 py-3 text-sm text-amber-700 dark:text-amber-300"
          >
            <span className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t("importExport.dialog.noExportPermission")}
            </span>
            <p className="text-xs leading-relaxed">
              {t("importExport.dialog.permissionExplanation")}
            </p>
            <a
              href="https://help.aquilla.app/permissions"
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium underline underline-offset-2 hover:opacity-80"
            >
              {t("importExport.dialog.permissionsLinkText")}
            </a>
          </div>
        ) : (
        <>
        {/* AQU-654: outstanding validation/health flags NEVER block export.
            Export is a basic, must-not-fail function — the only gate is org
            policy (handled above). When the active file still has flagged
            infractions, reassure the user (calmly, not as an error) that they
            can download now and resolve the flags whenever they like. */}
        {outstandingInfractionCount > 0 && (
          <div
            role="note"
            aria-label={t("importExport.dialog.validationDoesNotBlockAriaLabel")}
            data-testid="export-nonblocking-health-note"
            className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground"
          >
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            <span>
              <RichMessage
                k="importExport.dialog.outstandingFlagsNote"
                count={outstandingInfractionCount}
                values={{
                  count: outstandingInfractionCount,
                  wontBlock: <strong>{t("importExport.dialog.wontBlockExport")}</strong>,
                }}
              />
            </span>
          </div>
        )}
        {/* Primary action: download the file back in its own format. */}
        {nativeOption && (
          <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-accent/30 px-3 py-3">
            <Button
              size="lg"
              className="w-full justify-center"
              onClick={() => handleExport(nativeOption.id)}
              disabled={!activeFileId || isBusy}
              aria-busy={isBusy}
            >
              {isBusy ? (
                <Spinner aria-hidden="true" />
              ) : (
                <Download className="h-4 w-4" aria-hidden="true" />
              )}
              {t("importExport.dialog.downloadFile", { fileName: `${buildExportStem(false)}${nativeOption.ext}` })}
            </Button>
            <p className="text-xs text-muted-foreground text-center leading-relaxed">
              {t("importExport.dialog.nativeFormatHint", { label: t(nativeOption.labelKey) })}
              {nativeOption.lossy && ` ${t("importExport.dialog.someFormattingMayNotCarryOver")}`}
            </p>
          </div>
        )}

        {/* Everything else is a conversion — tucked behind a collapse. */}
        <details
          open={formatsOpen}
          onToggle={(e) => setFormatsOpen((e.currentTarget as HTMLDetailsElement).open)}
          className="group"
        >
          <summary className="text-xs font-medium text-muted-foreground select-none list-none flex items-center gap-1 hover:text-foreground transition-colors">
            <span
              className={
                "inline-block transition-transform " +
                (formatsOpen ? "rotate-90" : "rotate-0")
              }
              aria-hidden="true"
            >
              ›
            </span>
            {t("importExport.dialog.exportToAnotherFormat")}
          </summary>
          <div className="mt-2.5 flex flex-col gap-4">
        {/* Format selector */}
        <fieldset className="flex flex-col gap-1.5 min-w-0">
          <legend className="text-xs font-medium text-muted-foreground mb-1.5">
            {t("importExport.dialog.formatLegend")}
          </legend>
          <RadioGroup
            value={format}
            onValueChange={(value) => setFormat(value as ExportFormat)}
            className="flex flex-col gap-0.5"
            aria-label={t("importExport.dialog.formatGroupAriaLabel")}
          >
            {formatOptions.filter((f) => {
              if (f.id === "usfm") return activeFileType === "usfm"
              if (f.id === "docx") return activeFileType === "docx" // AQU-233: only for docx imports
              if (f.id === "pptx") return activeFileType === "pptx" // AQU-152a: only for pptx imports
              if (f.id === "idml") return activeFileType === "idml" // only for idml imports
              if (f.id === "sdbh-xml") return hasSdbhFiles // SDBH round-trip: only for lexicon projects
              if (f.id === "plain-text-dump") return false // shown in Advanced section only
              return true
            }).map((f) => (
              <label
                key={f.id}
                className={
                  "flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors " +
                  (format === f.id
                    ? "bg-accent/60 ring-1 ring-ring/20"
                    : "hover:bg-accent/40")
                }
              >
                <RadioGroupItem
                  value={f.id}
                  className="mt-0.5 shrink-0"
                  aria-label={t("importExport.dialog.formatOptionAriaLabel", { label: t(f.labelKey), ext: f.ext })}
                />
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-medium leading-tight flex items-baseline gap-1.5 flex-wrap">
                    {t(f.labelKey)}
                    <span className="text-xs text-muted-foreground font-normal font-mono">{f.ext}</span>
                    {f.lossy && (
                      <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">
                        {t("importExport.dialog.lossyBadge")}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground leading-relaxed">{t(f.descriptionKey)}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </fieldset>

        {/* Scope selector */}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-medium text-muted-foreground mb-1.5">
            {t("importExport.dialog.scopeLegend")}
          </legend>
          <SegmentTabs<ExportScope>
            value={effectiveScope}
            aria-label={t("importExport.dialog.scopeGroupAriaLabel")}
            className="self-start"
            options={[
              { label: t("search.dialog.scopeCurrentFile"), value: "file", disabled: isProjectOnlyFormat },
              { label: t("importExport.dialog.scopeProject"), value: "project", disabled: isFileOnlyFormat },
            ]}
            onValueChange={setScope}
          />
          {isFileOnlyFormat && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {t("importExport.dialog.scopeNotSupportedHint")}
            </p>
          )}
          {isProjectOnlyFormat && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {t("importExport.dialog.scopeAlwaysProjectHint")}
            </p>
          )}

          {/* SDBH XML skeleton picker — the original MARBLE edition to reinject into. */}
          {format === "sdbh-xml" && (
            <div className="mt-1.5 flex flex-col gap-1">
              <Button variant="outline" size="sm" nativeButton={false} render={<label className="self-start" />}>
                {sdbhSkeleton ? sdbhSkeleton.name : t("importExport.dialog.chooseSdbhSkeleton")}
                <input
                  type="file"
                  className="hidden"
                  accept=".xml,.XML"
                  onChange={(e) => setSdbhSkeleton(e.target.files?.[0] ?? null)}
                />
              </Button>
              <p className="text-[10px] text-muted-foreground">
                {t("importExport.dialog.sdbhSkeletonHint")}
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
        </fieldset>

        {/* AQU-439: Voice filter — only shown when cells have cast assignments */}
        {distinctVoices.length > 0 && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs font-medium text-muted-foreground mb-1.5">
              {t("importExport.dialog.voiceLegend")}
            </legend>
            <select
              value={voiceFilter}
              onChange={(e) => setVoiceFilter(e.target.value)}
              aria-label={t("importExport.dialog.voiceFilterAriaLabel")}
              className="h-7 w-full rounded-md border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">{t("importExport.dialog.allVoices")}</option>
              {distinctVoices.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
            {voiceFilter && (
              <p className="text-[10px] text-muted-foreground">
                <RichMessage
                  k="importExport.dialog.voiceFilterHint"
                  values={{ voice: <strong>{voiceFilter}</strong> }}
                />
              </p>
            )}
          </fieldset>
        )}

        {/* AQU-437: Filename control — editable base name + optional suffixes */}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-medium text-muted-foreground mb-1.5">
            {t("importExport.dialog.filenameLegend")}
          </legend>
          <div className="flex flex-col gap-2">
            {/* Base name input — disabled for project scope (project name drives it) */}
            <Input
              value={effectiveScope === "project" ? projectName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "project" : customBaseName}
              onChange={(e) => setCustomBaseName(e.target.value)}
              disabled={effectiveScope === "project"}
              placeholder={t("importExport.dialog.filenameLegend")}
              aria-label={t("importExport.dialog.filenameAriaLabel")}
              className="h-7 text-sm font-mono"
            />
            {effectiveScope === "project" && (
              <p className="text-[10px] text-muted-foreground -mt-0.5">
                {t("importExport.dialog.projectScopeUsesProjectName")}
              </p>
            )}
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                <Checkbox
                  checked={appendTimestamp}
                  onCheckedChange={(c) => setAppendTimestamp(c === true)}
                />
                {t("importExport.dialog.appendTimestamp")}
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                <Checkbox
                  checked={appendLangTag}
                  onCheckedChange={(c) => setAppendLangTag(c === true)}
                />
                {t("importExport.dialog.appendLangTag")}
              </label>
            </div>
          </div>
        </fieldset>

        {/* Audio-by-character inline preview */}
        {format === "audio-by-character" && effectiveScope === "file" && (() => {
          const preview = previewAudioByCharacter(cells, ttsSettings)
          return (
          <div className="flex flex-col gap-1 text-xs">
            <p className="font-medium text-muted-foreground text-[10px]">{t("common.preview")}</p>
            {preview.length === 0 ? (
              <p className="text-muted-foreground">{t("importExport.dialog.noCellsWithAudio")}</p>
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
                    {t("importExport.dialog.clipCount", { count: p.clipCount })}
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
            aria-label={t("importExport.dialog.lossyWarningAriaLabel")}
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              {t("importExport.dialog.lossyWarningText")}
            </span>
          </div>
        )}

        {/* Advanced section: plain-text dump */}
        <details
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
          className="group"
        >
          <summary className="text-xs font-medium text-muted-foreground select-none list-none flex items-center gap-1 hover:text-foreground transition-colors">
            <span
              className={
                "inline-block transition-transform " +
                (advancedOpen ? "rotate-90" : "rotate-0")
              }
              aria-hidden="true"
            >
              ›
            </span>
            {t("importExport.dialog.advanced")}
          </summary>
          <div className="mt-2.5 flex flex-col gap-2.5 ps-3 border-s border-border/40">
            {/* Plain-text dump — shares the `format` state with the main list
                above, but lives in its own RadioGroup wrapper since Base UI
                radios need a group ancestor. */}
            <RadioGroup
              value={format}
              onValueChange={(value) => setFormat(value as ExportFormat)}
              aria-label={t("importExport.dialog.advancedFormatsAriaLabel")}
            >
            <label
              className={
                "flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors " +
                (format === "plain-text-dump"
                  ? "bg-accent/60 ring-1 ring-ring/20"
                  : "hover:bg-accent/40")
              }
            >
              <RadioGroupItem
                value="plain-text-dump"
                className="mt-0.5 shrink-0"
                aria-label={t("importExport.dialog.formatOptionAriaLabel", { label: t("importExport.format.plainTextDump.label"), ext: ".txt" })}
              />
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm font-medium leading-tight flex items-baseline gap-1.5 flex-wrap">
                  {t("importExport.format.plainTextDump.label")}
                  <span className="text-xs text-muted-foreground font-normal font-mono">.txt</span>
                  <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">
                    {t("importExport.dialog.lossyBadge")}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground leading-relaxed">
                  <RichMessage
                    k="importExport.dialog.plainTextDumpDetail"
                    values={{ whatThisLoses: <strong className="font-medium text-foreground/70">{t("importExport.dialog.whatThisLoses")}</strong> }}
                  />
                </span>
                {format === "plain-text-dump" && (
                  <label className="flex items-center gap-1.5 mt-1">
                    <Checkbox
                      checked={dumpIncludeRefs}
                      onCheckedChange={(checked) => setDumpIncludeRefs(checked === true)}
                    />
                    <span className="text-xs text-muted-foreground">
                      <RichMessage
                        k="importExport.dialog.prefixWithRef"
                        values={{ example: <code className="font-mono">GEN 1:1</code> }}
                      />
                    </span>
                  </label>
                )}
              </span>
            </label>
            {/* AQU-441: Metadata spreadsheet — cast, camera angle, cell ref */}
            <label
              className={
                "flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors " +
                (format === "metadata-csv"
                  ? "bg-accent/60 ring-1 ring-ring/20"
                  : "hover:bg-accent/40")
              }
            >
              <RadioGroupItem
                value="metadata-csv"
                className="mt-0.5 shrink-0"
                aria-label={t("importExport.dialog.formatOptionAriaLabel", { label: t("importExport.format.metadataCsv.label"), ext: ".csv" })}
              />
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm font-medium leading-tight flex items-baseline gap-1.5 flex-wrap">
                  {t("importExport.format.metadataCsv.label")}
                  <span className="text-xs text-muted-foreground font-normal font-mono">.csv</span>
                </span>
                <span className="text-xs text-muted-foreground leading-relaxed">
                  {t("importExport.format.metadataCsv.description")}
                </span>
              </span>
            </label>
            </RadioGroup>
          </div>
        </details>
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
              {status.kind === "error" && idmlRecovery && (
                <span className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      downloadBlob(
                        new Blob([idmlRecovery.bytes], {
                          type: "application/vnd.adobe.indesign-idml-package",
                        }),
                        idmlRecovery.downloadName,
                      )
                    }}
                  >
                    {t("importExport.dialog.downloadOriginalUnchanged")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      handleOpenChange(false)
                      onReimport?.()
                    }}
                    disabled={!onReimport}
                  >
                    {t("importExport.dialog.repairByReimporting")}
                  </Button>
                </span>
              )}
              {status.kind === "ok-lossy" && (
                <span className="flex items-start gap-1 text-amber-600 dark:text-amber-400 text-xs font-medium">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                  {t("importExport.dialog.lossyVerseCount", { count: status.lossyVerseCount })}
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
              {t("importExport.dialog.fidelityWarningsHeader", { count: fidelityWarnings.length })}
            </span>
            <ul className="ms-4 list-disc space-y-0.5">
              {fidelityWarnings.slice(0, 6).map((w, i) => (
                <li key={i}>
                  <span className="font-medium">{w.segment}</span>: {w.detail}
                </li>
              ))}
              {fidelityWarnings.length > 6 && <li>{t("importExport.dialog.andMore", { count: fidelityWarnings.length - 6 })}</li>}
            </ul>
          </div>
        )}
        </>
        )}
        </DialogBody>

        <DialogFooter>
          {!canExport ? (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t("common.close")}
            </Button>
          ) : (
            <>
              <Button
                variant={isDone ? "default" : "outline"}
                onClick={() => handleOpenChange(false)}
                disabled={isBusy}
              >
                {isDone ? t("common.done") : t("common.cancel")}
              </Button>
              <Button
                onClick={() => handleExport()}
                disabled={!activeFileId || isBusy}
                aria-busy={isBusy}
                variant={isDone ? "outline" : "default"}
              >
                {isBusy ? (
                  <Spinner aria-hidden="true" />
                ) : (
                  <Download className="h-4 w-4" aria-hidden="true" />
                )}
                {isBusy ? t("importExport.status.exporting") : isDone ? t("importExport.dialog.exportAgain") : t("nav.workspaceActions.export")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
