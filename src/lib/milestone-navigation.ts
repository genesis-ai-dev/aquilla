import { getBookName } from "@/lib/file-labeling/bible-book-names"
import {
  FALLBACK_MILESTONE_SIZE,
  TIMELINE_MILESTONE_MS,
} from "@/lib/import/milestones"
import type { ImportMilestone, ImportMilestoneKind } from "../../shared/import-contract"

export interface MilestoneNavigationCell {
  id: string
  original: string
  type?: string | null
  canonicalRef?: string | null
  startMs?: number
  metadata?: Record<string, unknown> | null
}

export interface DerivedMilestoneNavigation {
  milestoneByCellId: ReadonlyMap<string, ImportMilestone>
  orderedMilestones: readonly {
    milestone: ImportMilestone
    firstCellId: string
    firstIndex: number
    cellIds: readonly string[]
  }[]
}

/** Read only the validated generic envelope; arbitrary metadata is ignored. */
export function readImportMilestone(
  metadata: Record<string, unknown> | null | undefined,
): ImportMilestone | undefined {
  const envelope = record(metadata?.aquillaImport)
  return milestone(envelope?.milestone)
}

/**
 * Build navigation in the caller's display order. New imports use persisted
 * assignments; legacy imports derive from canonical refs, normalized addresses,
 * Biblica metadata, structural headings, timing, then deterministic parts.
 */
export function deriveMilestoneNavigation(
  cells: readonly MilestoneNavigationCell[],
): DerivedMilestoneNavigation {
  const seeds = cells.map(legacyMilestoneSeed)
  const scriptureMode = seeds.some((seed) => (
    seed?.key.startsWith("scripture:") || seed?.key.startsWith("story:OBS:")
  ))
  const fallback = fallbackMilestones(cells)
  const resolved: ImportMilestone[] = new Array(cells.length)

  if (scriptureMode) {
    const nextScripture: (ImportMilestone | undefined)[] = new Array(cells.length)
    let next: ImportMilestone | undefined
    for (let index = cells.length - 1; index >= 0; index -= 1) {
      const seed = seeds[index]
      if (isScriptureMilestone(seed)) next = seed
      nextScripture[index] = next
    }
    let previous: ImportMilestone | undefined
    for (let index = 0; index < cells.length; index += 1) {
      const seed = seeds[index]
      if (isScriptureMilestone(seed)) previous = seed
      const structural = cells[index]?.type === "heading" || cells[index]?.type === "paratext"
      resolved[index] = isScriptureMilestone(seed)
        ? seed
        : structural
          ? nextScripture[index] ?? previous ?? fallback[index]!
          : previous ?? nextScripture[index] ?? fallback[index]!
    }
  } else if (seeds.some(Boolean)) {
    const nextSeed: (ImportMilestone | undefined)[] = new Array(cells.length)
    let next: ImportMilestone | undefined
    for (let index = cells.length - 1; index >= 0; index -= 1) {
      if (seeds[index]) next = seeds[index]
      nextSeed[index] = next
    }
    const firstSeedIndex = seeds.findIndex(Boolean)
    const startMilestone: ImportMilestone | undefined = seeds[firstSeedIndex]?.kind === "section"
      ? { key: "section:start", kind: "section", label: "Start", shortLabel: "S" }
      : undefined
    let current: ImportMilestone | undefined
    for (let index = 0; index < cells.length; index += 1) {
      if (seeds[index]) current = seeds[index]
      resolved[index] = current
        ?? (index < firstSeedIndex ? startMilestone : undefined)
        ?? nextSeed[index]
        ?? fallback[index]!
    }
  } else {
    for (let index = 0; index < cells.length; index += 1) {
      resolved[index] = fallback[index]!
    }
  }

  const milestoneByCellId = new Map<string, ImportMilestone>()
  const groups = new Map<string, {
    milestone: ImportMilestone
    firstCellId: string
    firstIndex: number
    cellIds: string[]
  }>()
  cells.forEach((cell, index) => {
    const assignment = resolved[index]!
    milestoneByCellId.set(cell.id, assignment)
    const existing = groups.get(assignment.key)
    if (existing) {
      existing.cellIds.push(cell.id)
    } else {
      groups.set(assignment.key, {
        milestone: assignment,
        firstCellId: cell.id,
        firstIndex: index,
        cellIds: [cell.id],
      })
    }
  })

  return {
    milestoneByCellId,
    orderedMilestones: [...groups.values()],
  }
}

