import { useMemo, useState } from "react"
import { ChevronDown } from "lucide-react"
import { usePersistedToggleSet } from "@/hooks/useSidebarExpansion"
import { groupChaptersByBook } from "@/lib/sidebar/book-sections"
import { AppTooltip } from "@/components/ui/tooltip"
import { healthRibbonColor, healthRibbonOpacity } from "@/lib/health/health-ribbon"
import { PROGRESS_COLOR, progressColorAt } from "@/lib/progress/progress-palette"
import type { MilestoneProgressView } from "@/lib/progress/milestone-progress-view"
import { cn } from "@/lib/utils"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"

export interface BookHealthCell {
  id: string
  /**
   * AQU-1083: `excluded` is a heading in a project that does not count
   * headings toward progress. It is drawn — the map still shows the whole
   * file — but it is not work, so it must not read as untranslated. That is
   * the entire point of the setting: a chapter title left alone is finished
   * business, not an outstanding task.
   */
  stage: "untranslated" | "automatic" | "validated" | "excluded" | "recorded" | "audioValidated"
  health?: number
  hasIssue?: boolean
}

export interface BookHealthChapter {
  key: string
  label: string
  translated: number
  validated: number
  total: number
  cells?: BookHealthCell[]
  /** True when the backend supplied percentages rather than raw cell counts. */
  percentagesOnly?: boolean
  /**
   * AQU-2112: the audio pair, in the same unit as `translated`/`validated` —
   * `audioRecorded` is lines carrying a take of their own, `audioValidated`
   * those whose every chosen take meets the project's audio requirement.
   *
   * OPTIONAL, and absent means "audio is not counted here": a text-only file
   * carries neither key and reads exactly as it did before. A fabricated 0
   * would instead claim nothing is recorded.
   */
  audioRecorded?: number
  audioValidated?: number
  /**
   * Which figures this chapter shows, decided once for the WHOLE file by
   * whoever built these chapters (AQU-2110's rule, shared). Absent is "text",
   * so every existing caller is unchanged.
   */
  progressView?: MilestoneProgressView
}

interface ChapterVisual {
  color: string
  score?: number
  opacity: number
  measured: boolean
}

const MAX_MATRIX_COLUMNS = 10
const COLLAPSED_CELL_LIMIT = 100

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function automaticScores(chapter: BookHealthChapter): number[] {
  return (chapter.cells ?? [])
    .filter((cell) => cell.stage === "automatic" && cell.health !== undefined)
    .map((cell) => cell.health!)
}

/*
 * AQU-1764: WHERE THE SQUARES SAY PROGRESS, THEY USE THE SHARED PROGRESS
 * PALETTE. A validated square is the text-validated blue and a translated
 * square with no health score the translated blue (it was amber at 0.28,
 * which said "in review" in a colour that means Due soon elsewhere). A square
 * WITH a score keeps the red-amber-green health tint, and the untranslated
 * slate, the hollow excluded heading and the amber issue ring stay as they
 * are: those are about quality, not progress.
 */

/** Nothing recorded, nothing translated: the faint slate every surface uses. */
const UNTOUCHED_VISUAL: ChapterVisual = Object.freeze({
  color: "rgb(148 163 184 / 0.22)",
  opacity: 0.22,
  measured: false,
})

/** AQU-2112: a chapter's view — absent means text, as it always did. */
function viewOf(chapter: BookHealthChapter): MilestoneProgressView {
  return chapter.progressView ?? "text"
}

/*
 * AQU-2112: THE AUDIO TWIN OF `chapterVisual`, in the palette's magenta
 * tones. Same shape of decision — fully signed off, then "there is a take
 * here but it has not passed", then a partial share — with no health step at
 * all: health scores a translation's TEXT, and an audio-only chapter has
 * none. A chapter whose takes are all validated reads complete here, where
 * the text rule held it at the untranslated slate however many were signed
 * off, because the only flag it ever consulted was the text one.
 */
