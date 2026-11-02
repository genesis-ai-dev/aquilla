import { useMemo, useState } from "react"
import { ChevronDown } from "lucide-react"
import { usePersistedToggleSet } from "@/hooks/useSidebarExpansion"
import { groupChaptersByBook } from "@/lib/sidebar/book-sections"
import { InfoNote } from "@/components/ui/info-note"
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
  /**
   * AQU-2159: the text under an `automatic` square is an AI draft nobody has
   * validated (the target's `ai_suggestion`). Drawn in the progress palette's
   * AI stripes; a line a person typed and nobody has validated yet is the
   * translated blue. Absent on every other square.
   */
  aiDrafted?: boolean
  /**
   * What the line holds, on a square drawn from its status in a language that
   * counts its recordings (Text and audio, or a language that delivers
   * nothing chosen yet but has recordings). The square only says started or
   * done; this lets its label say which part is there, so a line with only a
   * recording is not read out as translated. Absent on every other square.
   */
  lineParts?: {
    text: "none" | "typed" | "validated"
    audio: "none" | "recorded" | "approved"
  }
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
 * square the translated blue (it was amber at 0.28, which said "in review" in
 * a colour that means Due soon elsewhere).
 *
 * AQU-2159: and a square says ONLY progress. An AI draft nobody has validated
 * is the palette's AI stripes, the ones the Progress card and every progress
 * bar draw for AI drafts. It used to take the red-amber-green health tint of
 * its score, and a low score read as pink: the same family as a recorded
 * line in an audio language's grid, so the two grids side by side said "AI
 * draft" and "recorded" in one colour. Blue is text, magenta is audio, slate
 * is nothing yet. The score still reads out in the chapter tooltip, and the
 * amber ring still marks a line an automatic check flagged — on a line that
 * has text (`showsIssue`).
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

interface CellBucketVisual {
  /** The inline fill, or null when the square is drawn with the AI stripes. */
  color: string | null
  /**
   * AQU-2159: draw the shared `bg-progress-ai` stripes instead of a fill.
   * Stripes are a background-image, so a striped square takes no inline
   * background colour at all. AQU-2164: only an AI draft is striped.
   */
  stripes: boolean
  issue: boolean
}

/**
 * AQU-2159: whether a square draws the amber "an automatic check flagged
 * this line" ring. Only a line with text has anything to flag: an
 * untranslated line is flagged for being empty, which its slate already
 * says, and ringing every one of them buried the few flags worth reading.
 * Whether text sits under the line is decided where the flag is read
 * (`chapter-health.ts` sets `hasIssue` only on a line whose text is not
 * empty), not from the stage here: an audio square's stage reports a take,
 * so a recorded line with text can still carry a flag. The stage check below
 * keeps an untranslated or excluded square clear whoever builds the cells.
 */
function showsIssue(cell: BookHealthCell): boolean {
  return Boolean(cell.hasIssue) && cell.stage !== "untranslated" && cell.stage !== "excluded"
}

/*
 * AQU-2159: THE GRID CARRIES PROGRESS, NOT QUALITY. A drafted line nobody
 * had validated was tinted by its health score, and at 7px a low score reads
 * as pink — near enough to the magenta of a recorded take that a Text
 * language's weak drafts and an Audio language's recordings looked alike
 * (Sam, Oct 24). An AI draft nobody has validated is now drawn with the same
 * stripes the Progress card and the progress bars already use for AI
 * drafts, which leaves the grid three colour families — blue for text,
 * magenta for audio, grey for nothing yet — and no score-dependent colour
 * anywhere in it.
 *
 * AQU-2164: ONLY an AI draft. The `automatic` stage means "has text, nobody
 * has validated it", whoever wrote it, so striping every such square drew a
 * person's own typed translation as an AI draft. A line a person typed is
 * the translated blue, as the Progress card and the bars already say.
 *
 * The score is not lost, it has moved: it stays in the chapter's "N
 * automatic warnings" line, in the chapter tooltip's median, and in the
 * check drawer. Note there is deliberately NO branch on `health` here —
 * drawing a scored draft differently from an unscored one is exactly what
 * made the colour mean quality.
 */
function cellBucketVisual(cells: BookHealthCell[]): CellBucketVisual {
  const issue = cells.some(showsIssue)
  const audio = audioBucketColor(cells)
  if (audio) return { color: audio, stripes: false, issue }

  const validated = cells.filter((cell) => cell.stage === "validated").length
  if (validated === cells.length) {
    return { color: PROGRESS_COLOR.textValidated, stripes: false, issue }
  }
  if (validated > 0) {
    // A bucket of several cells, partly validated: the validated blue at the
    // validated share's strength.
    return {
      color: progressColorAt(PROGRESS_COLOR.textValidated, 0.25 + (0.55 * validated / cells.length)),
      stripes: false,
      issue,
    }
  }
  const automatic = cells.filter((cell) => cell.stage === "automatic")
  if (automatic.some((cell) => cell.aiDrafted)) return { color: null, stripes: true, issue }
  if (automatic.length > 0) return { color: PROGRESS_COLOR.textTranslated, stripes: false, issue }
  return { color: "rgb(148 163 184 / 0.2)", stripes: false, issue }
}