function legacyMilestoneSeed(cell: MilestoneNavigationCell): ImportMilestone | undefined {
  const persisted = readImportMilestone(cell.metadata)
  if (persisted) return persisted

  const biblica = milestoneFromBiblica(cell.metadata)
  if (biblica) return biblica

  const canonical = scriptureMilestone(cell.canonicalRef)
  if (canonical) return canonical

  const envelope = record(cell.metadata?.aquillaImport)
  const address = record(envelope?.address)
  const addressScheme = string(address?.scheme)
  if (addressScheme === "scripture" || addressScheme === "scripture-structure") {
    const book = string(address?.book)
    const chapter = integer(address?.chapter)
    if (book && chapter !== undefined) return chapterMilestone(book, chapter)
  }
  if (addressScheme === "timeline") {
    const startMs = number(address?.startMs)
    return timelineMilestone(startMs)
  }
  if (addressScheme === "document") {
    const memberPath = string(address?.memberPath)
    if (memberPath) {
      const slide = memberPath.match(/slide(\d+)\.xml/i)?.[1]
      if (slide) {
        return {
          key: `slide:${memberPath}`,
          kind: "slide",
          label: `Slide ${slide}`,
          shortLabel: slide,
        }
      }
      const locator = record(envelope?.sourceLocator)
      if (locator?.kind === "idml") {
        const story = string(locator.storyId) ?? memberPath
        return {
          key: `story:${memberPath}:${story}`,
          kind: "story",
          label: friendlyMemberLabel(memberPath, "Story"),
          shortLabel: shortOrdinal(memberPath),
        }
      }
      return {
        key: `group:${memberPath}`,
        kind: "group",
        label: friendlyMemberLabel(memberPath, "Group"),
        shortLabel: shortOrdinal(memberPath),
      }
    }
  }

  const kind = string(envelope?.kind) ?? cell.type ?? undefined
  if (kind === "heading") {
    const unitKey = string(envelope?.unitKey) ?? cell.id
    return {
      key: `section:${unitKey}`,
      kind: "section",
      label: compactLabel(cell.original) || "Section",
      shortLabel: "§",
    }
  }

  if (cell.startMs !== undefined) return timelineMilestone(cell.startMs)
  return undefined
}

function milestoneFromBiblica(
  metadata: Record<string, unknown> | null | undefined,
): ImportMilestone | undefined {
  const biblica = record(metadata?.biblica)
  const chapter = string(biblica?.chapterLabel)
  if (!chapter) return undefined
  // A division heading ("Stories about Jesus") introduces a group of books, so
  // its section is titled by the heading alone and belongs to no book.
  if (string(biblica?.sectionKind) === "division") {
    return { key: `biblica:division:${chapter}`, kind: "section", label: chapter, shortLabel: "§" }
  }
  const book = string(biblica?.bookCode)?.toUpperCase()
  const bookName = book ? getBookName(book) ?? book : undefined
  const displayChapter = chapter === "Preface" ? chapter : chapter.replace("-", "–")
  const kind: ImportMilestoneKind = chapter === "Preface"
    ? "preface"
    : chapter.includes("-")
      ? "chapter-range"
      : "chapter"
  return {
    key: `biblica:${book ?? "unknown"}:${chapter}`,
    kind,
    label: bookName ? `${bookName} ${displayChapter}` : displayChapter,
    shortLabel: chapter === "Preface" ? "P" : displayChapter,
  }
}