function audioChapterVisual(chapter: BookHealthChapter): ChapterVisual {
  const recorded = chapter.audioRecorded ?? 0
  const validated = chapter.audioValidated ?? 0
  if (chapter.total > 0 && validated >= chapter.total) {
    return { color: PROGRESS_COLOR.audioValidated, score: 100, opacity: 1, measured: true }
  }
  if (recorded > validated) {
    // Recorded and not yet signed off — the recorded tone says a take exists
    // without claiming it passed.
    return { color: PROGRESS_COLOR.audioRecorded, opacity: 1, measured: false }
  }
  if (validated > 0) {
    const ratio = chapter.total > 0 ? validated / chapter.total : 0
    const opacity = 0.28 + (0.52 * ratio)
    return { color: progressColorAt(PROGRESS_COLOR.audioValidated, opacity), opacity, measured: false }
  }
  return UNTOUCHED_VISUAL
}

function chapterVisual(chapter: BookHealthChapter): ChapterVisual {
  // A file with recordings and no target text is measured in audio alone.
  // "both" keeps the text colour: the text figures there are unchanged and
  // the audio ones stand beside them.
  if (viewOf(chapter) === "audio") return audioChapterVisual(chapter)
  if (chapter.total > 0 && chapter.validated >= chapter.total) {
    return { color: PROGRESS_COLOR.textValidated, score: 100, opacity: 1, measured: true }
  }

  const score = median(automaticScores(chapter))
  if (score !== undefined) {
    const opacity = healthRibbonOpacity({
      stage: "automatic",
      rawScore: score,
      smoothedScore: score,
      evidenceWeight: 1,
    })
    return { color: healthRibbonColor(score, opacity), score, opacity, measured: true }
  }

  if (chapter.translated > chapter.validated) {
    // We know work exists but do not have an automatic health measurement for
    // this chapter. The translated tone says "done, not validated yet"
    // without inventing a score.
    return { color: PROGRESS_COLOR.textTranslated, opacity: 1, measured: false }
  }

  if (chapter.validated > 0) {
    // Partly validated and nothing else translated: the validated blue,
    // stronger the larger the validated share.
    const ratio = chapter.total > 0 ? chapter.validated / chapter.total : 0
    const opacity = 0.28 + (0.52 * ratio)
    return { color: progressColorAt(PROGRESS_COLOR.textValidated, opacity), opacity, measured: false }
  }

  return UNTOUCHED_VISUAL
}

/**
 * AQU-2112: the colour of a bucket holding audio squares, or null when it
 * holds none. Read before health and before the text stages, because an audio
 * square has no text under it to score or to call untranslated.
 */
function audioBucketColor(cells: BookHealthCell[]): string | null {
  if (!cells.some((cell) => cell.stage === "audioValidated" || cell.stage === "recorded")) return null
  const validated = cells.filter((cell) => cell.stage === "audioValidated").length
  if (validated === cells.length) return PROGRESS_COLOR.audioValidated
  if (validated > 0) {
    return progressColorAt(PROGRESS_COLOR.audioValidated, 0.25 + (0.55 * validated / cells.length))
  }
  return PROGRESS_COLOR.audioRecorded
}

function matrixColumns(cellCount: number): number {
  if (cellCount <= 0) return 1
  return Math.min(MAX_MATRIX_COLUMNS, cellCount)
}

function cellBucketVisual(cells: BookHealthCell[]): { color: string; issue: boolean } {
  const audio = audioBucketColor(cells)
  if (audio) return { color: audio, issue: cells.some((cell) => cell.hasIssue) }

  const automatic = cells
    .filter((cell) => cell.stage === "automatic" && cell.health !== undefined)
    .map((cell) => cell.health!)
  const score = median(automatic)
  if (score !== undefined) {
    const opacity = healthRibbonOpacity({
      stage: "automatic",
      rawScore: score,
      smoothedScore: score,
      evidenceWeight: 1,
    })
    return {
      color: healthRibbonColor(score, opacity),
      issue: cells.some((cell) => cell.hasIssue),
    }
  }

  const validated = cells.filter((cell) => cell.stage === "validated").length
  if (validated === cells.length) {
    return {
      color: PROGRESS_COLOR.textValidated,
      issue: cells.some((cell) => cell.hasIssue),
    }
  }
  if (validated > 0) {
    // A bucket of several cells, partly validated: the validated blue at the
    // validated share's strength.
    return {
      color: progressColorAt(PROGRESS_COLOR.textValidated, 0.25 + (0.55 * validated / cells.length)),
      issue: cells.some((cell) => cell.hasIssue),
    }
  }
  if (cells.some((cell) => cell.stage === "automatic")) {
    return {
      color: PROGRESS_COLOR.textTranslated,
      issue: cells.some((cell) => cell.hasIssue),
    }
  }
  return {
    color: "rgb(148 163 184 / 0.2)",
    issue: cells.some((cell) => cell.hasIssue),
  }
}