/** Both halves of a line, the part that is there first. */
function linePartsLabel(parts: NonNullable<BookHealthCell["lineParts"]>, aiDrafted: boolean): string {
  const text = parts.text === "validated"
    ? "text validated"
    : parts.text === "typed"
      ? (aiDrafted ? "AI draft, not validated yet" : "translated, not validated yet")
      : "no text yet"
  const audio = parts.audio === "approved"
    ? "recording approved"
    : parts.audio === "recorded" ? "recorded, not validated yet" : "not recorded yet"
  return parts.text === "none" ? `${audio}; ${text}` : `${text}; ${audio}`
}

function cellDescription(cell: BookHealthCell, index: number): string {
  const prefix = `Cell ${index + 1}`
  // AQU-2159: announced in exactly the places the amber ring is drawn, so
  // the label and the square cannot disagree.
  const warning = showsIssue(cell) ? " · automatic warning" : ""
  // Says WHY it is grey. Without this the square is indistinguishable from a
  // faint untranslated one to anyone reading it with a screen reader.
  if (cell.stage === "excluded") return `${prefix}: heading — not counted toward progress${warning}`
  // AQU-2112: an audio square announces the TAKE. Without this a signed-off
  // recording was read out as "untranslated", which is the bug in words.
  if (cell.stage === "audioValidated") return `${prefix}: audio validated${warning}`
  if (cell.stage === "recorded") return `${prefix}: recorded, awaiting audio validation${warning}`
  if (cell.lineParts && (cell.stage === "validated" || cell.stage === "automatic")) {
    return `${prefix}: ${linePartsLabel(cell.lineParts, cell.aiDrafted === true)}${warning}`
  }
  if (cell.stage === "validated") return `${prefix}: human validated${warning}`
  // AQU-2159: says what the square shows. It read out a health score the
  // square no longer draws, and never said the line was an AI draft.
  if (cell.stage === "automatic") {
    return cell.aiDrafted
      ? `${prefix}: AI draft, not validated yet${warning}`
      : `${prefix}: translated, not validated yet${warning}`
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

/**
 * The "x translated · y recorded" line under a chapter with no square map.
 *
 * AQU-2112: both halves are keyed. The translated half was two unkeyed
 * literals in the JSX above (carried as suppressed i18n debt); it had to be
 * touched to make room for the audio half, and a word a reader sees is not
 * made translatable by moving it into a function, so it got a key instead.
 */
function chapterProgressWords(chapter: BookHealthChapter, t: TFunction): string {
  const view = viewOf(chapter)
  const parts: string[] = []
  if (view !== "audio") {
    parts.push(chapter.percentagesOnly
      ? t("agentWorkspace.chapterPercentTranslated", { translated: chapter.translated })
      : t("agentWorkspace.chapterCountTranslated", { translated: chapter.translated, total: chapter.total }))
  }
  if (view !== "text") {
    const recorded = chapter.audioRecorded ?? 0
    parts.push(chapter.percentagesOnly
      ? t("agentWorkspace.chapterPercentRecorded", { recorded })
      : t("agentWorkspace.chapterCountRecorded", { recorded, total: chapter.total }))
  }
  return parts.join(" · ")
}

function chapterNote(chapter: BookHealthChapter, visual: ChapterVisual, t: TFunction) {
  const issueCount = chapter.cells?.filter(showsIssue).length ?? 0
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
          <div
              key={chapter.key}
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
                className="block w-full py-1.5 pl-1 pr-5 text-left"
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
                      // AQU-2159: the hollow heading wins over the stripes —
                      // an excluded cell is an outline with no fill at all.
                      const aiDraft = tick.stripes && !excluded
                      return (
                        <span
                          key={cell.id}
                          data-testid="book-health-cell"
                          data-excluded={excluded || undefined}
                          data-ai-draft={aiDraft || undefined}
                          role="img"
                          aria-label={cellDescription(cell, cellIndex)}
                          className={cn(
                            "size-[7px] rounded-[1px]",
                            aiDraft && "bg-progress-ai",
                            excluded && "ring-1 ring-inset ring-slate-400/50 dark:ring-slate-500/50",
                            tick.issue && "ring-1 ring-inset ring-amber-500",
                          )}
                          style={aiDraft ? undefined : { backgroundColor: excluded ? "transparent" : tick.color ?? undefined }}
                        />
                      )
                    })}
                  </span>
                ) : (
                  <span className="mt-0.5 block truncate text-[9px] text-muted-foreground/80">
                    {chapterProgressWords(chapter, t)}
                    {visual.measured && visual.score !== undefined && visual.score < 100
                      ? ` · health ${Math.round(visual.score)}`
                      : ""}
                  </span>
                )}
              </button>

              {/* AQU-2260 third pass: the chapter's numbers open from an (i) on
                  click. They used to float over the editor on hover. The (i)
                  sits outside the chapter button, so opening it never navigates. */}
              <InfoNote
                label={t("common.aboutAria", { name: chapter.label })}
                testId="book-health-chapter-info"
                side="right"
                className="absolute right-0.5 top-1.5 text-muted-foreground/50 group-hover:text-muted-foreground"
                iconClassName="h-3 w-3"
              >
                {chapterNote(chapter, visual, t)}
              </InfoNote>

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
