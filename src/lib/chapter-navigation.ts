import { effectiveSourceText } from "@/lib/cell-text"
import type { ChapterCompletionTrigger } from "@/lib/parsers/types"

export interface ChapterRowBounds {
  index: number
  top: number
  bottom: number
}

function normalizeChapterHeading(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
}

export function rowMatchesChapterHeading(
  values: readonly (string | null | undefined)[],
  chapterDisplayLabel: string,
): boolean {
  const expected = normalizeChapterHeading(chapterDisplayLabel)
  return expected.length > 0 && values.some(
    (value) => normalizeChapterHeading(value ?? "") === expected,
  )
}

/** Find the top rendered row that crosses into the list's visible content area. */
export function firstActuallyVisibleIndex(
  rows: readonly ChapterRowBounds[],
  viewportTop: number,
  fallbackIndex: number,
): number {
  let visibleIndex = fallbackIndex
  let nearestTop = Number.POSITIVE_INFINITY

  for (const row of rows) {
    if (row.bottom <= viewportTop + 1 || row.top >= nearestTop) continue
    visibleIndex = row.index
    nearestTop = row.top
  }

  return visibleIndex
}

/** Resolve the section at the viewport's actual top edge. */
export function sectionLabelAtViewportStart(
  cellIds: readonly string[],
  firstVisibleIndex: number,
  getSectionLabel: (cellId: string) => string,
): string {
  const cellId = cellIds[firstVisibleIndex]
  return cellId ? getSectionLabel(cellId) : ""
}

/**
 * Keep an explicit picker/arrow selection authoritative until the user takes
 * over scrolling. This matters for a short final chapter whose first row
 * cannot physically reach the viewport's top edge.
 */
export function resolveActiveChapterLabel(
  chapterLabels: readonly string[],
  viewportLabel: string,
  selectedLabel: string | null,
): string {
  if (selectedLabel && chapterLabels.includes(selectedLabel)) return selectedLabel
  if (chapterLabels.includes(viewportLabel)) return viewportLabel
  return chapterLabels[0] ?? ""
}

/** One navigator destination: a milestone, optionally narrowed to a cell range. */
export interface ChapterPageNavigationEntry {
  key: string
  cellIds: readonly string[]
  subsections?: readonly { key: string; cellIds: readonly string[] }[]
}

/**
 * AQU-1087: which navigator page the editor should show.
 *
 * When paging is off, this is the existing viewport-tracking rule. When paging
 * is on, the picker/arrows are the source of truth — a missing selection falls
 * back to the caller's viewport key so turning the setting on keeps the chapter
 * the user was already looking at (that viewport key must still index the
 * *full* file on that first frame).
 */
export function resolveChapterPageKey(args: {
  pagingEnabled: boolean
  navigationKeys: readonly string[]
  selectedKey: string | null
  viewportKey: string
}): string {
  if (!args.pagingEnabled) {
    return resolveActiveChapterLabel(args.navigationKeys, args.viewportKey, args.selectedKey)
  }
  if (args.selectedKey && args.navigationKeys.includes(args.selectedKey)) {
    return args.selectedKey
  }
  if (args.navigationKeys.includes(args.viewportKey)) return args.viewportKey
  return args.navigationKeys[0] ?? ""
}

/**
 * AQU-1087: drop a persisted last-chapter if this file no longer has that
 * milestone (reimport, different book). Keep the chapter and drop only the
 * subsection when the range split changed.
 */
export function validStoredChapterPage(
  navigation: readonly { key: string; subsections?: readonly { key: string }[] }[],
  stored: { key: string; subsectionKey?: string } | null | undefined,
): { key: string; subsectionKey?: string } | null {
  if (!stored) return null
  const entry = navigation.find((candidate) => candidate.key === stored.key)
  if (!entry) return null
  if (!stored.subsectionKey) return { key: entry.key }
  const subsection = entry.subsections?.find((candidate) => candidate.key === stored.subsectionKey)
  return subsection
    ? { key: entry.key, subsectionKey: subsection.key }
    : { key: entry.key }
}

/**
 * AQU-1087: the cell ids that belong in the editor table for one chapter page.
 * Full-file order is preserved; paging off returns `allCellIds` unchanged.
 */
