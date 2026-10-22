import type { BookHealthCell, BookHealthChapter } from "@/components/sidebar/BookHealthSpine"
import { progressViewFor, type MilestoneProgressView } from "@/lib/progress/milestone-progress-view"

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
  /**
   * AQU-2112: the line's AUDIO state — `"audioValidated"` when every chosen
   * take meets the project's audio validation requirement, `"recorded"` when
   * it carries a take of its own that does not, and undefined when it carries
   * none. `"audioValidated"` implies recorded, so the caller reports the
   * stronger of the two and this builder counts it toward both figures.
   *
   * ABSENT means "audio is not counted here" — a text-only project passes no
   * reader and every number and colour below is byte-identical to what it
   * was before audio progress existed, including the second walk this
   * otherwise costs.
   */
  audioStage?(cellId: string): AudioCellStage | undefined
}

/** AQU-2112: a line's audio state, strongest first. */
export type AudioCellStage = "recorded" | "audioValidated"

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
      const nextChapters = new Map<string, ChapterEntry>()
      let anyChapterChanged = chapters.length !== last.length
      let membershipChanged = anyChapterChanged

      // AQU-2112: which figures this file shows is decided over the WHOLE
      // file before a single chapter is drawn — a file with recordings and no
      // target text shows audio alone, one with both shows text as before
      // plus audio — so the audio counts come first, in their own walk.
      //
      // That walk happens only when a reader was supplied, which is how a
      // text-only project pays nothing for audio progress and comes out of
      // here with exactly the chapters it did before: no second pass, no
      // audio figures on the chapter, no change of colour.
      const audioStage = readers.audioStage
      const audioCounts = audioStage
        ? chapters.map((source) => {
            let audioRecorded = 0
            let audioValidated = 0
            let textTranslated = 0
            for (const cellId of source.cellIds) {
              // The same exclusion the store's own fraction applies, so these
              // numerators sit over `source.total` honestly (AQU-1083/1424).
              if (readers.isExcluded?.(cellId) ?? false) continue
              const stage = audioStage(cellId)
              if (stage) audioRecorded++
              if (stage === "audioValidated") audioValidated++
              // TEXT ALONE — never the take that `source.translated` also
              // counts as translated (AQU-646). That distinction is the whole
              // per-file decision: without it an audio-only file reads as one
              // that has both and keeps the text figures that can never move.
              if (readers.getSummary(cellId)?.translated.trim()) textTranslated++
            }
            return { audioRecorded, audioValidated, textTranslated }
          })
        : null
      // The rule itself is AQU-2110's, shared so the sidebar and the chapter
      // picker can never disagree about which unit a file is measured in.
      const progressView: MilestoneProgressView | undefined = audioCounts
        ? progressViewFor(chapters.map((source, index) => ({
            translated: source.translated,
            validated: source.validated,
            total: source.total,
            ...audioCounts[index],
          })))
        : undefined

      const result = chapters.map((source, chapterIndex) => {
        const audio = audioCounts?.[chapterIndex]
        const prevChapter = chaptersByKey.get(source.key)
        if (!prevChapter) membershipChanged = true
        const cells: CellEntry[] = []
        let cellsChanged = !prevChapter || prevChapter.cells.length !== source.cellIds.length

        for (const cellId of source.cellIds) {
          const summary = readers.getSummary(cellId)
          if (!summary) continue
          const excluded = readers.isExcluded?.(cellId) ?? false
          // AQU-2112: in the audio view the square says whether the LINE IS
          // RECORDED and signed off. Its text stage can never move on a
          // language with no written form, so drawing it there reports every
          // finished line as untranslated. Any other view draws text, which
          // is why a file with both keeps the squares it always had, and a
          // line with no take still draws untranslated in the audio view.
          const audioCellStage = progressView === "audio" ? audioStage?.(cellId) : undefined
          const stage = excluded ? "excluded" as const : audioCellStage ?? cellStage(summary)
          // An excluded cell carries no health score: health measures how good
          // a translation is, and this one is not being scored at all. Neither
          // does an audio square — there is no text under it to score.
          const health = excluded || audioCellStage
            ? undefined
            : stage === "validated" ? 100 : readers.health(cellId)
          const hasIssue = readers.hasIssue(cellId)
          const prev = cellsById.get(cellId)
          const entry = prev && prev.stage === stage && prev.health === health && prev.hasIssue === hasIssue
            ? prev
            : { id: cellId, stage, health, hasIssue }
          if (entry !== prevChapter?.cells[cells.length]) cellsChanged = true
          if (cellId !== prevChapter?.cells[cells.length]?.id) membershipChanged = true
          if (entry !== prev) cellsById.set(cellId, entry)
          cells.push(entry)
        }
        if (prevChapter && cells.length !== prevChapter.cells.length) {
          cellsChanged = true
          membershipChanged = true
        }

        const reusable = prevChapter
          && !cellsChanged
          && prevChapter.chapter.label === source.label
          && prevChapter.chapter.translated === source.translated
          && prevChapter.chapter.validated === source.validated
          && prevChapter.chapter.total === source.total
          // AQU-2112: a take validated in this chapter, or the file crossing
          // from text into audio, has to invalidate the cached chapter too —
          // the figure beside the name is read from these.
          && prevChapter.chapter.progressView === progressView
          && prevChapter.chapter.audioRecorded === audio?.audioRecorded
          && prevChapter.chapter.audioValidated === audio?.audioValidated
        const chapter: BookHealthChapter = reusable
          ? prevChapter.chapter
          : {
              key: source.key,
              label: source.label,
              translated: source.translated,
              validated: source.validated,
              total: source.total,
              // Spread, not written as undefined: a text-only file's chapter
              // carries no audio keys at all, exactly as before.
              ...(audio
                ? {
                    audioRecorded: audio.audioRecorded,
                    audioValidated: audio.audioValidated,
                    progressView,
                  }
                : {}),
              cells,
            }
        const entry: ChapterEntry = reusable ? prevChapter : { chapter, cells }
        nextChapters.set(source.key, entry)
        if (chapter !== last[chapterIndex]) anyChapterChanged = true
        return chapter
      })

      // A health-only update changes a few entries, not chapter membership.
      // Avoid copying the whole file's cache; prune only after membership or
      // ordering changes, including a previously present summary disappearing.
      if (membershipChanged) {
        const retained = new Set(result.flatMap(chapter => chapter.cells?.map(cell => cell.id) ?? []))
        for (const id of cellsById.keys()) if (!retained.has(id)) cellsById.delete(id)
      }
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