function cellDescription(cell: BookHealthCell, index: number): string {
  const prefix = `Cell ${index + 1}`
  const warning = cell.hasIssue ? " · automatic warning" : ""
  // Says WHY it is grey. Without this the square is indistinguishable from a
  // faint untranslated one to anyone reading it with a screen reader.
  if (cell.stage === "excluded") return `${prefix}: heading — not counted toward progress${warning}`
  // AQU-2112: an audio square announces the TAKE. Without this a signed-off
  // recording was read out as "untranslated", which is the bug in words.
  if (cell.stage === "audioValidated") return `${prefix}: audio validated${warning}`
  if (cell.stage === "recorded") return `${prefix}: recorded, awaiting audio validation${warning}`
  if (cell.stage === "validated") return `${prefix}: human validated${warning}`
  if (cell.stage === "automatic") {
    return cell.health === undefined
      ? `${prefix}: automatic health awaiting evidence${warning}`
      : `${prefix}: automatic health ${Math.round(cell.health)}%${warning}`
  }
  return `${prefix}: untranslated${warning}`
}

/**
 * AQU-2112: the figure beside a chapter's name — the share that is SIGNED
 * OFF, in whichever unit the file is measured in. An audio-only chapter reads
 * its audio-validated share, where it used to read a text figure that can
 * never move on a language with no written form; a chapter with both reads
 * the text figure it always did, with the audio one beside it.
 */
function chapterFigures(chapter: BookHealthChapter): { text: string | null; audio: string | null } {
  const view = viewOf(chapter)
  const figure = (part: number) => chapter.percentagesOnly ? `${part}%` : `${part}/${chapter.total}`
  return {
    text: view === "audio" ? null : figure(chapter.validated),
    audio: view === "text" ? null : figure(chapter.audioValidated ?? 0),
  }
}

/** The "x translated · y recorded" line under a chapter with no square map. */
function chapterProgressWords(chapter: BookHealthChapter): string {
  const view = viewOf(chapter)
  const words = (part: number, word: string) =>
    chapter.percentagesOnly ? `${part}% ${word}` : `${part}/${chapter.total} ${word}`
  const parts: string[] = []
  if (view !== "audio") parts.push(words(chapter.translated, "translated"))
  if (view !== "text") parts.push(words(chapter.audioRecorded ?? 0, "recorded"))
  return parts.join(" · ")
}

