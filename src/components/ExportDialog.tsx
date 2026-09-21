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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SegmentTabs } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import { downloadBlob } from "@/lib/export/export-service"
import { collectInlineStyleWarnings, type ExportFidelityWarning } from "@/lib/export/fidelity"
import { chapterFilenameSuffix, filterCellsByChapter, listChapterLabels } from "@/lib/export/chapter-scope"
import {
  DEFAULT_EXPORT_CONTENT_MODE,
  scopeCellsForExport,
  scopeRoundTripCells,
  validatedOnly as isValidatedOnlyMode,
  type ExportContentMode,
} from "@/lib/export/validation-scope"
import { downloadSourceFile, downloadProjectZip, fetchSourceSidecar, fetchRemovedCells } from "@/lib/sync/source-export"
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
import { toast } from "@/components/ui/toast"

import { previewAudioByCharacter } from "@/lib/export/audio-by-character"
import { exportMetadataCsv } from "@/lib/export/exporters/metadata-csv"
import { injectSdbhXml } from "@/lib/parsers/sdbh"
import { useProjectCells } from "@/hooks/useProjectCells"
import {
  hasExportMemory,
  readExportMemory,
  writeExportMemory,
  type ExportSection,
  type SubtitleTarget,
} from "@/lib/export/export-dialog-memory"
import type { CellData } from "@/hooks/useCells"
import { isDefaultTrackSlot } from "@/lib/timeline/track-slots"
import type { TimelineTrack } from "@/lib/timeline/tracks"
import { isSubtitleImportFile } from "@/lib/parsers/types"
import type { CharacterResolution, ProjectTtsSettings } from "@/lib/parsers/types"
import posthog from "@/lib/posthog"
import {
  CURRENT_IDML_FORMAT_COPY,
  idmlFormatCopy,
  idmlOrgEligible,
} from "@/lib/idml/release-gate"
import { idmlTelemetryProperties } from "@/lib/idml/telemetry"
import { hasPackageLocators } from "@/lib/export/import-locators"

