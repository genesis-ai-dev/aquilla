import { useState } from "react"
import { AppTooltip } from "@/components/ui/tooltip"
import { healthRibbonColor, healthRibbonOpacity } from "@/lib/health/health-ribbon"
import { cn } from "@/lib/utils"

export interface BookHealthCell {
  id: string
  stage: "untranslated" | "automatic" | "validated"
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

function chapterVisual(chapter: BookHealthChapter): ChapterVisual {
  if (chapter.total > 0 && chapter.validated >= chapter.total) {
    return { color: healthRibbonColor(100, 1), score: 100, opacity: 1, measured: true }
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
    // this chapter. Amber says "in review" without inventing a score.
    return { color: "rgb(245 158 11 / 0.3)", opacity: 0.3, measured: false }
  }

  if (chapter.validated > 0) {
    const ratio = chapter.total > 0 ? chapter.validated / chapter.total : 0
    const opacity = 0.28 + (0.52 * ratio)
    return { color: healthRibbonColor(100, opacity), opacity, measured: false }
  }

  return { color: "rgb(148 163 184 / 0.22)", opacity: 0.22, measured: false }
}

function matrixColumns(cellCount: number): number {
  if (cellCount <= 0) return 1
  return Math.min(MAX_MATRIX_COLUMNS, cellCount)
}

function cellBucketVisual(cells: BookHealthCell[]): { color: string; issue: boolean } {
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
      color: healthRibbonColor(100, 1),
      issue: cells.some((cell) => cell.hasIssue),
    }
  }
  if (validated > 0) {
    return {
      color: healthRibbonColor(100, 0.25 + (0.55 * validated / cells.length)),
      issue: cells.some((cell) => cell.hasIssue),
    }
  }
  if (cells.some((cell) => cell.stage === "automatic")) {
    return {
      color: "rgb(245 158 11 / 0.28)",
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
  if (cell.stage === "validated") return `${prefix}: human validated${warning}`
  if (cell.stage === "automatic") {
    return cell.health === undefined
      ? `${prefix}: automatic health awaiting evidence${warning}`
      : `${prefix}: automatic health ${Math.round(cell.health)}%${warning}`
  }
  return `${prefix}: untranslated${warning}`
}

function chapterTooltip(chapter: BookHealthChapter, visual: ChapterVisual) {
  const issueCount = chapter.cells?.filter((cell) => cell.hasIssue).length ?? 0
  const untranslated = Math.max(0, chapter.total - chapter.translated)
  const automatic = Math.max(0, chapter.translated - chapter.validated)
  return (
    <div className="space-y-1">
      <p className="font-medium">{chapter.label}</p>
      {chapter.percentagesOnly ? (
        <p>{chapter.validated}% validated · {chapter.translated}% translated</p>
      ) : (
        <p>{chapter.validated} validated · {automatic} awaiting validation · {untranslated} untranslated</p>
      )}
      {visual.score !== undefined && visual.score < 100 ? (
        <p>Median automatic health: {Math.round(visual.score)}%. This excludes validated cells.</p>
      ) : visual.score === 100 ? (
        <p>Every cell in this chapter is human validated.</p>
      ) : (
        <p>Automatic health has not been measured here; only progress is shown.</p>
      )}
      {issueCount > 0 && (
        <p className="font-medium text-amber-600 dark:text-amber-400">
          {issueCount} automatic warning{issueCount === 1 ? "" : "s"}
        </p>
      )}
    </div>
  )
}

export function BookHealthSpine({
  chapters,
  onChapterClick,
  className,
}: {
  chapters: BookHealthChapter[]
  onChapterClick: (label: string) => void
  className?: string
}) {
  const [expandedChapters, setExpandedChapters] = useState<Set<string>>(() => new Set())
  const visuals = chapters.map(chapterVisual)

  return (
    <div data-testid="book-health-spine" className={cn("py-1 pl-6 pr-1", className)}>
      {chapters.map((chapter, index) => {
        const visual = visuals[index]
        const chapterCells = chapter.cells ?? []
        const isLong = chapterCells.length > COLLAPSED_CELL_LIMIT
        const isExpanded = expandedChapters.has(chapter.key)
        const visibleCells = isLong && !isExpanded
          ? chapterCells.slice(0, COLLAPSED_CELL_LIMIT)
          : chapterCells
        const columns = matrixColumns(visibleCells.length)
        return (
          <AppTooltip key={chapter.key} content={chapterTooltip(chapter, visual)} side="right" delay={250} className="max-w-xs">
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
                  <span className="shrink-0 tabular-nums">
                    {chapter.percentagesOnly ? `${chapter.validated}%` : `${chapter.validated}/${chapter.total}`}
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
                      return (
                        <span
                          key={cell.id}
                          data-testid="book-health-cell"
                          role="img"
                          aria-label={cellDescription(cell, cellIndex)}
                          title={cellDescription(cell, cellIndex)}
                          className={cn(
                            "size-[7px] rounded-[1px]",
                            tick.issue && "ring-1 ring-inset ring-amber-500",
                          )}
                          style={{ backgroundColor: tick.color }}
                        />
                      )
                    })}
                  </span>
                ) : (
                  <span className="mt-0.5 block truncate text-[9px] text-muted-foreground/80">
                    {chapter.percentagesOnly
                      ? `${chapter.translated}% translated`
                      : `${chapter.translated}/${chapter.total} translated`}
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
      })}
    </div>
  )
}