function chapterTooltip(chapter: BookHealthChapter, visual: ChapterVisual, t: TFunction) {
  const issueCount = chapter.cells?.filter((cell) => cell.hasIssue).length ?? 0
  const untranslated = Math.max(0, chapter.total - chapter.translated)
  const automatic = Math.max(0, chapter.translated - chapter.validated)
  const view = viewOf(chapter)
  const audioRecorded = chapter.audioRecorded ?? 0
  const audioValidated = chapter.audioValidated ?? 0
  return (
    <div className="space-y-1">
      <p className="font-medium">{chapter.label}</p>
      {view === "audio" ? null : chapter.percentagesOnly ? (
        <p>{t("agentWorkspace.chapterPercentProgress", { validated: chapter.validated, translated: chapter.translated })}</p>
      ) : (
        <p>{t("agentWorkspace.chapterCountProgress", { validated: chapter.validated, automatic, untranslated })}</p>
      )}
      {view === "text" ? null : chapter.percentagesOnly ? (
        <p>{t("agentWorkspace.chapterAudioPercentProgress", { validated: audioValidated, recorded: audioRecorded })}</p>
      ) : (
        <p>{t("agentWorkspace.chapterAudioCountProgress", { validated: audioValidated, recorded: audioRecorded, total: chapter.total })}</p>
      )}
      {/* AQU-2112: health scores a translation's TEXT, so an audio-only
          chapter gets no health line rather than a line about text it does
          not have. A chapter with both keeps the line it had. */}
      {view === "audio" ? null : visual.score !== undefined && visual.score < 100 ? (
        <p>{t("agentWorkspace.chapterMedianHealth", { score: Math.round(visual.score) })}</p>
      ) : visual.score === 100 ? (
        <p>{t("agentWorkspace.chapterAllValidated")}</p>
      ) : (
        <p>{t("agentWorkspace.chapterHealthUnmeasured")}</p>
      )}
      {issueCount > 0 && (
        <p className="font-medium text-amber-600 dark:text-amber-400">
          {t("agentWorkspace.automaticWarnings", { count: issueCount })}
        </p>
      )}
    </div>
  )
}

/** Default when a caller supplies no key. FileSectionGrid always passes a
 *  per-file key; sharing one bucket would leak collapse state between files. */
const DEFAULT_BOOK_COLLAPSE_KEY = "aquilla:sidebar:book-collapsed"