export type ExportFormat = "usfm" | "txt" | "md" | "tsv" | "csv" | "xlf" | "tmx" | "vtt" | "srt" | "audio-by-character" | "audio-by-line" | "character-sheets" | "project-report" | "docx" | "pptx" | "idml" | "plain-text-dump" | "metadata-csv" | "sdbh-xml"
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
  {
    id: "character-sheets",
    labelKey: "importExport.format.characterSheets.label",
    ext: ".xlsx",
    descriptionKey: "importExport.format.characterSheets.description",
    lossy: false,
  },
  {
    id: "project-report",
    labelKey: "importExport.format.projectReport.label",
    ext: ".html",
    descriptionKey: "importExport.format.projectReport.description",
    lossy: false,
  },
  {
    id: "audio-by-line",
    labelKey: "importExport.format.audioByLine.label",
    ext: ".zip",
    descriptionKey: "importExport.format.audioByLine.description",
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
  /**
   * AQU-646 stage 4: the file's timeline tracks.
   *
   * Two jobs. The per-line export enumerates them to write a folder each; and
   * their mere EXISTENCE decides whether the by-character option carries its
   * "these are not included" notice — Sam's rule is about tracks having been
   * added, not about whether anybody has recorded onto them yet.
   */
  timelineTracks?: readonly TimelineTrack[]
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
  /** What has been settled in the character check drawer. The project report
   *  reads these; the corrected sheets no longer need them — a resolution has
   *  already written its winner onto the cells themselves. */
  characterResolutions?: Record<string, CharacterResolution>
  /**
   * The audio-cue sibling's file name, when this file has one.
   *
   * Its ABSENCE is the load-bearing part. `audioCells` falls back to the
   * active file's own cells when there is no sibling, so an "audio VTT" choice
   * offered without checking this would silently re-export the subtitles under
   * a different name. Presence is what says the two files are really two.
   */
  audioSiblingName?: string | null
  /**
   * Who is looking. The dialog remembers its last selection per project AND
   * per user (Sam, 2026-08-20), so two people sharing a machine do not
   * inherit each other's last click.
   */
  currentUsername?: string
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
  timelineTracks,
  projectId,
  projectName,
  activeFileId,
  activeFileName,
  activeFileType = null,
  projectFiles,
  reportFiles,
  characterResolutions,
  audioSiblingName,
  currentUsername = "local",
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

  /**
   * AQU-1068 (2026-09-09): what a native round-trip export does with content
   * added or removed in the app, in this file, in plain words.
   *
   * Sam reversed August's decision: an added cell is ALWAYS content the client's
   * file is missing, so USFM, Word and PowerPoint now carry it. This replaced a
   * WARNING that said the opposite — and that warning was wrong twice over, so
   * the scoping below is part of the fix rather than cosmetic:
   *
   *   - It fired for every type in NATIVE_EXPORT_BY_FILE_TYPE, which includes
   *     md, txt, xliff, tmx, csv and tsv. Those render from scratch and have
   *     always included added lines (exporters/added-lines.test.ts pins it), so
   *     the warning was false on six of the ten types it reached.
   *   - InDesign cannot take an added or removed cell AT ALL — the editor
   *     refuses the actions on every IDML row — so "won't be included" described
   *     a situation that cannot arise.
   *
   * Null means say nothing: either the file has no added or removed content, or
   * the format re-renders and simply carries everything.
   */
  const structuralNote = useMemo(() => {
    if (!nativeFormatId) return null
    // Word and PowerPoint place content by a per-paragraph locator recorded at
    // import. A file imported before that existed is matched BY POSITION, where
    // an inserted or dropped paragraph shifts every later one onto the wrong
    // text — so those files carry neither, and should say so.
    if (nativeFormatId === "docx" || nativeFormatId === "pptx") {
      if (!hasPackageLocators(cells)) return "importExport.dialog.structuralNoteLegacy" as const
      return nativeFormatId === "docx"
        ? ("importExport.dialog.structuralNoteDocx" as const)
        : ("importExport.dialog.structuralNotePptx" as const)
    }
    if (nativeFormatId === "usfm") return "importExport.dialog.structuralNoteUsfm" as const
    // IDML, and sdbh-xml, which addresses by LEXID and has the same problem.
    if (nativeFormatId === "idml" || nativeFormatId === "sdbh-xml") {
      return "importExport.dialog.structuralNoteUnplaceable" as const
    }
    return null
  }, [nativeFormatId, cells])

  const [format, setFormat] = useState<ExportFormat>(nativeFormatId ?? "tsv")
  const [scope, setScope] = useState<ExportScope>("file")
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // "Export to another format" section — collapsed when the primary download
  // covers the common case, open when there is no native format to offer.
  // Only used on NON-dubbing files; a dubbing file's three sections share
  // `openSection` below.
  const [formatsOpen, setFormatsOpen] = useState(nativeFormatId == null)

  /**
   * Which of a dubbing file's three sections is open — and, because they share
   * ONE piece of state, the whole of the accordion behaviour. Opening any
   * section is the same act as closing the other two (Sam, 2026-08-20).
   *
   * Null is all-collapsed, which is what a first-ever open looks like.
   */
  const [openSection, setOpenSection] = useState<ExportSection | null>(null)
  /** Which file the subtitle section exports: this one, or the audio cues that
   *  were imported beside it. */
  const [subtitleTarget, setSubtitleTarget] = useState<SubtitleTarget>("subtitle")

  // The restore effect below writes all four of these, so they are declared
  // ahead of it — a setter used above its own `useState` is stale by the time it
  // fires (react-hooks/immutability).
  //
  // Two shapes of subtitle file codex-editor offers as separate formats
  // (2026-08-18). Both default off: the file this produces untouched is the
  // one it has always produced.
  const [vttCueSplitting, setVttCueSplitting] = useState(false)
  const [vttExcludeLabels, setVttExcludeLabels] = useState(false)
  /** Source above target in every cue — a review artifact, played against the
   *  picture to check the translation line by line. */
  const [vttIncludeSource, setVttIncludeSource] = useState(false)
  /** Which of the two audio deliverables the Audio card will produce. They are
   *  two forms of one thing — a mix track and a review folder — so they share a
   *  card and a button rather than competing as two entries in a list. */
  const [audioMode, setAudioMode] = useState<"audio-by-character" | "audio-by-line">("audio-by-character")

  // Re-derive defaults when the dialog opens on a (possibly different) file.
  //
  // Seeded FALSE rather than with `open`, so a dialog that mounts already open
  // counts as having just opened. Seeded with `open` it would skip its own
  // first opening entirely — invisible today, because the workspace keeps this
  // mounted from the start and merely toggles the prop, but it would silently
  // disable both the format reset and the remembered selection the moment
  // anyone wrapped it in `{isOpen && …}`.
  const prevOpenRef = useRef(false)
  /** Set once this opening has restored, so the save effect below cannot run
   *  before it. See there for what goes wrong without it. */
  const isDubbingFile = isSubtitleImportFile({ type: activeFileType })
  const restoredRef = useRef(false)
  useEffect(() => {
    if (!open) restoredRef.current = false
    if (open && !prevOpenRef.current) {
      setFormat(nativeFormatId ?? "tsv")
      setFormatsOpen(nativeFormatId == null)
      // WHAT THIS USER LAST DID IN THIS PROJECT. Restored on open rather than
      // on mount: the dialog stays mounted between openings, so mount-time
      // restoration would only ever run once per session and the second
      // opening would show stale state.
      const remembered = readExportMemory(currentUsername, projectId)
      // FIRST-EVER OPEN defaults the native-format section open, because the
      // primary "Download <name>.<ext>" button lives inside it and a dialog
      // showing nothing buried the one-click journey (caught by the
      // subtitle-voice-roundtrip e2e). This supersedes the earlier
      // "resting state is all-collapsed" rule for the first open ONLY — the
      // one-section-at-a-time rule and the per-user memory are untouched, and
      // a user who deliberately collapses everything is remembered as such,
      // which is why "no memory yet" and "remembered null" are distinguished.
      const firstEverOpen = !hasExportMemory(currentUsername, projectId)
      setOpenSection(
        firstEverOpen && isDubbingFile && nativeFormatId != null
          ? "subtitle"
          : remembered.section,
      )
      setAudioMode(remembered.audioMode)
      setSubtitleTarget(remembered.subtitleTarget)
      setVttCueSplitting(remembered.cueSplitting)
      setVttExcludeLabels(remembered.excludeLabels)
      setVttIncludeSource(remembered.includeSource)
      // The remembered format is checked against what is actually on offer —
      // ids come and go with the file type and the build, and selecting one
      // that is no longer listed would leave the radio group with no selection
      // and the Export button acting on a format nobody can see.
      if (
        remembered.foldFormat &&
        BASE_FORMAT_OPTIONS.some((f) => f.id === remembered.foldFormat)
      ) {
        setFormat(remembered.foldFormat as ExportFormat)
      }
      restoredRef.current = true
    }
    prevOpenRef.current = open
  }, [open, nativeFormatId, currentUsername, projectId, isDubbingFile])
  const [dumpIncludeRefs, setDumpIncludeRefs] = useState(false)

  // AQU-437: Filename control state. Default changes with scope/format.
  // The base name is editable; timestamp and language tag are optional suffixes.
  const defaultBaseName = (activeFileName ?? "export").replace(/\.[^.]+$/, "")
  const [customBaseName, setCustomBaseName] = useState<string>(defaultBaseName)
  const [appendTimestamp, setAppendTimestamp] = useState(false)
  const [appendLangTag, setAppendLangTag] = useState(false)
  /** The live export toast, so the catch-all below can turn a spinner that
   *  will never finish into the error it actually was. */
  const exportToastRef = useRef<string | null>(null)

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
        if (id != null && Boolean(c.attachments?.[id]?.url)) return true
        // AQU-646 stage 4: AN ADDED TRACK'S TAKE COUNTS AS AUDIO.
        //
        // Reading only the default row's two slots meant a file whose
        // recordings live entirely on an added track looked take-less, so the
        // audio card offered nothing at all — and "per-line carries the new
        // tracks" would have been a promise you could not reach.
        return Object.entries(c.selectedBySlot ?? {}).some(
          ([slot, audioId]) =>
            !isDefaultTrackSlot(slot) && Boolean(c.attachments?.[audioId]?.url),
        )
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
   * sibling". Every subtitle file in this client's world is an episode being
   * dubbed, and a rule someone can state in one sentence beats an inference
   * that is right more often but explicable less often.
   *
   * Through the SHARED helper rather than a local `vtt || srt`, which is what
   * this was until 2026-08-20 — and which missed `sbv`, the exact omission
   * `isSubtitleImportFile` was written to stop repeating. An sbv episode now
   * gets the same three sections as its neighbours.
   *
   * What it changes: the featured area stops asking "what IS this file?" and
   * starts asking "what is this file FOR?". A dubbing project's deliverables
   * are its audio and its subtitles — not a TSV — so those get the top of the
   * dialog and everything else keeps its place in the fold.
   */
  // (`isDubbingFile` is declared above the restore effect, which needs it.)

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
  /**
   * AQU-646 stage 4: takes living on ADDED tracks, which the preview above
   * cannot see.
   *
   * `previewAudioByCharacter` describes the by-character deliverable, and that
   * deliverable is deliberately default-track-only (Sam, 2026-08-26) — so the
   * preview stays exactly as it is. But the export BUTTON is shared by both
   * shapes, and gating it on the preview alone would leave it dead on a file
   * whose only recordings are on an added track, with a per-line export sitting
   * right there that would have written them.
   */
  const addedTrackTakes = useMemo(
    () =>
      audioSourceCells.reduce(
        (n, c) =>
          n +
          Object.entries(c.selectedBySlot ?? {}).filter(
            ([slot, audioId]) =>
              !isDefaultTrackSlot(slot) && Boolean(c.attachments?.[audioId]?.url),
          ).length,
        0,
      ),
    [audioSourceCells],
  )
  /**
   * Does this file carry tracks beyond the four derived ones?
   *
   * FOLDERS DO NOT COUNT, and that is Sam's own rule read back: "folders are
   * not tracks". A folder holds no takes, so warning that one will not be
   * exported would be noise about a thing that could never have been.
   */
  const hasAddedAudioTracks = useMemo(
    () => (timelineTracks ?? []).some((t) => t.kind === "audio"),
    [timelineTracks],
  )

  /**
   * OPEN ON A MODE THAT CAN ACTUALLY PRODUCE SOMETHING. (Sam, 2026-08-27)
   *
   * "By character" reads the default Target audio row only, deliberately — so
   * on a file whose takes all live on ADDED tracks it finds nothing, while the
   * Export button beside it is enabled (its gate is an OR across both counters,
   * blind to the mode) and refuses AFTER the press with "No recordings found in
   * this file". Untrue of a file that plainly has recordings, and the preview
   * beside it agreed with the lie.
   *
   * The same discipline `export-dialog-memory.ts` states for itself — validate
   * on read against the live thing, not against what was stored — applied to
   * the one field it cannot validate on its own, because only this component
   * knows what the file holds.
   *
   * A FALLBACK, NOT AN OVERRIDE. It waits until the counts mean something
   * (they are both zero while the cells are still arriving), fires at most once
   * per opening, and never touches a mode that works — so switching back to by
   * character afterwards stands.
   *
   * Its own effect rather than a line in the restore above, because a
   * dependency array is evaluated at RENDER: naming these counts up there,
   * where they are not yet declared, is a temporal-dead-zone crash.
   */
  const steeredModeRef = useRef(false)
  useEffect(() => {
    if (!open) {
      steeredModeRef.current = false
      return
    }
    if (steeredModeRef.current) return
    if (recordedLines === 0 && addedTrackTakes === 0) return
    steeredModeRef.current = true
    if (recordedLines === 0 && addedTrackTakes > 0) setAudioMode("audio-by-line")
  }, [open, recordedLines, addedTrackTakes])

  /**
   * Remember the selection, per project and per user.
   *
   * GUARDED ON THE RESTORE HAVING HAPPENED, not merely on `open`. Effects run
   * in declaration order within one commit, so on the opening render the
   * restore above only QUEUES its state updates — this would then run with the
   * previous opening's values still in state and write them straight back over
   * what was just read. The next render corrects it, so the end state was
   * right either way, but for one commit the stored memory held stale values,
   * and anything that read it in that window (a reload, another tab) got them.
   */
  useEffect(() => {
    if (!open || !restoredRef.current) return
    writeExportMemory(currentUsername, projectId, {
      section: openSection,
      audioMode,
      subtitleTarget,
      foldFormat: format,
      cueSplitting: vttCueSplitting,
      excludeLabels: vttExcludeLabels,
      includeSource: vttIncludeSource,
    })
  }, [
    open,
    currentUsername,
    projectId,
    openSection,
    audioMode,
    subtitleTarget,
    format,
    vttCueSplitting,
    vttExcludeLabels,
    vttIncludeSource,
  ])

  /**
   * Opening one section closes the others — the whole accordion, in one
   * function. `nowOpen` is what the browser has just done to a `<details>`.
   *
   * A CLOSE ONLY COUNTS FROM THE SECTION THAT IS ACTUALLY OPEN, and that
   * guard is the entire fix for a bug Sam hit on every single use
   * (2026-08-20): clicking a second section took two clicks, because the
   * first click appeared to do nothing but collapse the first section.
   *
   * One click fires TWO toggles. The browser opens the clicked section, this
   * records it — and then React closes the previously-open one by changing its
   * `open` prop, which makes the browser fire THAT section's toggle event too,
   * reporting `false`. Read naively, the second event says "a section was
   * closed" and resets everything to nothing-open, cancelling the section
   * that was just opened a microtask earlier. Ignoring a close from a section
   * we no longer consider open makes the echo harmless.
   *
   * Functional update rather than reading `openSection` directly, because
   * both events land before a re-render and the second would otherwise test
   * against a stale value.
   */
  const toggleSection = (id: ExportSection, nowOpen: boolean) =>
    setOpenSection((prev) => (nowOpen ? id : prev === id ? null : prev))

  /**
   * Does this file have a real audio-cue sibling to export?
   *
   * Both halves are needed. Without a NAME there is no second file and
   * `audioCells` is just this file's own cells wearing a different label;
   * without CELLS there is a sibling with nothing in it yet.
   */
  const hasAudioSibling = Boolean(audioSiblingName) && (audioCells?.length ?? 0) > 0
  /** What the subtitle section will actually export. Falls back to the
   *  subtitle rows whenever the audio choice is not available, so a remembered
   *  "audio" from a file that had a sibling cannot strand a file that has none. */
  const effectiveSubtitleTarget: SubtitleTarget =
    subtitleTarget === "audio" && hasAudioSibling ? "audio" : "subtitle"

  const fileOnlyFormats = ["audio-by-character", "audio-by-line", "character-sheets", "vtt", "docx", "pptx", "idml", "plain-text-dump"] as const
  const isFileOnlyFormat = fileOnlyFormats.includes(format as typeof fileOnlyFormats[number])
  // SDBH XML reinjection spans every lexicon file — inherently project scope.
  // The report describes a PROJECT: name consistency only means anything across
  // episodes, since MARY in one and MARY MAGDALENE in the next is invisible
  // inside either file.
  const isProjectOnlyFormat = format === "sdbh-xml" || format === "project-report"
  const effectiveScope: ExportScope = isProjectOnlyFormat ? "project" : isFileOnlyFormat ? "file" : scope

  /**
   * AQU-465: the formats a chapter can be sliced out of.
   *
   * Exactly the formats built from the in-memory cell array (the `filteredCells`
   * branch of handleExport). The round-trip formats are deliberately absent:
   * USFM/DOCX/PPTX/IDML reinject translations into the ORIGINAL document —
   * USFM server-side — so there is no cell array to filter, and handing back a
   * one-chapter .docx would mean rebuilding the document rather than exporting
   * it. Those stay whole-file.
   */
  const chapterScopeFormats = ["txt", "md", "tsv", "csv", "xlf", "tmx", "vtt", "srt", "plain-text-dump", "metadata-csv"] as const
  const supportsChapterScope = (fmt: ExportFormat): boolean =>
    (chapterScopeFormats as readonly string[]).includes(fmt)

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

  /**
   * AQU-1148: which cells may contribute a translation to this export.
   *
   * Deliberately NOT remembered across opens (unlike the format/scope prefs in
   * `export-dialog-memory`): "validated only" is a claim about the file leaving
   * the app, and a remembered one silently narrows a later export somebody else
   * is doing. Each export states its own mode.
   */
  const [contentMode, setContentMode] = useState<ExportContentMode>(DEFAULT_EXPORT_CONTENT_MODE)
  const validatedOnly = isValidatedOnlyMode(contentMode)

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

  // Same Base UI label rule as `chapterItems` below: without `items` the
  // "All voices" option ("") renders an empty trigger.
  const voiceItems = useMemo(
    () => [
      { value: "", label: t("importExport.dialog.allVoices") },
      ...distinctVoices.map((v) => ({ value: v, label: v })),
    ],
    [distinctVoices, t],
  )

  // Reset voice filter when dialog closes or cells change.
  // AQU-1148: the content mode resets with it — the dialog stays mounted
  // between opens, and a narrowed export must never be silently inherited.
  useEffect(() => {
    if (!open) {
      setVoiceFilter("")
      setContentMode(DEFAULT_EXPORT_CONTENT_MODE)
    }
  }, [open])

  /**
   * Apply the voice filter to a cell array.
   * When voiceFilter is empty, all cells are returned.
   */
  function applyVoiceFilter(cs: CellData[]): CellData[] {
    if (!voiceFilter) return cs
    return cs.filter((c) => getCellVoice(c) === voiceFilter)
  }

  // AQU-465: Chapter scope — the middle ground between "current file" and
  // "whole project". "" = every chapter, the same "no filter" contract the
  // voice filter uses.
  const [chapterFilter, setChapterFilter] = useState<string>("")

  const contentModeItems = useMemo(
    () => [
      { value: "current", label: t("importExport.dialog.contentModeCurrent") },
      { value: "validated-only", label: t("importExport.dialog.contentModeValidatedOnly") },
    ],
    [t],
  )

  /** The formats that write into the client's own uploaded package rather than
   *  building a file from the cells — they cannot omit a cell, so validated-only
   *  leaves the original words in place and the hint has to say so. */
  const isRoundTripFormat = format === "usfm" || format === "docx" || format === "pptx" || format === "idml"

  const validatedCellCount = useMemo(
    () => cells.filter((c) => c.status === "validated").length,
    [cells],
  )

  const chapterLabels = useMemo(() => listChapterLabels(cells), [cells])

  // Base UI resolves the trigger's label from the root's `items`, not from
  // the mounted <SelectItem>s, and falls back to the raw value string when
  // there are none. "GEN 2" is its own label so it looked fine; "" — the
  // "All chapters" option — rendered an empty trigger.
  const chapterItems = useMemo(
    () => [
      { value: "", label: t("importExport.dialog.allChapters") },
      ...chapterLabels.map((c) => ({ value: c, label: c })),
    ],
    [chapterLabels, t],
  )

  /** Only offered where it means something: a file with more than one chapter,
   *  exporting itself (not the project) through a cell-array format. */
  const canScopeToChapter =
    effectiveScope === "file" && supportsChapterScope(format) && chapterLabels.length > 1
  const activeChapter = canScopeToChapter ? chapterFilter : ""

  // Drop the chapter on close, on a file switch, and whenever the remembered
  // label is not in the current file. WITHOUT THE LAST CLAUSE a "GEN 3" left
  // over from the previous file would filter every cell away and export an
  // empty document — the same trap the format-reset effect above guards.
  useEffect(() => {
    if (!open) setChapterFilter("")
  }, [open])
  useEffect(() => {
    setChapterFilter("")
  }, [activeFileId])
  useEffect(() => {
    if (chapterFilter && !chapterLabels.includes(chapterFilter)) setChapterFilter("")
  }, [chapterFilter, chapterLabels])

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

  async function handleExport(
    overrideFormat?: ExportFormat,
    opts?: {
      /**
       * Export the AUDIO CUES through the chosen subtitle exporter instead of
       * this file's own rows — the "Audio VTT" choice. The cues are a real
       * second file (see `audioSiblingName`), timed to the same film, carrying
       * the words as they were heard rather than as they were translated.
       */
       audioCues?: boolean
    },
  ) {
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
            // AQU-1148: only validated translations are overlaid server-side.
            validatedOnly,
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
          const result = await downloadSourceFile({ projectId, fileId: activeFileId, downloadName, getToken, targetLang, validatedOnly })
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
        // AQU-1068: what this file LOST. Without it a removed paragraph is
        // indistinguishable from an untranslated one, and the exporter keeps
        // the client's original words for a line somebody deliberately took
        // out. Fails soft to an empty list — never blocks the download.
        const removedCells = await fetchRemovedCells({ projectId, fileId: activeFileId, getToken })
        // AQU-1148: a non-validated cell keeps its place (the package is located
        // through it) but carries no translation, so the exporter leaves that
        // paragraph's original words alone — as it already does when untranslated.
        const result = await exportDocx(rawBytes, scopeRoundTripCells(cells, contentMode), { removedCells })
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
        // See the docx branch above.
        const removedCells = await fetchRemovedCells({ projectId, fileId: activeFileId, getToken })
        // AQU-1148: see the docx branch above.
        const result = await exportPptx(rawBytes, scopeRoundTripCells(cells, contentMode), { removedCells })
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
        // AQU-1148: see the docx branch above.
        const result = await exportIdml(rawBytes, scopeRoundTripCells(cells, contentMode))
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
        // A TOAST, not just the dialog's own line (Sam, 2026-08-18). This is
        // the one export that takes real time — every take is fetched, decoded
        // and laid onto a track — and the dialog's status is only visible while
        // the dialog is. The toast means you can close it and get on with
        // something else, and still be told when the zip is ready.
        exportToastRef.current = toast.add({
          type: "loading",
          timeout: 0,
          title: t("importExport.status.preparingCharacterExport"),
        })
        setStatus({ kind: "busy", msg: t("importExport.status.decodingAudio") })
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
          onProgress: (d, tot) => {
            setStatus({ kind: "busy", msg: t("importExport.status.decodingCount", { done: d, total: tot }) })
            // Throttled to whole percentage points: an episode has hundreds of
            // takes, and re-rendering the toast for each one buys nothing a
            // person can read.
            const pct = tot > 0 ? Math.floor((d / tot) * 100) : 0
            if (pct === lastPct && d < tot) return
            lastPct = pct
            const running = exportToastRef.current
            if (running != null) {
              toast.update(running, {
                type: "loading",
                timeout: 0,
                title:
                  d < tot
                    ? t("importExport.status.decodingPercent", { pct })
                    : // Everything is decoded; what is left is rendering the
                      // last character's track and compressing, which on a
                      // long episode is where the wait actually goes.
                      t("importExport.status.buildingArchive"),
              })
            }
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
          if (exportToastRef.current != null) {
            toast.update(exportToastRef.current, { type: "error", title: msg })
          } else {
            toast.add({ type: "error", title: msg })
          }
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
        if (exportToastRef.current != null) {
          toast.update(exportToastRef.current, { type: "success", title: doneMsg })
        } else {
          toast.add({ type: "success", title: doneMsg })
        }
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
          // AQU-646 stage 4: per line is the deliverable that carries every
          // track (Sam, 2026-08-26). Absent, or with only the derived rows, it
          // writes the flat classic zip exactly as before.
          tracks: timelineTracks,
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
        // 2026-08-27: a trim is applied on the way out, so the file holds what
        // the line sounds like. That is a byte-range cut on a PCM WAV and
        // needs no decoder — but a webm or mp3 take cannot be cut that way, so
        // it goes out whole. Said out loud, because a file longer than its
        // line is not something anyone notices until the mix.
        if (result.untrimmed > 0) {
          lineNotes.push(
            `${result.untrimmed} ${result.untrimmed === 1 ? "is" : "are"} not a WAV, so ${result.untrimmed === 1 ? "its trim" : "their trims"} could not be applied`,
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
        if ((audioCells?.length ?? 0) === 0) {
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
        // The unreadable files go INTO the document, not only into the status
        // line below — that line is gone the moment the dialog closes, and a
        // report that silently omits an episode reads as a clean bill for it.
        const html = renderProjectReport({ ...run.data, unreadable: run.unreadable })
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
          const allCells = scopeCellsForExport(projectFileCells.flatMap((f) => f.cells), contentMode)
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
          // AQU-1148: each file's cells are narrowed by the same rule the
          // single-file path uses, before any exporter sees them.
          files: projectFileCells.map((f) => ({ ...f, cells: scopeCellsForExport(f.cells, contentMode) })),
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
        //
        // THE VOICE FILTER IS NOT APPLIED TO THE CUES. It keeps only cells
        // whose `metadata.cast_name` matches, and a cue carries one only when
        // the AUDIO character sheet was imported — so filtering here would
        // silently hand back an empty file on every project that imported only
        // the subtitle sheet.
        //
        // AQU-465: the chapter narrows the same array, after the voice. It is
        // NOT applied to the cues (they are the sibling's rows, filtered above
        // for the same reason the voice filter skips them) and not to the
        // primary "Download <file>" action — that one means "give me my file
        // back", whole, whatever chapter the fold happens to be showing.
        const chapter = overrideFormat || opts?.audioCues ? "" : activeChapter
        // AQU-1148: the content mode narrows LAST, and by OMISSION — a
        // non-validated cell never reaches the exporters' `translated ||
        // effectiveSourceText(cell)` fallback, so it cannot come back as
        // source-language filler in a validated-only file. Not applied to the
        // audio cues: cue text is the recording's own script, and audio
        // validation is a separate flag (AQU-508 / AQU-965).
        const filteredCells = opts?.audioCues
          ? (audioCells ?? [])
          : scopeCellsForExport([...filterCellsByChapter(applyVoiceFilter(cells), chapter)], contentMode)
        let blob: Blob
        // `_audio` rather than the sibling's own name (`<file> · audio cues`),
        // which carries a space and a middle dot and would need sanitising
        // into something unrecognisable anyway. This matches the audio zips'
        // suffixes, so all four of this file's audio deliverables sort together.
        const baseName = buildExportStem(false)
          + chapterFilenameSuffix(chapter)
          + (opts?.audioCues ? "_audio" : "")
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
              // Meaningless on the cues — they have no translation to sit
              // under a source line — and the section hides the checkbox
              // there, so it must not be honoured behind the UI's back either.
              includeSource: opts?.audioCues ? false : vttIncludeSource,
              // WITHOUT THIS THE AUDIO VTT COMES OUT COMPLETELY BARE. Voice
              // tags otherwise read `settings.castAssignments`, which a cue
              // only appears in when the AUDIO character sheet was imported —
              // while the app shows names on every cue by resolving them
              // across the cue↔text links. Same resolver the audio zips use.
              ...(opts?.audioCues && resolveCharacterName
                ? { resolveName: resolveCharacterName }
                : {}),
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
      const msg = (e as Error).message || t("importExport.status.exportFailed")
      setStatus({ kind: "error", msg })
      // Never leave a spinning toast behind: this catch covers the whole run,
      // including the long audio export, and an orphaned loading toast sits
      // there claiming work is still happening.
      if (exportToastRef.current != null) {
        toast.update(exportToastRef.current, { type: "error", title: msg })
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
  const renderVttOptions = (opts?: { showSource?: boolean }) => (
          <div className="flex flex-col gap-1.5">
            <p className="font-medium text-muted-foreground text-[10px]">{t("importExport.dialog.subtitleFileHeading")}</p>
            <label className="flex items-start gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <Checkbox
                className="mt-0.5"
                checked={vttCueSplitting}
                onCheckedChange={(c) => setVttCueSplitting(c === true)}
              />
              <span>
                {t("importExport.dialog.vttSplitCues")}
                <span className="block text-[10px] text-muted-foreground">
                  {t("importExport.dialog.vttSplitCuesHint")}
                </span>
              </span>
            </label>
            {/* HIDDEN when the export is the audio cues. A cue holds only the
                words as they were heard — there is no separate translation for
                a source line to sit above — so the checkbox would visibly do
                nothing, which reads as broken (Sam, 2026-08-20). */}
            {opts?.showSource !== false && (
              <label className="flex items-start gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                <Checkbox
                  className="mt-0.5"
                  checked={vttIncludeSource}
                  onCheckedChange={(c) => setVttIncludeSource(c === true)}
                />
                <span>
                  {t("importExport.dialog.vttIncludeSource")}
                  <span className="block text-[10px] text-muted-foreground">
                    {t("importExport.dialog.vttIncludeSourceHint")}
                  </span>
                </span>
              </label>
            )}
            <label className="flex items-start gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <Checkbox
                className="mt-0.5"
                checked={vttExcludeLabels}
                onCheckedChange={(c) => setVttExcludeLabels(c === true)}
              />
              <span>
                {t("importExport.dialog.vttExcludeLabels")}
                <span className="block text-[10px] text-muted-foreground">
                  {t("importExport.dialog.vttExcludeLabelsHint")}
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
            <p className="font-medium text-muted-foreground text-[10px]">{t("importExport.dialog.characterPreviewHeading")}</p>
            {preview.length === 0 ? (
              <p className="text-muted-foreground">{t("importExport.dialog.noCharactersInFile")}</p>
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
                      {t("importExport.dialog.characterLineCount", { count: p.clipCount })}
                      {p.totalDurationMs != null && (
                        <> · {Math.floor(p.totalDurationMs / 60000)}:{String(Math.floor((p.totalDurationMs % 60000) / 1000)).padStart(2, "0")}</>
                      )}
                      {p.missingCount > 0 && <> · {t("importExport.dialog.stillToRecordCount", { count: p.missingCount })}</>}
                      {p.untimedCount > 0 && <> · {t("importExport.dialog.untimedClipCount", { count: p.untimedCount })}</>}
                    </span>
                  </div>
                ))}
                {/* This preview describes the BY-CHARACTER deliverable, which
                    reads the default row only — so on a file whose takes live
                    on added tracks "nothing is recorded" is false, and sat one
                    line away from a button that had just refused for the same
                    reason (2026-08-27). Say what is actually true. */}
                {recorded.length === 0 && (
                  <p className="text-muted-foreground">
                    {addedTrackTakes > 0
                      ? t("importExport.dialog.nothingOnMainTrack", { count: addedTrackTakes })
                      : t("importExport.dialog.nothingRecordedYet")}
                  </p>
                )}
                {/* The rest, folded away — still countable at a glance, still
                    openable when you want to know WHO is outstanding. */}
                {unrecorded.length > 0 && (
                  <details className="group/unrec" data-testid="export-unrecorded">
                    <summary className="cursor-pointer list-none text-muted-foreground hover:text-foreground transition-colors">
                      <span className="inline-flex items-center gap-1">
                        <ChevronRight className="h-3 w-3 group-open/unrec:rotate-90" aria-hidden="true" />
                        {t("importExport.dialog.unrecordedCharacterCount", { count: unrecorded.length })}
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
                    {t("importExport.dialog.untimedRecordingsNote", { count: untimedTotal })}
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
          <div className="flex flex-col gap-1.5">
            {/* THREE SECTIONS, ONE OPEN. `<details>` rather than a Collapsible
                because it is what this dialog already uses three times over,
                and because it keeps closed content in the DOM — which means a
                half-filled filename or a scrolled list survives being
                collapsed and reopened. The accordion is entirely the shared
                `openSection` state: opening one IS closing the others. */}
            <details
              data-testid="export-audio-card"
              open={openSection === "audio"}
              onToggle={(e) => toggleSection("audio", (e.currentTarget as HTMLDetailsElement).open)}
              className="group/sec rounded-xl border border-border/60 bg-accent/30 px-3 py-2.5"
            >
              <summary className="flex cursor-pointer list-none items-baseline gap-2 select-none">
                <span
                  className="inline-block text-muted-foreground group-open/sec:rotate-90"
                  aria-hidden="true"
                >
                  ›
                </span>
                <span className="text-sm font-medium">{t("importExport.dialog.audioSectionTitle")}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">.zip</span>
              </summary>
              <div className="mt-2.5 flex flex-col gap-2.5">
              <RadioGroup
                value={audioMode}
                onValueChange={(v) => setAudioMode(v as typeof audioMode)}
                className="flex flex-col gap-0.5"
                aria-label={t("importExport.dialog.audioShapeGroupAriaLabel")}
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
                      {/* AQU-646 stage 4: by character is the DEFAULT TRACK's
                          deliverable, deliberately (Sam, 2026-08-26) — a
                          character's lines merged across several tracks is not
                          a mix stem anyone asked for. So where a file has added
                          tracks, this says what it is leaving behind and where
                          to find it, and does not gate anything: a small,
                          subtle notice were Sam's words, and by character is
                          still the right export for most of these files. */}
                      {mode.id === "audio-by-character" && hasAddedAudioTracks && (
                        <span
                          data-testid="export-audio-added-tracks-note"
                          className="mt-0.5 text-xs leading-relaxed text-amber-700 dark:text-amber-400"
                        >
                          {t("importExport.dialog.audioAddedTracksNote")}
                        </span>
                      )}
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
                disabled={!activeFileId || isBusy || (recordedLines === 0 && addedTrackTakes === 0)}
                aria-busy={isBusy}
              >
                {isBusy ? <Spinner aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
                {t("importExport.dialog.exportAudio")}
              </Button>
              </div>
            </details>

            {nativeOption && (
              <details
                data-testid="export-subtitle-card"
                open={openSection === "subtitle"}
                onToggle={(e) =>
                  toggleSection("subtitle", (e.currentTarget as HTMLDetailsElement).open)
                }
                className="group/sec rounded-xl border border-border/60 bg-accent/30 px-3 py-2.5"
              >
                {/* Named for the FORMAT rather than for "Subtitles", because
                    the section now holds two different files that are both
                    subtitles: the translated ones and the heard ones (Sam,
                    2026-08-20). */}
                <summary className="flex cursor-pointer list-none items-baseline gap-2 select-none">
                  <span
                    className="inline-block text-muted-foreground group-open/sec:rotate-90"
                    aria-hidden="true"
                  >
                    ›
                  </span>
                  <span className="text-sm font-medium">
                    {nativeOption.id === "srt"
                      ? t("importExport.dialog.srtExportSectionTitle")
                      : t("importExport.dialog.vttExportSectionTitle")}
                  </span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {nativeOption.ext}
                  </span>
                </summary>
                <div className="mt-2.5 flex flex-col gap-2.5">
                  {/* WHICH FILE. Offered only when there really is a second
                      one: `audioCells` falls back to this file's own rows when
                      no sibling was imported, so an ungated choice would
                      re-export the subtitles under an "_audio" name. */}
                  {hasAudioSibling && (
                    <RadioGroup
                      value={effectiveSubtitleTarget}
                      onValueChange={(v) => setSubtitleTarget(v as SubtitleTarget)}
                      className="flex flex-col gap-0.5"
                      aria-label={t("importExport.dialog.subtitleTargetGroupAriaLabel")}
                    >
                      {([
                        {
                          id: "subtitle" as const,
                          label: `Subtitle ${nativeOption.id.toUpperCase()}`,
                          hint: "The translated lines, timed to the film — the file this project produces.",
                        },
                        {
                          id: "audio" as const,
                          label: `Audio ${nativeOption.id.toUpperCase()}`,
                          hint: "The heard lines from the audio cues, in their own timings — what was actually said, for checking the dub against the picture.",
                        },
                      ]).map((choice) => (
                        <label
                          key={choice.id}
                          className={
                            "flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors " +
                            (effectiveSubtitleTarget === choice.id
                              ? "bg-background/70"
                              : "hover:bg-accent/40")
                          }
                        >
                          <RadioGroupItem
                            value={choice.id}
                            className="mt-0.5 shrink-0"
                            aria-label={choice.label}
                          />
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-sm leading-tight font-medium">{choice.label}</span>
                            <span className="text-xs leading-relaxed text-muted-foreground">
                              {choice.hint}
                            </span>
                          </span>
                        </label>
                      ))}
                    </RadioGroup>
                  )}
                  {nativeOption.id === "vtt" &&
                    renderVttOptions({ showSource: effectiveSubtitleTarget === "subtitle" })}
                  <Button
                    size="lg"
                    className="w-full justify-center"
                    onClick={() =>
                      handleExport(nativeOption.id, {
                        audioCues: effectiveSubtitleTarget === "audio",
                      })
                    }
                    disabled={!activeFileId || isBusy}
                    aria-busy={isBusy}
                  >
                    {isBusy ? <Spinner aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
                    {t("importExport.dialog.downloadFile", {
                      fileName: `${buildExportStem(false)}${effectiveSubtitleTarget === "audio" ? "_audio" : ""}${nativeOption.ext}`,
                    })}
                  </Button>
                </div>
              </details>
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
              {t("importExport.dialog.downloadFile", { fileName: `${buildExportStem(false)}${nativeOption.ext}` })}
            </Button>
            <p className="text-xs text-muted-foreground text-center leading-relaxed">
              {t("importExport.dialog.nativeFormatHint", { label: t(nativeOption.labelKey) })}
              {nativeOption.lossy && ` ${t("importExport.dialog.someFormattingMayNotCarryOver")}`}
              {structuralNote && ` ${t(structuralNote)}`}
            </p>
          </div>
        )}

        {/* Everything else is a conversion — tucked behind a collapse. */}
        {/* THE THIRD SECTION on a dubbing file, and the same standalone fold it
            has always been on everything else.
            
            One element rather than two: the body below is three hundred lines
            of fieldsets, and rendering it under two different wrappers would
            mean either duplicating it or hoisting it into a variable — both of
            which put a seam through the middle of the dialog for the sake of a
            border and a heading. Only the open/close wiring differs. */}
        <details
          data-testid="export-fold"
          open={isDubbingFile ? openSection === "fold" : formatsOpen}
          onToggle={(e) => {
            const nowOpen = (e.currentTarget as HTMLDetailsElement).open
            if (isDubbingFile) toggleSection("fold", nowOpen)
            else setFormatsOpen(nowOpen)
          }}
          className={
            isDubbingFile
              ? "group rounded-xl border border-border/60 bg-accent/30 px-3 py-2.5"
              : "group"
          }
        >
          <summary
            className={
              "flex select-none list-none items-center gap-1 font-medium transition-colors hover:text-foreground " +
              (isDubbingFile ? "cursor-pointer text-sm" : "text-xs text-muted-foreground")
            }
          >
            <span
              className={
                "inline-block " +
                ((isDubbingFile ? openSection === "fold" : formatsOpen) ? "rotate-90" : "rotate-0")
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
          {/* i18n-exempt "project" is an ExportScope tag, not copy */}
          {effectiveScope === "project" && format !== "usfm" && projectCellsLoading && (
            <div className="flex items-center gap-1.5 mt-1">
              <Skeleton className="h-2 w-2 rounded-full shrink-0" />
              <Skeleton className="h-3 w-40" />
            </div>
          )}
        </fieldset>

        {/* AQU-1148: Content — what the exported file is allowed to contain.
            Always shown: the point is that the DEFAULT stops being silent about
            mixing validated text, unreviewed drafts and source-language filler. */}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-medium text-muted-foreground mb-1.5">
            {t("importExport.dialog.contentLegend")}
          </legend>
          <Select
            value={contentMode}
            onValueChange={(v) => setContentMode((v as ExportContentMode | null) ?? DEFAULT_EXPORT_CONTENT_MODE)}
            items={contentModeItems}
          >
            <SelectTrigger
              size="sm"
              className="w-full"
              aria-label={t("importExport.dialog.contentModeAriaLabel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {contentModeItems.map((i) => (
                  <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">
            {t(
              !validatedOnly
                ? "importExport.dialog.contentModeCurrentHint"
                : isRoundTripFormat
                  ? "importExport.dialog.contentModeValidatedOnlyRoundTripHint"
                  : "importExport.dialog.contentModeValidatedOnlyHint",
            )}
          </p>
          {validatedOnly && (
            <p className="text-[10px] text-muted-foreground">
              {t("importExport.dialog.contentModeValidatedCount", {
                validated: validatedCellCount,
                count: cells.length,
              })}
            </p>
          )}
        </fieldset>

        {/* AQU-465: Chapter scope — only shown when the file has chapters to
            choose between and the format can be sliced by one */}
        {canScopeToChapter && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs font-medium text-muted-foreground mb-1.5">
              {t("editor.milestone.vocab.chapterPlural")}
            </legend>
            <Select
              value={chapterFilter}
              onValueChange={(v) => setChapterFilter(v ?? "")}
              items={chapterItems}
            >
              <SelectTrigger
                size="sm"
                className="w-full"
                aria-label={t("importExport.dialog.chapterFilterAriaLabel")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="">{t("importExport.dialog.allChapters")}</SelectItem>
                  {chapterLabels.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {chapterFilter && (
              <p className="text-[10px] text-muted-foreground">
                <RichMessage
                  k="importExport.dialog.chapterFilterHint"
                  values={{ chapter: <strong>{chapterFilter}</strong> }}
                />
              </p>
            )}
          </fieldset>
        )}

        {/* AQU-439: Voice filter — only shown when cells have cast assignments */}
        {distinctVoices.length > 0 && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs font-medium text-muted-foreground mb-1.5">
              {t("importExport.dialog.voiceLegend")}
            </legend>
            <Select
              value={voiceFilter}
              onValueChange={(v) => setVoiceFilter(v ?? "")}
              items={voiceItems}
            >
              <SelectTrigger
                size="sm"
                className="w-full"
                aria-label={t("importExport.dialog.voiceFilterAriaLabel")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="">{t("importExport.dialog.allVoices")}</SelectItem>
                  {distinctVoices.map((v) => (
                    <SelectItem key={v} value={v}>{v}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
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
            {/* i18n-exempt "project" is an ExportScope tag, not copy */}
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

        {/* Subtitle shape options — on the card for a dubbing file. */}
        {!isDubbingFile && format === "vtt" && renderVttOptions()}

        {/* Who is recorded — on the card for a dubbing file. */}
        {!isDubbingFile && (format === "audio-by-character" || format === "audio-by-line")
          // i18n-exempt "file" is an ExportScope tag, not copy
          && effectiveScope === "file" && renderCharacterPreview()}

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
                "inline-block " +
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
                        // i18n-exempt machine-readable USFM reference sample
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
        {/* i18n-exempt "idle" is an export-status kind tag, not copy */}
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
            {/* i18n-exempt "busy" is an export-status kind tag, not copy */}
            {status.kind === "busy" && (
              <Spinner className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            )}
            {/* i18n-exempt "ok" is an export-status kind tag, not copy */}
            {(status.kind === "ok" || status.kind === "ok-lossy") && (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            {/* i18n-exempt "error" is an export-status kind tag, not copy */}
            {status.kind === "error" && (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            <span className="flex flex-col gap-1">
              <span>{status.msg}</span>
              {/* i18n-exempt "error" is an export-status kind tag, not copy */}
              {status.kind === "error" && idmlRecovery && (
                <span className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    type="button"
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
        {/* i18n-exempt "ok" is an export-status kind tag, not copy */}
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
