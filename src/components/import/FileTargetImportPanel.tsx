/**
 * File-scoped target import: populate the OPEN file's target column from a
 * USFM file, a spreadsheet (CSV/TSV/XLSX) or a subtitle file (SRT/SBV).
 * Target-only — source cells are never created or modified.
 *
 * Flow:
 *   1. User drops/picks a file
 *   2. USFM → refs are intrinsic, straight to review (match by canonical ref)
 *      Subtitle (AQU-1144) → cues parsed, straight to review, matched by
 *      order (cue N → cell N) because cue cells carry no canonical refs
 *      Spreadsheet → [sheet selector] → column mapping (target required,
 *      ref optional; no ref column → rows match cells by order)
 *   3. Review: each incoming row beside the matched cell's source text;
 *      conflicts (cells that already have a translation) need an explicit tick
 *   4. Apply via the shared eBible-target pipeline (target.cell.commit, AD-2)
 */

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatCount, formatNumber, formatPercent } from "@/lib/i18n/format"
import { applyEBibleTargetImport } from "@/lib/import"
import { decodeImportText } from "@/lib/import/ai-recipe"
import { assertSourceUploadByteLength } from "@/lib/sync/source-upload"
import { cn } from "@/lib/utils"
import {
  matchTargetRowsByRef,
  matchTargetRowsByOrder,
  usfmToTargetRows,
  subtitleToTargetRowsWithReport,
  CUE_TARGET_EXTENSIONS,
  vttToTargetRowsWithReport,
  type FileTargetCellRef,
  type FileTargetMatchedCell,
  type FileTargetMatchResult,
  type TargetOrphanReason,
  type TargetRow,
} from "@/lib/import-file-target"
import {
  parseCsvToSheet,
  parseXlsxToSheets,
  type SpreadsheetSheet,
  type ColumnMapping,
} from "@/lib/parsers/spreadsheet"
import { ColumnMappingPanel } from "./ColumnMappingPanel"

export interface FileTargetImportPanelProps {
  projectId: string
  username: string
  /** Target-lane storage key. Empty/absent means the project's default lane. */
  targetLang?: string
  /** Display name of the open file — shown so the user knows the import scope. */
  fileName: string
  /** The open file's cells, in display order. */
  cells: FileTargetCellRef[]
  getToken: (fileId: string) => Promise<string | null>
  onImported: (committedCount: number) => void
  onCancel: () => void
  /** Surfaced alongside the inline error so the host can instrument failures. */
  onError?: (message: string, phase: "parse" | "apply") => void
  /** Optimistically patch many cells at once so the editor reflects the
   *  imported translations before the outbox finishes flushing. */
  applyOptimisticTargetEdits: (patches: { cellId: string; value: string }[]) => void
  /** AQU-634: per-project USFM front-matter opt-out. When on, the incoming USFM
   *  target rows exclude book-name/title/TOC + intro-block cells, staying
   *  aligned with source cells imported under the same setting. */
  excludeFrontMatter?: boolean
  /** Told where a back arrow should lead from the current step, or `null` on
   *  the first step. The host draws the arrow in its dialog title, the way the
   *  source import dialog does, so a wrong file is one click from the file
   *  picker instead of Cancel and the menu again. */
  onBackChange?: (back: FileTargetPanelBack | null) => void
}

export interface FileTargetPanelBack {
  /** Accessible name for the arrow: where it goes. */
  label: string
  onBack: () => void
  /** True while an import is being applied. */
  disabled: boolean
}

type PanelStep = "file" | "sheet" | "mapping" | "matching" | "review"

const USFM_EXTENSIONS = new Set(["usfm", "sfm", "usf"])
const SHEET_EXTENSIONS = new Set(["csv", "tsv", "xlsx"])
// AQU-1142: WebVTT subtitle target import. Partners producing dubbing/subtitle
// translations deliver a translated .vtt whose cues should populate the open
// cue file's target column, matched positionally against the source cues.
const VTT_EXTENSIONS = new Set(["vtt"])

/** Format tag for the uploaded file's source artifact (SOURCE_ARTIFACT_FORMATS
 *  in shared/import-contract). Spreadsheets fall through to "csv" because
 *  that branch also covers the ".txt-as-delimited" cases parseCsvToSheet
 *  accepts. */