function scriptureMilestone(value: string | null | undefined): ImportMilestone | undefined {
  const match = value?.trim().match(/^([1-3]?[A-Z]{2,3})\s+(\d+)(?::.+)?$/i)
  if (!match) return undefined
  const book = match[1]!.toUpperCase()
  const chapter = Number(match[2])
  if (book === "OBS") {
    return {
      key: `story:OBS:${chapter}`,
      kind: "story",
      label: `Story ${chapter}`,
      shortLabel: String(chapter),
    }
  }
  return chapterMilestone(book, chapter)
}

function chapterMilestone(book: string, chapter: number): ImportMilestone {
  const normalizedBook = book.toUpperCase()
  return {
    key: `scripture:${normalizedBook}:${chapter}`,
    kind: "chapter",
    label: `${getBookName(normalizedBook) ?? normalizedBook} ${chapter}`,
    shortLabel: String(chapter),
  }
}

function timelineMilestone(startMs: number | undefined): ImportMilestone {
  if (startMs === undefined) {
    return { key: "time:untimed", kind: "time-range", label: "Untimed", shortLabel: "—" }
  }
  const bucketStart = Math.floor(startMs / TIMELINE_MILESTONE_MS) * TIMELINE_MILESTONE_MS
  const bucketEnd = bucketStart + TIMELINE_MILESTONE_MS
  return {
    key: `time:${bucketStart}`,
    kind: "time-range",
    label: `${formatClock(bucketStart)}–${formatClock(bucketEnd)}`,
    shortLabel: `${Math.floor(bucketStart / 60_000)}–${Math.floor(bucketEnd / 60_000)}m`,
  }
}

function fallbackMilestones(cells: readonly MilestoneNavigationCell[]): ImportMilestone[] {
  const assignments: ImportMilestone[] = []
  for (let index = 0; index < cells.length; index += FALLBACK_MILESTONE_SIZE) {
    const part = Math.floor(index / FALLBACK_MILESTONE_SIZE) + 1
    const value: ImportMilestone = {
      key: `part:${cells[index]?.id ?? part}`,
      kind: "part",
      label: `Part ${part}`,
      shortLabel: String(part),
    }
    for (
      let member = index;
      member < Math.min(index + FALLBACK_MILESTONE_SIZE, cells.length);
      member += 1
    ) {
      assignments[member] = value
    }
  }
  return assignments
}

function isScriptureMilestone(value: ImportMilestone | undefined): value is ImportMilestone {
  return Boolean(
    value
    && (value.key.startsWith("scripture:") || value.key.startsWith("story:OBS:")),
  )
}

function milestone(value: unknown): ImportMilestone | undefined {
  const candidate = record(value)
  const key = string(candidate?.key)
  const kind = string(candidate?.kind)
  const label = string(candidate?.label)
  const shortLabel = string(candidate?.shortLabel)
  if (!key || !label || !shortLabel || !isMilestoneKind(kind)) return undefined
  return { key, kind, label, shortLabel }
}

function isMilestoneKind(value: string | undefined): value is ImportMilestoneKind {
  return value === "chapter"
    || value === "chapter-range"
    || value === "preface"
    || value === "story"
    || value === "slide"
    || value === "section"
    || value === "time-range"
    || value === "group"
    || value === "part"
}

function friendlyMemberLabel(memberPath: string, fallback: string): string {
  const tail = memberPath.split("/").filter(Boolean).at(-1)
  return tail?.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || fallback
}

function shortOrdinal(value: string): string {
  return value.match(/(\d+)(?!.*\d)/)?.[1] ?? "1"
}

function compactLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length > 80 ? `${normalized.slice(0, 77).trimEnd()}…` : normalized
}

function formatClock(valueMs: number): string {
  const totalSeconds = Math.floor(valueMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function integer(value: unknown): number | undefined {
  const parsed = number(value)
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined
}