export function BookHealthSpine({
  chapters,
  onChapterClick,
  className,
  bookCollapseStorageKey = DEFAULT_BOOK_COLLAPSE_KEY,
}: {
  chapters: BookHealthChapter[]
  onChapterClick: (label: string) => void
  className?: string
  /**
   * AQU-1187: localStorage key holding the collapsed book ids for this file, so
   * a book folded shut stays shut across reloads the way corpus groups do.
   */
  bookCollapseStorageKey?: string
}) {
  const t = useT()
  const [expandedChapters, setExpandedChapters] = useState<Set<string>>(() => new Set())
  const { members: collapsedBooks, toggle: toggleBook } = usePersistedToggleSet(bookCollapseStorageKey)

  // AQU-1187: only a file that actually spans several books gets a tree. A
  // per-book file (USFM, Paratext) and any non-scripture file get null back and
  // render the flat spine they always have.
  const bookGroups = useMemo(() => groupChaptersByBook(chapters), [chapters])

  function renderChapter(chapter: BookHealthChapter) {
        const visual = chapterVisual(chapter)
        const figures = chapterFigures(chapter)
        const chapterCells = chapter.cells ?? []
        const isLong = chapterCells.length > COLLAPSED_CELL_LIMIT
        const isExpanded = expandedChapters.has(chapter.key)
        const visibleCells = isLong && !isExpanded
          ? chapterCells.slice(0, COLLAPSED_CELL_LIMIT)
          : chapterCells
        const columns = matrixColumns(visibleCells.length)
        return (
          <AppTooltip key={chapter.key} content={chapterTooltip(chapter, visual, t)} side="right" delay={250} className="max-w-xs">
            <div
              data-testid="book-health-chapter"
              data-chapter-label={chapter.label}
              data-health-score={visual.score === undefined ? undefined : Math.round(visual.score)}
              data-health-measured={visual.measured || undefined}
              className="group relative w-full rounded-lg text-[11px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
            >
              <button
                type="button"
                data-testid="book-health-chapter-link"
                aria-label={chapter.label}
                className="block w-full px-1 py-1.5 text-left"
                onClick={() => onChapterClick(chapter.label)}
              >
                <span className="flex min-w-0 items-baseline justify-between gap-2">
                  <span className="truncate font-medium text-foreground">{chapter.label}</span>
                  <span className="flex shrink-0 items-baseline gap-1 tabular-nums">
                    {figures.text !== null && <span data-progress-figure="text">{figures.text}</span>}
                    {figures.audio !== null && (
                      // AQU-2112: the audio figure is drawn in the palette's
                      // audio-validated tone, so a glance tells which unit a
                      // number is in when a file carries both.
                      <span data-progress-figure="audio" style={{ color: PROGRESS_COLOR.audioValidated }}>
                        {figures.audio}
                      </span>
                    )}
                  </span>
                </span>

                {visibleCells.length > 0 ? (
                  <span
                    data-testid="book-health-matrix"
                    className="mt-1 grid w-fit gap-[3px]"
                    style={{ gridTemplateColumns: `repeat(${columns}, 7px)` }}
                  >
                    {visibleCells.map((cell, cellIndex) => {
                      const tick = cellBucketVisual([cell])
                      // AQU-1083: an excluded heading is drawn HOLLOW rather
                      // than in a paler shade of the untranslated fill. The
                      // three filled stages are points on one "how done is
                      // this" scale, and a lighter fill just reads as a
                      // fainter point on it — exactly the wrong message. An
                      // outline is visibly not on the scale at all.
                      const excluded = cell.stage === "excluded"
                      return (
                        <span
                          key={cell.id}
                          data-testid="book-health-cell"
                          data-excluded={excluded || undefined}
                          role="img"
                          aria-label={cellDescription(cell, cellIndex)}
                          title={cellDescription(cell, cellIndex)}
                          className={cn(
                            "size-[7px] rounded-[1px]",
                            excluded && "ring-1 ring-inset ring-slate-400/50 dark:ring-slate-500/50",
                            tick.issue && "ring-1 ring-inset ring-amber-500",
                          )}
                          style={{ backgroundColor: excluded ? "transparent" : tick.color }}
                        />
                      )
                    })}
                  </span>
                ) : (
                  <span className="mt-0.5 block truncate text-[9px] text-muted-foreground/80">
                    {chapterProgressWords(chapter)}
                    {visual.measured && visual.score !== undefined && visual.score < 100
                      ? ` · health ${Math.round(visual.score)}`
                      : ""}
                  </span>
                )}
              </button>

              {isLong && (
                <button
                  type="button"
                  className="mb-1 ml-1 rounded px-1 py-0.5 text-[9px] font-medium text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
                  aria-expanded={isExpanded}
                  onClick={(event) => {
                    event.stopPropagation()
                    setExpandedChapters((current) => {
                      const next = new Set(current)
                      if (next.has(chapter.key)) next.delete(chapter.key)
                      else next.add(chapter.key)
                      return next
                    })
                  }}
                >
                  {isExpanded
                    ? "Show fewer cells"
                    : `Show ${chapterCells.length - COLLAPSED_CELL_LIMIT} more cells`}
                </button>
              )}
            </div>
          </AppTooltip>
        )
  }

  if (!bookGroups) {
    return (
      <div data-testid="book-health-spine" className={cn("py-1 pl-6 pr-1", className)}>
        {chapters.map(renderChapter)}
      </div>
    )
  }

  return (
    <div data-testid="book-health-spine" className={cn("py-1 pl-6 pr-1", className)}>
      {bookGroups.map((group) => {
        const isCollapsed = collapsedBooks.has(group.id)
        return (
          <div key={group.id} data-testid="book-health-book" data-book={group.id}>
            <button
              type="button"
              data-testid="book-health-book-toggle"
              aria-expanded={!isCollapsed}
              aria-label={
                isCollapsed
                  ? t("nav.fileList.expandGroup", { group: group.id })
                  : t("nav.fileList.collapseGroup", { group: group.id })
              }
              className="flex w-full items-center gap-1 rounded-lg px-1 py-1 text-start text-[11px] font-semibold text-foreground transition-colors hover:bg-accent/70"
              onClick={() => toggleBook(group.id)}
            >
              <ChevronDown className={cn("h-3 w-3 shrink-0", isCollapsed && "-rotate-90")} />
              <span className="truncate">{group.id}</span>
            </button>
            {!isCollapsed && group.chapters.map(renderChapter)}
          </div>
        )
      })}
    </div>
  )
}
