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
import { Download, AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react"
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
import { toast } from "sonner"

import { previewAudioByCharacter } from "@/lib/export/audio-by-character"
import { exportMetadataCsv } from "@/lib/export/exporters/metadata-csv"
import { injectSdbhXml } from "@/lib/parsers/sdbh"
import { useProjectCells } from "@/hooks/useProjectCells"
import type { CellData } from "@/hooks/useCells"
import type { CueLinkIndex } from "@/lib/sync/cell-links-read"
import type { CharacterResolution, ProjectTtsSettings } from "@/lib/parsers/types"
import posthog from "@/lib/posthog"
import {
  CURRENT_IDML_FORMAT_COPY,
  idmlFormatCopy,
  idmlOrgEligible,
} from "@/lib/idml/release-gate"
import { idmlTelemetryProperties } from "@/lib/idml/telemetry"

export type ExportFormat = "usfm" | "txt" | "md" | "tsv" | "csv" | "xlf" | "tmx" | "vtt" | "srt" | "audio-by-character" | "audio-by-line" | "character-sheets" | "project-report" | "docx" | "pptx" | "idml" | "plain-text-dump" | "metadata-csv" | "sdbh-xml"
export type ExportScope = "file" | "project"

interface FormatOption {
  id: ExportFormat
  label: string
  ext: string
  description: string
  lossy: boolean
}

const BASE_FORMAT_OPTIONS: FormatOption[] = [
  {
    id: "usfm",
    label: "USFM",
    ext: ".SFM",
    description: "Round-trip USFM with translations injected back into the original markup. Requires the original file data on the server (re-import to enable for older files).",
    lossy: false,
  },
  {
    // AQU-233: DOCX export with paragraph/heading structure preserved.
    // Only shown for files imported as .docx.
    id: "docx",
    label: "Word (.docx)",
    ext: ".docx",
    description: "Translations injected back into the original Word document. Paragraph/heading structure is preserved; per-run bold/italic inside translated paragraphs is not preserved. Requires the original file to have been imported after round-trip export support was added — files imported before then may lack a stored original (re-import to enable).",
    lossy: false,
  },
  {
    // AQU-152a: PPTX export with slide/shape/paragraph structure preserved.
    // Only shown for files imported as .pptx (activeFileType).
    id: "pptx",
    label: "PowerPoint (.pptx)",
    ext: ".pptx",
    description: "Translations injected back into the original slide deck. Slide/shape/paragraph structure is preserved; mixed per-run formatting inside a translated paragraph keeps the first run's styling. Requires the original file to have been imported after round-trip export support was added — re-import older files to enable.",
    lossy: false,
  },
  {
    // IDML v2 export remains experimental until the Adobe validation gate.
    // Only shown for files imported as .idml (activeFileType).
    id: "idml",
    label: CURRENT_IDML_FORMAT_COPY.label,
    ext: ".idml",
    description: CURRENT_IDML_FORMAT_COPY.description,
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
    description: "Round-trip plain text: paragraph structure preserved; untranslated paragraphs keep source (media lines use their transcription).",
    lossy: true,
  },
  {
    id: "md",
    label: "Markdown",
    ext: ".md",
    description: "Round-trip markdown: headings, ordered/unordered lists and quotes reconstructed; untranslated blocks keep source (media lines use their transcription).",
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
    description: "SubRip subtitles: numbered cues with millisecond timecodes; translated text per cue, source kept for untranslated cues (media lines use their transcription).",
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
    description: "One WAV per character, with every take at its own place on the timeline and silence in between. All files start at 0:00, so they drop onto a DAW already aligned with each other and with the film.",
    lossy: false,
  },
  {
    id: "character-sheets",
    label: "Character sheets (corrected)",
    ext: ".xlsx",
    description: "Both character spreadsheets back — subtitle and audio — with every resolved disagreement applied and a column saying what changed. Lines still in dispute are left as they are and marked unresolved. Rebuilt from what the app holds, so the audio sheet's own line numbers are renumbered and the Group camera state comes back as Mixed.",
    lossy: false,
  },
  {
    id: "project-report",
    label: "Project report",
    ext: ".html",
    description: "One document for the whole project: open disagreements, what is recorded and what is not, cues with no subtitle behind them, the timing correction each episode was imported with, and characters spelled more than one way.",
    lossy: false,
  },
  {
    id: "audio-by-line",
    label: "Audio by line",
    ext: ".zip",
    description: "One file per recording, numbered in playing order and named by character. Each WAV carries a broadcast timestamp a DAW can place from, and a manifest.csv lists every file with its timecode. For reviewing and re-recording individual lines.",
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
  /**
   * The cells that actually CARRY RECORDINGS, when they are not the ones above.
   *
   * Since stage 4 takes live on the audio-cue sibling, not on the subtitle
   * rows — so the per-character export was grouping ~650 rows that have no
   * audio at all and writing a valid, empty, 22-byte zip. Absent ⇒ `cells`,
   * which is every arrangement without an audio-cue track.
   */
  /** The cells that carry the recordings — the audio-cue sibling where there
   *  is one. MUST be the attachment-merged view: a raw cell read has no
   *  `selectedAudioId` and no attachments, so it looks take-less. */
  audioCells?: CellData[]
  /** Name the character for a cell the way the timeline and recorder do — via
   *  the links, so it works whichever character sheet was imported. */
  resolveCharacterName?: (cell: CellData) => string | null
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
  /**
   * The subtitle files the project report walks, each paired with its hidden
   * audio-cue sibling and what that sibling's import recorded about drift.
   *
   * A separate prop rather than a richer `projectFiles`: that one is a plain
   * id/name/type list used by half the dialog and by a dozen tests, and this is
   * the only export that needs to know siblings exist.
   */
  reportFiles?: { id: string; name: string; siblingId?: string | null; timebase?: { fromFps?: string; toFps?: string; scale: number } | null }[]
  /** The pairing graph between this file's lines and its audio cues. The
   *  corrected sheets need it to know which two rows are the same line. */
  cueLinks?: CueLinkIndex
  /** What has been settled in the character check drawer. The corrected sheets
   *  apply these and leave everything still in dispute alone. */
  characterResolutions?: Record<string, CharacterResolution>
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
  audioCells,
  resolveCharacterName,
  projectId,
  projectName,
  activeFileId,
  activeFileName,
  activeFileType = null,
  projectFiles,
  reportFiles,
  characterResolutions,
  cueLinks,
  sourceLanguage = "und",
  targetLanguage = "und",
  targetLang = "",
  ttsSettings,
  getToken,
  orgId,
  onReimport,
  outstandingInfractionCount = 0,
}: ExportDialogProps) {
  // The file's own format is the default export — "give me my file back".
  // Types without a 1:1 native exporter (ebible, obs, audio, video, sdbh, …)
  // have no primary download; the format list opens instead.
  const nativeFormatId = activeFileType ? NATIVE_EXPORT_BY_FILE_TYPE[activeFileType] ?? null : null
  const effectiveIdmlCopy = idmlOrgEligible(orgId, import.meta.env)
    ? CURRENT_IDML_FORMAT_COPY
    : idmlFormatCopy({})
  const formatOptions = useMemo(() => BASE_FORMAT_OPTIONS.map((option) => (
    option.id === "idml"
      ? { ...option, label: effectiveIdmlCopy.label, description: effectiveIdmlCopy.description }
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
  // Two shapes of subtitle file codex-editor offers as separate formats
  // (2026-08-18). Both default off: the file this produces untouched is the
  // one it has always produced.
  /** The live export toast, so the catch-all below can turn a spinner that
   *  will never finish into the error it actually was. */
  const exportToastRef = useRef<string | number | null>(null)
  const [vttCueSplitting, setVttCueSplitting] = useState(false)
  const [vttExcludeLabels, setVttExcludeLabels] = useState(false)
  /** Source above target in every cue — a review artifact, played against the
   *  picture to check the translation line by line. */
  const [vttIncludeSource, setVttIncludeSource] = useState(false)

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
  /**
   * Which array to export audio from.
   *
   * Taking the cue sibling when it merely EXISTS was not enough, twice over.
   * It reads as an empty array while it is still loading — a real state the
   * hook documents — and a nullish check happily exports that as "nothing to
   * export". And a file with no sibling at all carries its takes on its own
   * cells. So: take the one that demonstrably HAS a recording, and only fall
   * back when neither does.
   */
  const audioSourceCells = useMemo(() => {
    const hasTake = (list: CellData[] | undefined) =>
      list?.some((c) => {
        const id = c.selectedAudioId ?? c.selectedGeneratedVoiceAudioId
        return id != null && Boolean(c.attachments?.[id]?.url)
      }) === true
    if (hasTake(audioCells)) return audioCells!
    if (hasTake(cells)) return cells
    return audioCells ?? cells
  }, [audioCells, cells])

  /**
   * Is this a DUBBING file?
   *
   * Keyed on the import type alone (Sam, 2026-08-19), and deliberately not on
   * anything cleverer like "does it have a linked film or an audio-cue
   * sibling". Every VTT and SRT in this client's world is an episode being
   * dubbed, and a rule someone can state in one sentence beats an inference
   * that is right more often but explicable less often.
   *
   * What it changes: the featured area stops asking "what IS this file?" and
   * starts asking "what is this file FOR?". A dubbing project's deliverables
   * are its audio and its subtitles — not a TSV — so those get the top of the
   * dialog and everything else keeps its place in the fold.
   */
  const isDubbingFile = activeFileType === "vtt" || activeFileType === "srt"

  /** Who is in this file and what is recorded. Computed once: the Audio card
   *  reads the totals to decide whether it can export at all, and the preview
   *  list under it reads the same rows. */
  const audioPreview = useMemo(
    () => previewAudioByCharacter(audioSourceCells, ttsSettings, resolveCharacterName),
    [audioSourceCells, ttsSettings, resolveCharacterName],
  )
  const recordedLines = useMemo(
    () => audioPreview.reduce((n, c) => n + c.clipCount, 0),
    [audioPreview],
  )

  /** Which of the two audio deliverables the Audio card will produce. They are
   *  two forms of one thing — a mix track and a review folder — so they share a
   *  card and a button rather than competing as two entries in a list. */
  const [audioMode, setAudioMode] = useState<"audio-by-character" | "audio-by-line">("audio-by-character")

  const fileOnlyFormats = ["audio-by-character", "audio-by-line", "character-sheets", "vtt", "docx", "pptx", "idml", "plain-text-dump"] as const
  const isFileOnlyFormat = fileOnlyFormats.includes(format as typeof fileOnlyFormats[number])
  // SDBH XML reinjection spans every lexicon file — inherently project scope.
  // The report describes a PROJECT: name consistency only means anything across
  // episodes, since MARY in one and MARY MAGDALENE in the next is invisible
  // inside either file.
  const isProjectOnlyFormat = format === "sdbh-xml" || format === "project-report"
  const effectiveScope: ExportScope = isProjectOnlyFormat ? "project" : isFileOnlyFormat ? "file" : scope

  // SDBH XML export needs the original MARBLE edition as the skeleton.
  const [sdbhSkeleton, setSdbhSkeleton] = useState<File | null>(null)
  const hasSdbhFiles = projectFiles.some((f) => f.type === "sdbh")

  /**
   * What the fold offers, in what order.
   *
   * For a dubbing file the two audio exports and the subtitle round-trip are
   * FEATURED above, so they come out of this list — offering them twice invites
   * the two copies to drift, and the fold is meant to read as "everything
   * else". What is left is reordered so the things this workflow reaches for
   * come first: the other subtitle format, the corrected character sheets, the
   * metadata sheet, then the project report. Every other project is untouched
   * and keeps the original order.
   */
  const foldFormats = useMemo(() => {
    const visible = formatOptions.filter((f) => {
      if (f.id === "usfm") return activeFileType === "usfm"
      if (f.id === "docx") return activeFileType === "docx" // AQU-233: only for docx imports
      if (f.id === "pptx") return activeFileType === "pptx" // AQU-152a: only for pptx imports
      if (f.id === "idml") return activeFileType === "idml" // only for idml imports
      if (f.id === "sdbh-xml") return hasSdbhFiles // SDBH round-trip: only for lexicon projects
      if (f.id === "plain-text-dump") return false // shown in Advanced section only
      return true
    })
    if (!isDubbingFile) return visible
    const featured = new Set<string>(["audio-by-character", "audio-by-line", nativeFormatId ?? ""])
    const rest = visible.filter((f) => !featured.has(f.id))
    // The sibling subtitle format leads: a file imported as VTT features VTT
    // and offers SRT here, and the other way round.
    const first: string[] = [
      activeFileType === "srt" ? "vtt" : "srt",
      "character-sheets",
      "metadata-csv",
      "project-report",
    ]
    const rank = (id: string) => {
      const at = first.indexOf(id)
      return at === -1 ? first.length : at
    }
    return [...rest].sort((a, b) => rank(a.id) - rank(b.id))
  }, [activeFileType, formatOptions, hasSdbhFiles, isDubbingFile, nativeFormatId])


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
  const projectScopeEnabled = format === "sdbh-xml" || (scope === "project" && format !== "usfm" && format !== "audio-by-character" && format !== "audio-by-line" && format !== "vtt" && format !== "docx" && format !== "pptx" && format !== "plain-text-dump")

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
    setStatus({ kind: "busy", msg: "Exporting…" })
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
          const result = await downloadSourceFile({ projectId, fileId: activeFileId, downloadName, getToken, targetLang })
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
      } else if (fmt === "docx") {
        // AQU-233: DOCX round-trip export. Fetch the raw DOCX side-car from the
        // server, then inject translations client-side using JSZip + DOMParser.
        setStatus({ kind: "busy", msg: "Fetching original document…" })
        const rawBytes = await fetchSourceSidecar({ projectId, fileId: activeFileId, getToken, targetLang })
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
      } else if (fmt === "pptx") {
        // AQU-152a: PPTX round-trip export. Fetch the raw PPTX side-car from
        // the server, then inject translations client-side (JSZip + DOMParser),
        // mirroring the DOCX path above.
        setStatus({ kind: "busy", msg: "Fetching original presentation…" })
        const rawBytes = await fetchSourceSidecar({ projectId, fileId: activeFileId, getToken, targetLang })
        setStatus({ kind: "busy", msg: "Injecting translations…" })
        const { exportPptx } = await import("@/lib/export/exporters/pptx")
        const result = await exportPptx(rawBytes, cells)
        const baseName = buildExportStem(false)
        downloadBlob(result.blob, `${baseName}.pptx`)
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
        setStatus({ kind: "ok", msg: `Downloaded ${baseName}.pptx${note}` })
      } else if (fmt === "idml") {
        idmlTelemetryStartedAt = performance.now()
        // IDML v2 export is fail-closed: the shared engine proves every
        // translated locator and protected anchor before changing package bytes.
        setStatus({ kind: "busy", msg: "Fetching original document…" })
        const rawBytes = await fetchSourceSidecar({ projectId, fileId: activeFileId, getToken, targetLang })
        const baseName = buildExportStem(false)
        recoverableIdmlOriginal = { bytes: rawBytes.slice(0), downloadName: `${baseName}-original.idml` }
        setStatus({ kind: "busy", msg: "Validating protected translations…" })
        const { exportIdml } = await import("@/lib/export/exporters/idml")
        const result = await exportIdml(rawBytes, cells)
        posthog.capture("idml export completed", idmlTelemetryProperties({
          cells,
          report: result.report,
          diagnostics: result.diagnostics,
          durationMs: performance.now() - idmlTelemetryStartedAt,
        }))
        downloadBlob(result.blob, `${baseName}.idml`)
        const note = result.report.translated === 0
          ? " (no translations — original bytes returned unchanged)"
          : ` (${result.report.translated} paragraph${result.report.translated === 1 ? "" : "s"} translated)`
        setStatus({ kind: "ok", msg: `Downloaded ${baseName}.idml${note}` })
      } else if (fmt === "audio-by-character") {
        // A TOAST, not just the dialog's own line (Sam, 2026-08-18). This is
        // the one export that takes real time — every take is fetched, decoded
        // and laid onto a track — and the dialog's status is only visible while
        // the dialog is. The toast means you can close it and get on with
        // something else, and still be told when the zip is ready.
        exportToastRef.current = toast.loading("Preparing the character export…")
        setStatus({ kind: "busy", msg: "Decoding audio…" })
        const { exportAudioByCharacter } = await import("@/lib/export/audio-by-character")
        const { decodeToMono48k } = await import("@/lib/audio/decode-mono")
        let lastPct = -1
        const { fetchCellAudio } = await import("@/lib/audio/upload")
        // getToken is (fileId) => Promise<string|null>; SyncTokenForFile expects
        // (projectId, fileId) — wrap it to match the fetchCellAudio signature.
        const getSyncToken = (_pid: string, fileId: string) => getToken(fileId)
        const result = await exportAudioByCharacter({
          cells: audioSourceCells,
          resolveName: resolveCharacterName,
          settings: ttsSettings,
          projectId,
          langCode: targetLanguage || "und",
          // codex-editor's scheme: a dubber ends up with tracks from several
          // episodes in one folder, and `swh_JESUS.wav` twice over is no help.
          fileBase: defaultBaseName,
          fetchBytes: ({ projectId: pid, fileId, audioId, ext }) =>
            fetchCellAudio({ projectId: pid, fileId, audioId, ext, getSyncToken }),
          decode: decodeToMono48k,
          onProgress: (d, t) => {
            setStatus({ kind: "busy", msg: `Decoding ${d}/${t}…` })
            // Throttled to whole percentage points: an episode has hundreds of
            // takes, and re-rendering the toast for each one buys nothing a
            // person can read.
            const pct = t > 0 ? Math.floor((d / t) * 100) : 0
            if (pct === lastPct && d < t) return
            lastPct = pct
            toast.loading(
              d < t
                ? `Decoding recordings — ${pct}%`
                : // Everything is decoded; what is left is rendering the last
                  // character's track and compressing, which on a long episode
                  // is where the remaining wait actually goes.
                  "Building the archive…",
              { id: exportToastRef.current ?? undefined },
            )
          },
        })
        // REFUSE RATHER THAN DOWNLOAD NOTHING. A zip with no entries is still
        // a valid archive, and handing one over reads as success.
        if (result.characters === 0) {
          const msg =
            result.clips === 0
              ? "No recordings found in this file, so there is nothing to export."
              : `None of the ${result.clips} recordings could be read, so the export would be empty.`
          setStatus({ kind: "error", msg })
          toast.error(msg, { id: exportToastRef.current ?? undefined })
          exportToastRef.current = null
          return
        }
        const safe = buildExportStem(false) // AQU-437: user-chosen stem
        downloadBlob(result.blob, `${safe}_audio-by-character.zip`)
        // Say what did NOT make it, in words. An unplaceable take is not a
        // failure to read the audio — it is a line with no time on it, and the
        // fix is in the file rather than in the export.
        const notes: string[] = []
        if (result.skipped > 0) {
          notes.push(`${result.skipped} recording${result.skipped === 1 ? "" : "s"} could not be read`)
        }
        if (result.untimed > 0) {
          notes.push(
            `${result.untimed} recording${result.untimed === 1 ? " has" : "s have"} no timing, so ${result.untimed === 1 ? "it was" : "they were"} left out`,
          )
        }
        const doneMsg = notes.length
          ? `Exported audio by character — ${notes.join("; ")}.`
          : `Exported ${result.characters} character track${result.characters === 1 ? "" : "s"}.`
        setStatus({ kind: "ok", msg: doneMsg })
        toast.success(doneMsg, { id: exportToastRef.current ?? undefined })
        exportToastRef.current = null
      } else if (fmt === "audio-by-line") {
        // The other shape (Sam, 2026-08-18: "a separate track for each
        // recording? With timing data?"). No decoding — the stored bytes are
        // copied straight across, so this is lossless and fast where the
        // character export has to resample everything onto one timeline.
        setStatus({ kind: "busy", msg: "Collecting recordings…" })
        const { exportAudioPerLine } = await import("@/lib/export/audio-per-line")
        const { fetchCellAudio } = await import("@/lib/audio/upload")
        const getSyncToken = (_pid: string, fileId: string) => getToken(fileId)
        const result = await exportAudioPerLine({
          cells: audioSourceCells,
          resolveName: resolveCharacterName,
          settings: ttsSettings,
          projectId,
          langCode: targetLanguage || "und",
          fileBase: defaultBaseName,
          fetchBytes: ({ projectId: pid, fileId, audioId, ext }) =>
            fetchCellAudio({ projectId: pid, fileId, audioId, ext, getSyncToken }),
          onProgress: (d, t) => setStatus({ kind: "busy", msg: `Collecting ${d}/${t}…` }),
        })
        if (result.files === 0) {
          setStatus({
            kind: "error",
            msg:
              result.clips === 0
                ? "No recordings found in this file, so there is nothing to export."
                : `None of the ${result.clips} recordings could be read, so the export would be empty.`,
          })
          return
        }
        const safeLine = buildExportStem(false)
        downloadBlob(result.blob, `${safeLine}_audio-by-line.zip`)
        const lineNotes: string[] = []
        if (result.skipped > 0) {
          lineNotes.push(`${result.skipped} recording${result.skipped === 1 ? "" : "s"} could not be read`)
        }
        if (result.untimed > 0) {
          lineNotes.push(
            `${result.untimed} ${result.untimed === 1 ? "has" : "have"} no timing, so ${result.untimed === 1 ? "it carries" : "they carry"} no timestamp`,
          )
        }
        setStatus({
          kind: "ok",
          msg: lineNotes.length
            ? `Exported ${result.files} recordings — ${lineNotes.join("; ")}.`
            : `Exported ${result.files} recordings`,
        })
      } else if (fmt === "character-sheets") {
        // HER OWN FILES, BACK, CORRECTED. She resolves the disagreements here
        // and her team keeps working from the spreadsheets that still contain
        // every error she fixed; this is the only export that closes that loop.
        if (!cueLinks || (audioCells?.length ?? 0) === 0) {
          setStatus({
            kind: "error",
            msg: "This file has no audio cues imported, so there is only one character sheet and nothing to reconcile.",
          })
          return
        }
        setStatus({ kind: "busy", msg: "Building the sheets…" })
        const { buildCharacterSheets } = await import("@/lib/export/character-sheets")
        const sheetBlob = await buildCharacterSheets({
          textCells: cells,
          cueCells: audioCells ?? [],
          links: cueLinks,
          settings: ttsSettings,
          ...(characterResolutions ? { resolutions: characterResolutions } : {}),
        })
        const sheetName = buildExportStem(false)
        downloadBlob(sheetBlob, `${sheetName}_character-sheets.xlsx`)
        setStatus({ kind: "ok", msg: `Downloaded ${sheetName}_character-sheets.xlsx` })
      } else if (fmt === "project-report") {
        // The only export that reads the WHOLE project: every episode's cues,
        // recordings and links, four reads apiece. Sequential on purpose — a
        // fifteen-file project should not open sixty connections at once.
        const files = reportFiles ?? []
        if (files.length === 0) {
          setStatus({ kind: "error", msg: "No subtitle files in this project to report on." })
          return
        }
        setStatus({ kind: "busy", msg: "Reading the project…" })
        const { runProjectReport } = await import("@/lib/export/project-report-run")
        const { renderProjectReport } = await import("@/lib/export/project-report")
        const { fetchAllFileCells } = await import("@/lib/sync/cells-read")
        const { fetchFileAudioAttachments } = await import("@/lib/sync/cell-audio-read")
        const { fetchFileCellLinks } = await import("@/lib/sync/cell-links-read")
        const run = await runProjectReport({
          projectId,
          projectName,
          files,
          settings: ttsSettings,
          ...(characterResolutions ? { resolutions: characterResolutions } : {}),
          getToken,
          fetchCells: (pid, fileId, jwt) => fetchAllFileCells(pid, fileId, jwt),
          fetchAudio: (pid, fileId, jwt) => fetchFileAudioAttachments(pid, fileId, jwt),
          fetchLinks: (pid, fileId, jwt) => fetchFileCellLinks(pid, fileId, jwt),
          onProgress: (d, t, name) =>
            setStatus({ kind: "busy", msg: `Reading ${name} (${d}/${t})…` }),
        })
        if (run.data.files.length === 0) {
          setStatus({
            kind: "error",
            msg: `None of the ${files.length} files could be read: ${run.unreadable[0]?.reason ?? "unknown reason"}.`,
          })
          return
        }
        const html = renderProjectReport(run.data)
        const reportName = buildExportStem(true)
        downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), `${reportName}.html`)
        setStatus({
          kind: "ok",
          msg: run.unreadable.length
            ? `Reported ${run.data.files.length} files — ${run.unreadable.length} could not be read.`
            : `Reported ${run.data.files.length} ${run.data.files.length === 1 ? "file" : "files"}`,
        })
      } else if (fmt === "sdbh-xml") {
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
        if (projectCellsError) {
          setStatus({ kind: "error", msg: `Couldn't load the complete project: ${projectCellsError.message}` })
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
      } else if (runScope === "project") {
        // Client-side project-scope zip: use already-loaded per-file cells.
        if (projectCellsLoading) {
          setStatus({ kind: "busy", msg: "Still loading file cells, please wait…" })
          return
        }
        if (projectCellsError) {
          setStatus({ kind: "error", msg: `Couldn't load the complete project: ${projectCellsError.message}` })
          return
        }
        // AQU-441: metadata-csv project scope — flatten all file cells into one sheet.
        if (fmt === "metadata-csv") {
          const allCells = projectFileCells.flatMap((f) => f.cells)
          const csvBlob = exportMetadataCsv(allCells, ttsSettings)
          const safeName = buildExportStem(true)
          downloadBlob(csvBlob, `${safeName}.csv`)
          setStatus({ kind: "ok", msg: `Downloaded ${safeName}.csv (${allCells.length} rows)` })
          return
        }
        setStatus({ kind: "busy", msg: `Building zip for ${projectFileCells.length} files…` })
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
        setStatus({ kind: "ok", msg: `Downloaded ${projectFileCells.length} files` })
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
            blob = exportVtt(filteredCells, ttsSettings, {
              cueSplitting: vttCueSplitting,
              excludeLabels: vttExcludeLabels,
              includeSource: vttIncludeSource,
            })
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
        setStatus({ kind: "ok", msg: `Downloaded ${baseName}${ext}` })
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
      const msg = (e as Error).message || "Export failed."
      setStatus({ kind: "error", msg })
      // Never leave a spinning toast behind: this catch covers the whole run,
      // including the long audio export, and an orphaned loading toast sits
      // there claiming work is still happening.
      if (exportToastRef.current != null) {
        toast.error(msg, { id: exportToastRef.current })
        exportToastRef.current = null
      }
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

  /**
   * The three shapes a subtitle file can take. Rendered in two places — on the
   * featured card for a dubbing file, in the fold for anything else that is
   * merely converting to VTT — so they are written once here rather than
   * duplicated and left to drift.
   */
  const renderVttOptions = () => (
          <div className="flex flex-col gap-1.5">
            <p className="font-medium text-muted-foreground text-[10px]">Subtitle file</p>
            <label className="flex items-start gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <Checkbox
                className="mt-0.5"
                checked={vttCueSplitting}
                onCheckedChange={(c) => setVttCueSplitting(c === true)}
              />
              <span>
                Split overlapping cues
                <span className="block text-[10px] text-muted-foreground">
                  Where two characters speak at once, both lines share one cue instead of
                  overlapping — the shape some subtitle tools require.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <Checkbox
                className="mt-0.5"
                checked={vttIncludeSource}
                onCheckedChange={(c) => setVttIncludeSource(c === true)}
              />
              <span>
                Include the source text
                <span className="block text-[10px] text-muted-foreground">
                  Each cue carries the original line above the translation — for playing against
                  the film and checking the two line by line.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <Checkbox
                className="mt-0.5"
                checked={vttExcludeLabels}
                onCheckedChange={(c) => setVttExcludeLabels(c === true)}
              />
              <span>
                Leave out character names
                <span className="block text-[10px] text-muted-foreground">
                  For a tool that would show the speaker tags as literal text.
                </span>
              </span>
            </label>
          </div>
  )

  /**
   * Who is recorded and who is not. Lives beside whichever control is about to
   * export audio: inside the Audio card for a dubbing file, under the format
   * list everywhere else.
   */
  const renderCharacterPreview = () => {
          const preview = audioPreview
          // WHO IS MISSING, not just who is included (codex-editor's lesson,
          // 2026-08-18). The list used to describe only what would be written,
          // so a character with nothing recorded simply was not in it — you
          // found out by opening the zip and noticing an absence.
          const recorded = preview.filter((p) => p.clipCount > 0)
          const unrecorded = preview.filter((p) => p.clipCount === 0)
          const untimedTotal = preview.reduce((n, p) => n + p.untimedCount, 0)
          return (
          <div className="flex flex-col gap-1 text-xs">
            <p className="font-medium text-muted-foreground text-[10px]">Preview</p>
            {preview.length === 0 ? (
              <p className="text-muted-foreground">No characters found in this file.</p>
            ) : (
              <>
                {/* Only the characters that will actually produce a file. An
                    episode has dozens of one-line parts nobody has recorded
                    yet, and listing them all buried the ones that matter
                    (Sam, 2026-08-18: "the preview is a little bit messy"). */}
                {recorded.map((p) => (
                  <div key={p.key} className="flex items-center gap-2">
                    {p.color && (
                      <span
                        className="h-2 w-2 rounded-full shrink-0"
                        style={{ backgroundColor: p.color }}
                        aria-hidden="true"
                      />
                    )}
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted-foreground">
                      {p.clipCount} {p.clipCount === 1 ? "line" : "lines"}
                      {p.totalDurationMs != null && (
                        <> · {Math.floor(p.totalDurationMs / 60000)}:{String(Math.floor((p.totalDurationMs % 60000) / 1000)).padStart(2, "0")}</>
                      )}
                      {p.missingCount > 0 && <> · {p.missingCount} still to record</>}
                      {p.untimedCount > 0 && <> · {p.untimedCount} untimed</>}
                    </span>
                  </div>
                ))}
                {recorded.length === 0 && (
                  <p className="text-muted-foreground">
                    Nothing is recorded yet, so there is nothing to export.
                  </p>
                )}
                {/* The rest, folded away — still countable at a glance, still
                    openable when you want to know WHO is outstanding. */}
                {unrecorded.length > 0 && (
                  <details className="group/unrec" data-testid="export-unrecorded">
                    <summary className="cursor-pointer list-none text-muted-foreground hover:text-foreground transition-colors">
                      <span className="inline-flex items-center gap-1">
                        <ChevronRight className="h-3 w-3 transition-transform group-open/unrec:rotate-90" aria-hidden="true" />
                        {unrecorded.length} {unrecorded.length === 1 ? "character" : "characters"} with
                        nothing recorded yet
                      </span>
                    </summary>
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5 pl-4 pt-1 text-muted-foreground">
                      {unrecorded.map((p) => (
                        <span key={p.key}>
                          {p.name}
                          <span className="text-[10px]"> ({p.missingCount})</span>
                        </span>
                      ))}
                    </div>
                  </details>
                )}
                {untimedTotal > 0 && (
                  <p className="text-muted-foreground">
                    {untimedTotal} {untimedTotal === 1 ? "recording has" : "recordings have"} no timing
                    and cannot be placed.
                  </p>
                )}
              </>
            )}
          </div>
          )
  }

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
        {!canExport ? (
          /* Permission gate (AQU-253 revised): explain the block instead of
             hiding it, and point at the roles & permissions docs. */
          <div
            role="note"
            aria-label="Export permission required"
            className="flex flex-col gap-2 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 px-3 py-3 text-sm text-amber-700 dark:text-amber-300"
          >
            <span className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              You don't have export permission
            </span>
            <p className="text-xs leading-relaxed">
              An organization owner has restricted exporting to higher roles.
              Ask an owner to raise your role, or read how roles and permissions
              work.
            </p>
            <a
              href="https://help.aquilla.app/permissions"
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium underline underline-offset-2 hover:opacity-80"
            >
              Roles &amp; permissions — help.aquilla.app
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
            aria-label="Validation flags do not block export"
            data-testid="export-nonblocking-health-note"
            className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground"
          >
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            <span>
              This file has {outstandingInfractionCount} outstanding validation{" "}
              {outstandingInfractionCount === 1 ? "flag" : "flags"} (terminology, HTML/markup,
              punctuation, etc.). These <strong>won't block your export</strong> — download now
              and resolve them anytime.
            </span>
          </div>
        )}
        {/* ── What this file is FOR (dubbing files, Sam 2026-08-19) ────────
             Two cards, in the order the work happens: the audio somebody
             records, then the subtitles they record against. The old featured
             area asked only "what format was this imported as?", which gave a
             dubbing episode the same top billing for VTT that a Bible project
             gives USFM — while the exports this workflow actually delivers sat
             in the fold beside TMX. */}
        {/* Deliberately NOT gated on `effectiveScope`: that follows whatever
             format is selected down in the fold, and these two cards are about
             the FILE, not about the fold's current selection. Picking a
             project-scoped TSV below must not make the episode's own
             deliverables disappear from the top of the dialog. */}
        {isDubbingFile && (
          <div className="flex flex-col gap-2.5">
            <div
              data-testid="export-audio-card"
              className="flex flex-col gap-2.5 rounded-xl border border-border/60 bg-accent/30 px-3 py-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-medium">Audio</p>
                <span className="text-xs text-muted-foreground font-mono">.zip</span>
              </div>
              <RadioGroup
                value={audioMode}
                onValueChange={(v) => setAudioMode(v as typeof audioMode)}
                className="flex flex-col gap-0.5"
                aria-label="Audio export shape"
              >
                {([
                  {
                    id: "audio-by-character" as const,
                    label: "By character",
                    hint: "One track per character, every take at its own place on the timeline. All the tracks start at 0:00, so they drop onto a DAW already lined up with each other and with the film. For mixing.",
                  },
                  {
                    id: "audio-by-line" as const,
                    label: "By line",
                    hint: "One file per recording, numbered in playing order, each carrying a timestamp a DAW can place it from — plus a manifest listing them all. For reviewing and re-recording individual lines.",
                  },
                ]).map((mode) => (
                  <label
                    key={mode.id}
                    className={
                      "flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors " +
                      (audioMode === mode.id ? "bg-background/70" : "hover:bg-accent/40")
                    }
                  >
                    <RadioGroupItem value={mode.id} className="mt-0.5 shrink-0" aria-label={mode.label} />
                    <span className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm font-medium leading-tight">{mode.label}</span>
                      <span className="text-xs text-muted-foreground leading-relaxed">{mode.hint}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
              {/* The preview belongs WITH the button that acts on it. */}
              {renderCharacterPreview()}
              <Button
                size="lg"
                className="w-full justify-center"
                onClick={() => handleExport(audioMode)}
                // Nothing recorded means nothing to write. Better to say so on a
                // dead button than to hand someone a refusal after they press it.
                disabled={!activeFileId || isBusy || recordedLines === 0}
                aria-busy={isBusy}
              >
                {isBusy ? <Spinner aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
                Export audio
              </Button>
            </div>

            {nativeOption && (
              <div
                data-testid="export-subtitle-card"
                className="flex flex-col gap-2.5 rounded-xl border border-border/60 bg-accent/30 px-3 py-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">Subtitles</p>
                  <span className="text-xs text-muted-foreground font-mono">{nativeOption.ext}</span>
                </div>
                {nativeOption.id === "vtt" && renderVttOptions()}
                <Button
                  size="lg"
                  className="w-full justify-center"
                  onClick={() => handleExport(nativeOption.id)}
                  disabled={!activeFileId || isBusy}
                  aria-busy={isBusy}
                >
                  {isBusy ? <Spinner aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
                  Download {buildExportStem(false)}{nativeOption.ext}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Primary action: download the file back in its own format. */}
        {!isDubbingFile && nativeOption && (
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
              Download {buildExportStem(false)}{nativeOption.ext}
            </Button>
            <p className="text-xs text-muted-foreground text-center leading-relaxed">
              {nativeOption.label} — your file in its original format, with
              current translations.
              {nativeOption.lossy && " Some inline formatting may not carry over."}
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
            Export to another format
          </summary>
          <div className="mt-2.5 flex flex-col gap-4">
        {/* Format selector */}
        <fieldset className="flex flex-col gap-1.5 min-w-0">
          <legend className="text-xs font-medium text-muted-foreground mb-1.5">
            Format
          </legend>
          <RadioGroup
            value={format}
            onValueChange={(value) => setFormat(value as ExportFormat)}
            className="flex flex-col gap-0.5"
            aria-label="Export format"
          >
            {foldFormats.map((f) => (
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
                  aria-label={`${f.label} (${f.ext})`}
                />
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-medium leading-tight flex items-baseline gap-1.5 flex-wrap">
                    {f.label}
                    <span className="text-xs text-muted-foreground font-normal font-mono">{f.ext}</span>
                    {f.lossy && (
                      <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">
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
          <legend className="text-xs font-medium text-muted-foreground mb-1.5">
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
              <Button variant="outline" size="sm" nativeButton={false} render={<label className="self-start" />}>
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
        </fieldset>

        {/* AQU-439: Voice filter — only shown when cells have cast assignments */}
        {distinctVoices.length > 0 && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs font-medium text-muted-foreground mb-1.5">
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
          <legend className="text-xs font-medium text-muted-foreground mb-1.5">
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
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                <Checkbox
                  checked={appendTimestamp}
                  onCheckedChange={(c) => setAppendTimestamp(c === true)}
                />
                Append timestamp
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                <Checkbox
                  checked={appendLangTag}
                  onCheckedChange={(c) => setAppendLangTag(c === true)}
                />
                Append language tag
              </label>
            </div>
          </div>
        </fieldset>

        {/* Subtitle shape options — on the card for a dubbing file. */}
        {!isDubbingFile && format === "vtt" && renderVttOptions()}

        {/* Who is recorded — on the card for a dubbing file. */}
        {!isDubbingFile && (format === "audio-by-character" || format === "audio-by-line")
          && effectiveScope === "file" && renderCharacterPreview()}

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
                "flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors " +
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
                  <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">
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
                  <label className="flex items-center gap-1.5 mt-1">
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
                "flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors " +
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
                    Download original unchanged
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
                    Repair by re-importing
                  </Button>
                </span>
              )}
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
        </>
        )}
        </DialogBody>

        <DialogFooter>
          {!canExport ? (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Close
            </Button>
          ) : (
            <>
              <Button
                variant={isDone ? "default" : "outline"}
                onClick={() => handleOpenChange(false)}
                disabled={isBusy}
              >
                {isDone ? "Done" : "Cancel"}
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
                {isBusy ? "Exporting…" : isDone ? "Export again" : "Export"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