export function cellIdsForChapterPage(args: {
  pagingEnabled: boolean
  allCellIds: readonly string[]
  navigation: readonly ChapterPageNavigationEntry[]
  pageKey: string
  subsectionKey?: string | null
}): readonly string[] {
  if (!args.pagingEnabled || args.navigation.length === 0) return args.allCellIds
  const entry = args.navigation.find((candidate) => candidate.key === args.pageKey)
    ?? args.navigation[0]
  if (!entry) return args.allCellIds
  if (args.subsectionKey) {
    const subsection = entry.subsections?.find((candidate) => candidate.key === args.subsectionKey)
    if (subsection) return subsection.cellIds
  }
  return entry.cellIds
}

/** Which navigator page contains `cellId`, for search/presence jumps under paging. */
export function milestonePageForCell(
  navigation: readonly ChapterPageNavigationEntry[],
  cellId: string,
): { key: string; subsectionKey?: string } | null {
  for (const entry of navigation) {
    for (const subsection of entry.subsections ?? []) {
      if (subsection.cellIds.includes(cellId)) {
        return { key: entry.key, subsectionKey: subsection.key }
      }
    }
    if (entry.cellIds.includes(cellId)) return { key: entry.key }
  }
  return null
}

/**
 * AQU-1087: keep file-wide work (TTS, export) on `null`, and restrict
 * completions / validate / check / TAR / Autopilot to the open chapter page.
 * An empty array is "page not ready" — return nothing rather than the whole file.
 */
export function filterToChapterPage<T extends { id: string }>(
  cells: readonly T[],
  pageCellIds: readonly string[] | null,
): T[] {
  if (!pageCellIds) return [...cells]
  if (pageCellIds.length === 0) return []
  const allowed = new Set(pageCellIds)
  return cells.filter((cell) => allowed.has(cell.id))
}

/** Same tallies as useHealth's fileProgress, over a chapter-page subset. */
export function chapterPageProgress(
  cells: readonly { status: string }[],
): { translated: number; validated: number; total: number } {
  let translated = 0
  let validated = 0
  for (const cell of cells) {
    if (cell.status !== "empty") translated++
    if (cell.status === "validated") validated++
  }
  return { translated, validated, total: cells.length }
}

export interface ChapterPageDestination {
  key: string
  label: string
  subsectionKey?: string
}

type ChapterPageWorkCell = {
  original: string
  translated: string
  status: string
  medium?: import("@/lib/sync/cells-read-types").SegmentMedium | null
  transcription?: string
}

/**
 * Cells that count toward "this chapter is done". Rows with no source (empty
 * headings, untranscribed media) are skipped — they are not verses to finish.
 */
export function chapterPageWorkCells<T extends ChapterPageWorkCell>(cells: readonly T[]): T[] {
  return cells.filter((cell) => effectiveSourceText(cell).trim().length > 0)
}

/** True when the open page meets the project's completion trigger. */
export function isChapterPageComplete(args: {
  cells: readonly ChapterPageWorkCell[]
  trigger: ChapterCompletionTrigger
}): boolean {
  if (args.trigger === "manual") return false
  const work = chapterPageWorkCells(args.cells)
  if (work.length === 0) return false
  if (args.trigger === "allValidated") {
    return work.every((cell) => cell.status === "validated")
  }
  return work.every((cell) => cell.status !== "empty" && cell.translated.trim().length > 0)
}

export function flattenChapterDestinations(
  items: readonly {
    key: string
    label: string
    subsections?: readonly { key: string }[]
  }[],
): ChapterPageDestination[] {
  return items.flatMap((item) => (
    item.subsections?.length
      ? item.subsections.map((subsection) => ({
          key: item.key,
          label: item.label,
          subsectionKey: subsection.key,
        }))
      : [{ key: item.key, label: item.label }]
  ))
}

export function nextChapterDestination(
  destinations: readonly ChapterPageDestination[],
  currentKey: string,
  currentSubsectionKey?: string | null,
): ChapterPageDestination | null {
  const index = destinations.findIndex((destination) => (
    destination.key === currentKey
    && (
      destination.subsectionKey === currentSubsectionKey
      || (!destination.subsectionKey && !currentSubsectionKey)
    )
  ))
  if (index < 0 || index >= destinations.length - 1) return null
  return destinations[index + 1] ?? null
}