function sourceArtifactFormat(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? ""
  if (USFM_EXTENSIONS.has(ext)) return "usfm" as const
  if (VTT_EXTENSIONS.has(ext)) return "vtt" as const
  if (ext === "sbv") return "sbv" as const
  if (ext === "srt") return "srt" as const
  if (ext === "xlsx") return "xlsx" as const
  if (ext === "tsv") return "tsv" as const
  return "csv" as const
}

/** A whole-file shift, for the review's tickbox: "2 seconds" under a minute,
 *  and "1:00:00" (h:mm:ss) past it — a broadcast file's hour reads as a
 *  timecode, not as 3,600 seconds. Direction is said by the sentence. */
function formatShift(offsetMs: number, locale: string): string {
  const ms = Math.abs(offsetMs)
  if (ms < 60_000) {
    return formatNumber(ms / 1000, locale, {
      style: "unit",
      unit: "second",
      unitDisplay: "long",
      maximumFractionDigits: 2,
    })
  }
  const totalSeconds = Math.round(ms / 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${Math.floor(totalSeconds / 3600)}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}`
}

/** Resolves once the browser has painted: a frame, then a task after it. Heavy
 *  matching runs only after this, so the skeleton it replaces is actually on
 *  screen — set state and compute in one go, and the page freezes on the OLD
 *  screen instead (a 1,062-line file took ~2.8s at 6x CPU throttling). The
 *  skeleton's state must be COMMITTED first (flushSync): React may otherwise
 *  commit it after the frame this waits for, and the matching starts unseen. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(resolve, 0))
    else setTimeout(resolve, 0)
  })
}

/** Placeholder rows shaped like review rows, pulsing while matching runs. */
function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <div className="divide-y" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-start gap-2 px-3 py-2">
          <Skeleton className="mt-0.5 size-3.5 rounded-sm" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-2.5 w-44 max-w-full" />
            <Skeleton className="h-2.5 w-64 max-w-full" />
            <Skeleton className="h-3.5 w-56 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** The amber pill a review row uses for anything a person should check. */
const AMBER_PILL = "border-transparent bg-amber-500/15 text-[10px] text-amber-700 dark:text-amber-300"

/** "Contest N" — rows (and unmatched cues) with the same number fought over one line. */
function ContestPill({ number, title }: { number: number; title: string }) {
  const { t, locale } = useI18n()
  return (
    <Badge className={cn(AMBER_PILL, "font-sans")} title={title}>
      {t("importExport.review.rowContestPill", { number: formatCount(number, locale) })}
    </Badge>
  )
}

/** A collapsible list under the review's counts. Its entries are built only
 *  while it is open: a file an hour off leaves ~1,000 cues unmatched and ~1,000
 *  lines uncovered, and building both hidden lists froze the page ~1.2s at 6x
 *  CPU throttling. */
function LazyDetails({ summary, children }: { summary: string; children: () => ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="mt-2 text-xs" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-muted-foreground">{summary}</summary>
      {open && children()}
    </details>
  )
}

/** One pairing in the review list. Memoised: ticking one row re-renders only it. */
const ReviewRow = memo(function ReviewRow({
  m,
  checked,
  onToggle,
}: {
  m: FileTargetMatchedCell
  checked: boolean
  onToggle: (cellId: string) => void
}) {
  const { t } = useI18n()
  return (
    <label className={cn("flex items-start gap-2 px-3 py-2 hover:bg-muted/30", m.alreadyThere && "opacity-60")}>
      <input
        type="checkbox"
        className="mt-0.5 rounded"
        checked={checked}
        disabled={m.alreadyThere}
        onChange={() => onToggle(m.cellId)}
      />
      <div className="flex-1 min-w-0">
        <p className="font-mono text-[10px] text-muted-foreground">
          {m.ref}
          {m.alreadyThere && (
            <span className="ms-1.5 font-sans">{t("importExport.review.rowAlreadyThere")}</span>
          )}
        </p>
        {/* The line's own timecode, present only when it disagrees
            with the cue's — so drift announces itself, and a clean
            file doesn't print every timecode twice. */}
        <p className="truncate text-[10px] text-muted-foreground/80">
          {m.cellRef && <span className="font-mono">{m.cellRef} </span>}
          {m.sourceText}
        </p>
        <p className="truncate text-xs text-foreground/80">{m.incomingText}</p>
        {m.hasConflict && (
          <p className="truncate text-[10px] text-amber-600">
            {t("importExport.review.replacesExisting", { text: m.currentText })}
          </p>
        )}
      </div>
      {/* Everything to check about a row sits in its corner. The
          contest number pairs rows that fought over one line; a
          timing pill means only the line's own timing is kept. */}
      {(m.contest !== undefined || m.flag === "sharedTiming" || m.cellRef) && (
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {m.contest !== undefined && (
            <ContestPill number={m.contest} title={t("importExport.review.rowContested", { number: m.contest })} />
          )}
          {m.flag === "sharedTiming" && (
            <Badge className={AMBER_PILL} title={t("importExport.review.rowSharedTiming")}>
              {t("importExport.review.rowSharedTimingPill")}
            </Badge>
          )}
          {m.cellRef && (
            <Badge className={AMBER_PILL}>{t("importExport.review.rowTimingDiffers")}</Badge>
          )}
        </div>
      )}
    </label>
  )
})

/** Above this many rows only the rows on screen are drawn. Below it every row
 *  is, which is cheap and keeps every row in the page for find-in-page. A
 *  1,062-line episode drawn whole froze the page ~0.9s at 6x CPU throttling. */
const VIRTUALIZE_ABOVE = 150
/** A typical row's height before it is measured. */
const REVIEW_ROW_ESTIMATE_PX = 64

interface ReviewRowListProps {
  matched: FileTargetMatchedCell[]
  selected: Set<string>
  onToggle: (cellId: string) => void
}

const REVIEW_LIST_CLASS = "min-h-0 flex-1 overflow-y-auto rounded-md border"

function ReviewRowList(props: ReviewRowListProps) {
  if (props.matched.length > VIRTUALIZE_ABOVE) return <VirtualReviewRowList {...props} />
  return (
    <div className={REVIEW_LIST_CLASS}>
      <div className="divide-y">
        {props.matched.map((m) => (
          <ReviewRow key={m.cellId} m={m} checked={props.selected.has(m.cellId)} onToggle={props.onToggle} />
        ))}
      </div>
    </div>
  )
}

function VirtualReviewRowList({ matched, selected, onToggle }: ReviewRowListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: matched.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => matched[index]?.cellId ?? index,
    estimateSize: () => REVIEW_ROW_ESTIMATE_PX,
    // A row that reports no height (not laid out yet, or jsdom) keeps the
    // estimate rather than collapsing to 0 and pulling hundreds into view.
    measureElement: (element) => element.getBoundingClientRect().height || REVIEW_ROW_ESTIMATE_PX,
    overscan: 8,
    initialRect: { width: 560, height: 480 },
    // jsdom/happy-dom report 0×0 for CSS-sized scrollports; coerce so rows
    // mount there too (as ChapterNavigator does).
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        cb({ width: rect.width > 0 ? rect.width : 560, height: rect.height > 0 ? rect.height : 480 })
      }),
  })
  return (
    <div ref={scrollRef} className={REVIEW_LIST_CLASS}>
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const m = matched[item.index]
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute inset-x-0 top-0 border-b"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <ReviewRow m={m} checked={selected.has(m.cellId)} onToggle={onToggle} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function FileTargetImportPanel({
  projectId,
  username,
  targetLang,
  fileName,
  cells,
  getToken,
  onImported,
  onCancel,
  onError,
  applyOptimisticTargetEdits,
  excludeFrontMatter,
  onBackChange,
}: FileTargetImportPanelProps) {
  const { t, locale } = useI18n()
  const [step, setStep] = useState<PanelStep>("file")
  const [error, setError] = useState<string | null>(null)
  const [sheets, setSheets] = useState<SpreadsheetSheet[]>([])
  const [selectedSheet, setSelectedSheet] = useState<SpreadsheetSheet | null>(null)
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [matchResult, setMatchResult] = useState<FileTargetMatchResult | null>(null)
  const [matchedByOrder, setMatchedByOrder] = useState(false)
  // A subtitle file's parsed cues, kept so the review's shift tickbox can
  // re-run the match with the shift on or off.
  const [subtitleRows, setSubtitleRows] = useState<{ rows: TargetRow[]; skippedCues: number } | null>(null)
  const [selectedCellIds, setSelectedCellIds] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  // The shift tickbox's new value while the list re-matches under it; null
  // when nothing is pending.
  const [rematching, setRematching] = useState<boolean | null>(null)
  // Bumped by every match started and by leaving the review, so a match that
  // finishes after the user moved on is dropped instead of shown.
  const matchRun = useRef(0)

  // Back goes one step: review → column mapping for a spreadsheet (the column
  // choice is what you'd fix, without re-uploading) and → the file picker for
  // everything else; mapping → the sheet list when the workbook had several.
  // Leaving the review drops its ticks, since they belong to that pairing.
  useEffect(() => {
    if (!onBackChange) return
    if (step === "file") {
      onBackChange(null)
      return
    }
    const toFilePicker = {
      label: t("importExport.dialog.backToFileSelection"),
      onBack: () => {
        matchRun.current++
        setRematching(null)
        setMatchResult(null)
        setSelectedCellIds(new Set())
        setSheets([])
        setSelectedSheet(null)
        setSourceFile(null)
        setSubtitleRows(null)
        setError(null)
        setStep("file")
      },
    }
    const back =
      step === "review" && selectedSheet
        ? {
            label: t("importExport.fileTarget.backToColumnMapping"),
            onBack: () => {
              matchRun.current++
              setRematching(null)
              setMatchResult(null)
              setSelectedCellIds(new Set())
              setError(null)
              setStep("mapping")
            },
          }
        : step === "mapping" && sheets.length > 1
          ? {
              label: t("importExport.fileTarget.backToSheetList"),
              onBack: () => {
                setSelectedSheet(null)
                setError(null)
                setStep("sheet")
              },
            }
          : toFilePicker
    onBackChange({ ...back, disabled: applying })
  }, [step, selectedSheet, sheets.length, applying, onBackChange, t])

  const showReview = useCallback((result: FileTargetMatchResult, byOrder: boolean) => {
    setMatchResult(result)
    setMatchedByOrder(byOrder)
    // Pre-select only rows that are safe to take as they stand. Overwriting an
    // existing translation needs an explicit tick; so does a row the matcher
    // flagged for a person to check (AQU-1360); and a row whose text the line
    // already holds has nothing to import at all.
    setSelectedCellIds(new Set(
      result.matched.filter((m) => !m.hasConflict && !m.alreadyThere && !m.flag).map((m) => m.cellId),
    ))
    setStep("review")
  }, [])

  const toggleCell = useCallback((cellId: string) => {
    setSelectedCellIds((prev) => {
      const next = new Set(prev)
      if (next.has(cellId)) next.delete(cellId)
      else next.add(cellId)
      return next
    })
  }, [])

  /** Show the matching skeleton and let it paint before the matching blocks
   *  the page. False when the user moved on meanwhile. */
  const showMatching = useCallback(async () => {
    const run = ++matchRun.current
    flushSync(() => setStep("matching"))
    await nextPaint()
    return run === matchRun.current
  }, [])

  const handleFile = useCallback(async (file: File) => {
    setError(null)
    setSourceFile(file)
    const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
    try {
      assertSourceUploadByteLength(file.size)
      if (USFM_EXTENSIONS.has(ext)) {
        const text = decodeImportText(await file.arrayBuffer(), file.name)
        if (!(await showMatching())) return
        const rows = usfmToTargetRows(text, { excludeFrontMatter })
        if (rows.length === 0) {
          setError(t("importExport.fileTarget.noVersesInUsfm"))
          setStep("file")
          return
        }
        showReview(matchTargetRowsByRef(rows, cells), false)
      } else if (VTT_EXTENSIONS.has(ext)) {
        // AQU-1142: VTT cues carry timestamps, never canonical refs, so match
        // positionally (cue N → cell N) — the review screen surfaces any
        // misalignment before commit via the same order-match warning used
        // for spreadsheets without a ref column.
        const text = decodeImportText(await file.arrayBuffer(), file.name)
        if (!(await showMatching())) return
        const { rows, skippedCues } = vttToTargetRowsWithReport(text)
        if (rows.length === 0) {
          setError(t("importExport.fileTarget.noCuesInVtt"))
          setStep("file")
          return
        }
        setSubtitleRows({ rows, skippedCues })
        showReview({ ...matchTargetRowsByOrder(rows, cells), skippedCues }, true)
      } else if (CUE_TARGET_EXTENSIONS.has(ext)) {
        // AQU-1144: SRT/SBV cues have no canonical refs either, so they take
        // the same ref-less path as VTT — timecode overlap when the file's
        // cells carry timings (AQU-1143), cue N → cell N otherwise.
        const text = decodeImportText(await file.arrayBuffer(), file.name)
        if (!(await showMatching())) return
        const { rows, skippedCues } = subtitleToTargetRowsWithReport(text, ext)
        if (rows.length === 0) {
          setError(t("importExport.fileTarget.noCuesInSubtitle"))
          setStep("file")
          return
        }
        setSubtitleRows({ rows, skippedCues })
        showReview({ ...matchTargetRowsByOrder(rows, cells), skippedCues }, true)
      } else if (ext === "xls") {
        setError(t("importExport.spreadsheet.legacyXlsUnsupported"))
        return
      } else if (ext === "xlsx") {
        const parsed = await parseXlsxToSheets(await file.arrayBuffer())
        if (parsed.length === 0) {
          setError(t("importExport.spreadsheet.noSheetsFound"))
          return
        }
        setSheets(parsed)
        if (parsed.length === 1) {
          setSelectedSheet(parsed[0])
          setStep("mapping")
        } else {
          setStep("sheet")
        }
      } else if (SHEET_EXTENSIONS.has(ext)) {
        const sheet = parseCsvToSheet(decodeImportText(await file.arrayBuffer(), file.name), file.name)
        setSheets([sheet])
        setSelectedSheet(sheet)
        setStep("mapping")
      } else {
        setError(t("importExport.fileTarget.unsupportedFileType"))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t("importExport.errors.failedToParseFile")
      setError(message)
      setStep("file")
      onError?.(message, "parse")
    }
  }, [cells, showReview, showMatching, onError, excludeFrontMatter, t])

  function handleMappingConfirm(mapping: ColumnMapping, hasHeader: boolean) {
    if (!selectedSheet || mapping.targetCol === null) return
    const dataRows = hasHeader ? selectedSheet.rows.slice(1) : selectedSheet.rows
    // Keep empty rows in place — order matching needs every row to hold its slot.
    const rows: TargetRow[] = dataRows.map((r) => ({
      ref: mapping.labelCol !== null ? (r[mapping.labelCol] ?? "").trim() || undefined : undefined,
      text: (r[mapping.targetCol!] ?? "").trim(),
    }))
    const byOrder = mapping.labelCol === null
    showReview(
      byOrder ? matchTargetRowsByOrder(rows, cells) : matchTargetRowsByRef(rows, cells),
      byOrder,
    )
  }

  async function handleApply() {
    // Guard against double-submit: a second click while the enqueue is in
    // flight would re-optimistic-patch and re-enqueue the same cells.
    if (!matchResult || !sourceFile || applying) return
    setApplying(true)
    setError(null)
    const selected = matchResult.matched.filter((m) => selectedCellIds.has(m.cellId))
    // Optimistic: show imported translations in the open editor immediately
    // (before the local enqueue settles) so the instant-render win is kept.
    applyOptimisticTargetEdits(selected.map((m) => ({ cellId: m.cellId, value: m.incomingText })))
    try {
      // Enqueue to the outbox (fast, local). The flusher drains in the background;
      // the sync badge + inspector surface progress / retry.
      const { committedCount } = await applyEBibleTargetImport(
        matchResult,
        selectedCellIds,
        {
          projectId,
          author: username,
          getToken,
          targetLang,
          sourceArtifact: {
            name: sourceFile.name,
            bytes: await sourceFile.arrayBuffer(),
            format: sourceArtifactFormat(sourceFile.name),
          },
        },
      )
      onImported(committedCount) // closes the dialog — content is already visible + queued
    } catch (err) {
      // The enqueue failed, so nothing was queued — undo the optimistic patch
      // instead of leaving phantom translations in the cell store until a later
      // revalidate. Restore each cell's pre-import value (empty for fresh cells,
      // the prior translation for conflicts).
      applyOptimisticTargetEdits(selected.map((m) => ({ cellId: m.cellId, value: m.currentText })))
      const message = err instanceof Error ? err.message : t("importExport.errors.importFailed")
      setError(message)
      onError?.(message, "apply")
      setApplying(false)
    }
  }

  // ── Step: file selection ────────────────────────────────────────────────────
  if (step === "file") {
    return (
      <div className="flex flex-col gap-4 py-2">
        <div>
          <p className="text-sm font-medium">{t("importExport.fileTarget.title", { fileName })}</p>
          <p className="text-xs text-muted-foreground">
            {t("importExport.fileTarget.description")}
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
          <p className="text-sm text-muted-foreground">{t("importExport.fileTarget.dropZoneHint")}</p>
          <label>
            <span className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors">
              {t("editor.video.chooseFile")}
            </span>
            <input
              type="file"
              accept=".usfm,.sfm,.usf,.csv,.tsv,.xlsx,.vtt,.srt,.sbv"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFile(file)
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">{t("importExport.fileTarget.acceptedFormats")}</p>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
        </div>
      </div>
    )
  }

  // ── Step: sheet selection (XLSX with multiple sheets) ──────────────────────
  if (step === "sheet") {
    return (
      <div className="flex flex-col gap-4 py-2">
        <div>
          <p className="text-sm font-medium">{t("importExport.spreadsheet.selectSheetTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("importExport.spreadsheet.selectSheetHint")}</p>
        </div>
        <div className="flex flex-col gap-2">
          {sheets.map((s, i) => (
            <button
              key={i}
              type="button"
              className="rounded-lg border p-3 text-start hover:border-primary hover:bg-primary/5 transition-colors"
              onClick={() => {
                setSelectedSheet(s)
                setStep("mapping")
              }}
            >
              <p className="text-sm font-medium">{s.name}</p>
              <p className="text-xs text-muted-foreground">{t("importExport.spreadsheet.sheetRowCount", { count: s.rows.length })}</p>
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
        </div>
      </div>
    )
  }

  // ── Step: column mapping (spreadsheets only) ────────────────────────────────
  if (step === "mapping" && selectedSheet) {
    return (
      <ColumnMappingPanel
        sheet={selectedSheet}
        mode="target"
        onConfirm={handleMappingConfirm}
        onCancel={onCancel}
      />
    )
  }

  // ── Step: matching (skeleton while a dropped file is matched) ──────────────
  if (step === "matching") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 py-2" aria-busy="true">
        <div className="shrink-0">
          <p className="text-sm font-medium" role="status">{t("importExport.review.matching")}</p>
          <Skeleton className="mt-1.5 h-3 w-48" />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
          <SkeletonRows />
        </div>
        <div className="flex shrink-0 justify-end">
          <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
        </div>
      </div>
    )
  }

  // ── Step: review matches ────────────────────────────────────────────────────
  if (step === "review" && matchResult) {
    const { matched, orphans, uncovered, timebase, looseFit, skippedCues = 0 } = matchResult
    const conflicts = matched.filter((m) => m.hasConflict)
    const alreadyThere = matched.filter((m) => m.alreadyThere)
    // Rows a person can actually choose to import.
    const selectable = matched.filter((m) => !m.alreadyThere)
    const contests = new Set(matched.flatMap((m) => (m.contest !== undefined ? [m.contest] : []))).size
    const sharedTimingRows = matched.filter((m) => m.flag === "sharedTiming").length
    const brokenTimecodes = orphans.filter((o) => o.reason === "backwardsTimecode").length
    const unplaced = orphans.length - brokenTimecodes
    // AQU-1143: a ref-less match that aligned by cue timecode is not the
    // fragile top-to-bottom pairing this warns about — don't send the user off
    // to eyeball 500 rows for a drift that cannot have happened.
    const showOrderMatchWarning = matchedByOrder && matchResult.alignedBy !== "overlap"
    const reasonLabel = (reason: TargetOrphanReason | undefined) =>
      reason === "backwardsTimecode"
        ? t("importExport.review.reasonBackwardsTimecode")
        : reason === "lostItsLine"
          ? t("importExport.review.reasonLostItsLine")
          : reason === "noLineInReach"
            ? t("importExport.review.reasonNoLineInReach")
            : null
    // A whole-file shift is offered as a tickbox (ticked when the matcher
    // applied it); the frame-rate note stands alone only for a stretch without
    // a shift, since the tickbox's label names any stretch that comes with it.
    const { offsetCorrection } = matchResult
    const offsetApplied = (timebase?.offsetMs ?? 0) !== 0
    const offsetLabel = offsetCorrection
      ? [
          t(offsetCorrection.offsetMs < 0 ? "importExport.review.offsetEarlier" : "importExport.review.offsetLater", {
            amount: formatShift(offsetCorrection.offsetMs, locale),
            count: offsetCorrection.closeAfter - offsetCorrection.closeBefore,
          }),
          offsetCorrection.scale === 1
            ? null
            : offsetCorrection.fromFps && offsetCorrection.toFps
              ? t("importExport.review.offsetAlsoRateNamed", {
                  fromFps: offsetCorrection.fromFps,
                  toFps: offsetCorrection.toFps,
                })
              : t("importExport.review.offsetAlsoRateUnnamed", {
                  percent: formatPercent(offsetCorrection.scale - 1, locale, {
                    maximumFractionDigits: 1,
                    signDisplay: "always",
                  }),
                }),
        ].filter(Boolean).join(" ")
      : null
    const timebaseNote = timebase && timebase.offsetMs === 0
      ? timebase.fromFps && timebase.toFps
        ? t("importExport.review.timebaseNamed", {
            fromFps: timebase.fromFps,
            toFps: timebase.toFps,
            count: timebase.closeAfter - timebase.closeBefore,
          })
        : t("importExport.review.timebaseUnnamed", {
            percent: formatPercent(timebase.scale - 1, locale, { maximumFractionDigits: 1, signDisplay: "always" }),
            count: timebase.closeAfter - timebase.closeBefore,
          })
      : null

    // Flip the box at once, show skeleton rows, and re-match from the
    // corrections already found — the tickbox can't change them, so the
    // ~25-pass search never runs twice.
    async function toggleOffset(apply: boolean) {
      if (!subtitleRows || !matchResult) return
      const known = { rate: matchResult.rateCorrection ?? null, offset: matchResult.offsetCorrection ?? null }
      const run = ++matchRun.current
      flushSync(() => setRematching(apply))
      await nextPaint()
      if (run !== matchRun.current) return
      showReview(
        {
          ...matchTargetRowsByOrder(subtitleRows.rows, cells, { applyOffset: apply, known }),
          skippedCues: subtitleRows.skippedCues,
        },
        true,
      )
      setRematching(null)
    }

    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 py-2">
        <div className="shrink-0">
          <p className="text-sm font-medium">{t("importExport.review.title")}</p>
          {/* AQU-1360: anything other than a clean pairing is amber. Unmatched
              and uncovered counts used to share the grey of "8 matched", so a
              file that mostly failed looked exactly like a perfect one. */}
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>{t("importExport.review.matchedCount", { count: matched.length })}</span>
            {alreadyThere.length > 0 && <span>{t("importExport.review.alreadyThereCount", { count: alreadyThere.length })}</span>}
            {conflicts.length > 0 && <span className="text-amber-600">{t("importExport.review.conflictCount", { count: conflicts.length })}</span>}
            {unplaced > 0 && <span className="text-amber-600">{t("importExport.review.unmatchedRowCount", { count: unplaced })}</span>}
            {brokenTimecodes > 0 && <span className="text-amber-600">{t("importExport.review.brokenTimecodeCount", { count: brokenTimecodes })}</span>}
            {uncovered.length > 0 && <span className="text-amber-600">{t("importExport.review.uncoveredCellCount", { count: uncovered.length })}</span>}
            {skippedCues > 0 && <span className="text-amber-600">{t("importExport.review.skippedCueCount", { count: skippedCues })}</span>}
          </div>
          {showOrderMatchWarning && (
            <p className="mt-1.5 text-xs text-amber-600">
              {t("importExport.review.orderMatchWarning")}
            </p>
          )}
          {contests > 0 && (
            <p className="mt-1.5 text-xs text-amber-600">
              {t("importExport.review.contestedWarning", { count: contests })}
            </p>
          )}
          {sharedTimingRows > 0 && (
            <p className="mt-1.5 text-xs text-amber-600">
              {t("importExport.review.sharedTimingWarning", { count: sharedTimingRows })}
            </p>
          )}
          {looseFit && (
            <p className="mt-1.5 text-xs text-amber-600">{t("importExport.review.looseFitWarning")}</p>
          )}
          {offsetLabel && subtitleRows && (
            <label className="mt-1.5 flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5 rounded"
                checked={rematching ?? offsetApplied}
                disabled={rematching !== null}
                onChange={(e) => void toggleOffset(e.target.checked)}
              />
              <span>{offsetLabel}</span>
            </label>
          )}
          {timebaseNote && <p className="mt-1.5 text-xs text-muted-foreground">{timebaseNote}</p>}

          {orphans.length > 0 && (
            <LazyDetails summary={`${t("importExport.review.unmatchedListTitle")} (${formatCount(orphans.length, locale)})`}>
              {() => (
                <ul className="mt-1 max-h-32 divide-y overflow-y-auto rounded-md border">
                  {orphans.map((o, i) => (
                    <li key={`${o.ref}-${i}`} className="px-3 py-1.5">
                      <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                        {o.ref}
                        {reasonLabel(o.reason) && (
                          <span className="font-sans text-amber-600">{reasonLabel(o.reason)}</span>
                        )}
                        {o.contest !== undefined && (
                          <ContestPill number={o.contest} title={t("importExport.review.rowContested", { number: o.contest })} />
                        )}
                      </p>
                      <p className="truncate text-foreground/80">{o.text}</p>
                    </li>
                  ))}
                </ul>
              )}
            </LazyDetails>
          )}
          {uncovered.length > 0 && (
            <LazyDetails summary={`${t("importExport.review.uncoveredListTitle")} (${formatCount(uncovered.length, locale)})`}>
              {() => (
                <ul className="mt-1 max-h-32 divide-y overflow-y-auto rounded-md border">
                  {uncovered.map((u) => (
                    <li key={u.cellId} className="px-3 py-1.5">
                      {u.cellRef && <p className="font-mono text-[10px] text-muted-foreground">{u.cellRef}</p>}
                      <p className="truncate text-foreground/80">{u.sourceText}</p>
                    </li>
                  ))}
                </ul>
              )}
            </LazyDetails>
          )}
        </div>

        {rematching !== null ? (
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border" aria-busy="true">
            <span className="sr-only" role="status">{t("importExport.review.matching")}</span>
            <SkeletonRows />
          </div>
        ) : (
          <ReviewRowList matched={matched} selected={selectedCellIds} onToggle={toggleCell} />
        )}

        {error && <p className="shrink-0 text-xs text-destructive">{error}</p>}

        <div className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              // Rows whose text is already there have nothing to import.
              const allIds = new Set(selectable.map((m) => m.cellId))
              const allSelected = allIds.size > 0 && [...allIds].every((id) => selectedCellIds.has(id))
              setSelectedCellIds(allSelected ? new Set() : allIds)
            }}
          >
            {selectedCellIds.size === selectable.length ? t("importExport.review.deselectAll") : t("common.selectAll")}
          </button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
            <Button
              disabled={selectedCellIds.size === 0 || applying || rematching !== null}
              onClick={handleApply}
            >
              {t("importExport.review.importCellCount", { count: selectedCellIds.size })}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // No blocking "importing" screen: the optimistic patch means the editor
  // already shows the result and handleApply calls onImported (closing the
  // dialog) as soon as the local enqueue accepts. This return only covers
  // transient/impossible states (e.g. a step with its data not yet set).
  return null
}
