import type { BookHealthCell, BookHealthChapter } from "@/components/sidebar/BookHealthSpine"

/** A navigation-index chapter: the fields the sidebar's chapter map reads. */
export interface ChapterHealthSource {
  key: string
  label: string
  translated: number
  validated: number
  total: number
  cellIds: readonly string[]
}

export interface ChapterHealthReaders {
  getSummary(cellId: string): { status: string; translated: string } | null | undefined
  health(cellId: string): number | undefined
  hasIssue(cellId: string): boolean
  /**
   * AQU-1083: true for a heading in a project that excludes headings from
   * progress. The chapter's own translated/validated/total already leave
   * these out — the store computes them — so this only decides how the
   * square is drawn. Absent ⇒ nothing is excluded.
   */
  isExcluded?(cellId: string): boolean
}

export interface ChapterHealthBuilder {
  /**
   * Chapter map for the sidebar. Cells and chapters whose derived values are
   * unchanged since the previous build keep their previous object identity, and
   * when nothing changed at all the previous array is returned.
   */
  build(chapters: readonly ChapterHealthSource[], readers: ChapterHealthReaders): BookHealthChapter[]
  clear(): void
}

interface CellEntry extends BookHealthCell {
  stage: BookHealthCell["stage"]
}

interface ChapterEntry {
  chapter: BookHealthChapter
  cells: CellEntry[]
}

function cellStage(summary: { status: string; translated: string }): BookHealthCell["stage"] {
  return summary.status === "validated"
    ? "validated"
    : summary.status === "empty" || !summary.translated.trim()
      ? "untranslated"
      : "automatic"
}

/**
 * AQU-1104: the workspace rebuilt the whole chapter map from all cell
 * summaries on every cell store version bump (a fresh Map of 30k summaries,
 * then a fresh object per cell), and the new identities forced the sidebar's
 * chapter grid to re-render on every commit. This builder walks the same
 * cells but allocates only for cells and chapters whose values changed.
 */
export function createChapterHealthBuilder(): ChapterHealthBuilder {
  let cellsById = new Map<string, CellEntry>()
  let chaptersByKey = new Map<string, ChapterEntry>()
  let last: BookHealthChapter[] = []

  return {
    build(chapters, readers) {
      const nextCells = new Map<string, CellEntry>()
      const nextChapters = new Map<string, ChapterEntry>()
      let anyChapterChanged = chapters.length !== last.length

      const result = chapters.map((source, chapterIndex) => {
        const prevChapter = chaptersByKey.get(source.key)
        const cells: CellEntry[] = []
        let cellsChanged = !prevChapter || prevChapter.cells.length !== source.cellIds.length

        for (const cellId of source.cellIds) {
          const summary = readers.getSummary(cellId)
          if (!summary) continue
          const excluded = readers.isExcluded?.(cellId) ?? false
          const stage = excluded ? "excluded" as const : cellStage(summary)
          // An excluded cell carries no health score: health measures how good
          // a translation is, and this one is not being scored at all.
          const health = excluded ? undefined : stage === "validated" ? 100 : readers.health(cellId)
          const hasIssue = readers.hasIssue(cellId)
          const prev = cellsById.get(cellId)
          const entry = prev && prev.stage === stage && prev.health === health && prev.hasIssue === hasIssue
            ? prev
            : { id: cellId, stage, health, hasIssue }
          if (entry !== prevChapter?.cells[cells.length]) cellsChanged = true
          nextCells.set(cellId, entry)
          cells.push(entry)
        }
        if (prevChapter && cells.length !== prevChapter.cells.length) cellsChanged = true

        const reusable = prevChapter
          && !cellsChanged
          && prevChapter.chapter.label === source.label
          && prevChapter.chapter.translated === source.translated
          && prevChapter.chapter.validated === source.validated
          && prevChapter.chapter.total === source.total
        const chapter: BookHealthChapter = reusable
          ? prevChapter.chapter
          : {
              key: source.key,
              label: source.label,
              translated: source.translated,
              validated: source.validated,
              total: source.total,
              cells,
            }
        const entry: ChapterEntry = reusable ? prevChapter : { chapter, cells }
        nextChapters.set(source.key, entry)
        if (chapter !== last[chapterIndex]) anyChapterChanged = true
        return chapter
      })

      cellsById = nextCells
      chaptersByKey = nextChapters
      if (!anyChapterChanged) return last
      last = result
      return result
    },
    clear() {
      cellsById = new Map()
      chaptersByKey = new Map()
      last = []
    },
  }
}

const builderByOwner = new WeakMap<object, ChapterHealthBuilder>()

/**
 * The chapter-health builder for one cell store. The builder compares cells
 * by id and chapters by key, so a file switch inside the same store simply
 * replaces every entry on the next build; nothing from the old file survives.
 */
export function chapterHealthBuilderFor(store: object): ChapterHealthBuilder {
  let builder = builderByOwner.get(store)
  if (!builder) {
    builder = createChapterHealthBuilder()
    builderByOwner.set(store, builder)
  }
  return builder
}
