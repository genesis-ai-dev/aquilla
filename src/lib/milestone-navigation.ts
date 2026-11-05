import { getBookName } from "@/lib/file-labeling/bible-book-names"
import { aiSectionMilestones, type BoundarySource } from "@/lib/import/ai-sections"
import { areAiSectionMilestonesEnabled } from "@/lib/import/ai-sections-flag"
import {
  FALLBACK_MILESTONE_SIZE,
  TIMELINE_MILESTONE_MS,
} from "@/lib/import/milestones"
import { translate } from "@/lib/i18n/translate"
import type { ImportMilestone, ImportMilestoneKind } from "../../shared/import-contract"
import type { FileMilestone } from "../../db/shared/file-milestones"
import {
  isAppInventedMilestoneKind,
  planUserMilestones,
} from "@/lib/editor/user-milestone-spans"

/**
 * `ImportMilestone.label`/`shortLabel` are a wire-format field (see
 * `shared/import-contract.ts`) that mixes two different things: real content
 * pulled from the imported file (a book name, a chapter number) and a
 * handful of app-authored vocabulary words used only when no content is
 * available ("Untimed", "Start", "Section", "Story", "Group", "Part N",
 * "Slide N"). `src/lib/` can't call `useT()`, and `ChapterNavigator.tsx`
 * (the sole renderer) already treats the whole field as opaque, pre-formatted
 * content — see the `MILESTONE_LABEL_PLACEHOLDER` context note in
 * `src/lib/i18n/namespaces/editor.ts`. Splitting "vocabulary word" from
 * "content" so the vocabulary half can be genuinely localized needs a wire-
 * format change plus a `ChapterNavigator.tsx` update, both out of this
 * module's scope. What's fixed here: the vocabulary words are resolved
 * through the catalog (`translate(undefined, key, …)`, always English, same
 * as before) instead of being hard-coded a second time — e.g. this used to
 * duplicate `editor.timeline.laneUntimed`'s "Untimed" independently.
 */

export interface MilestoneNavigationCell {
  id: string
  original: string
  type?: string | null
  canonicalRef?: string | null
  startMs?: number
  metadata?: Record<string, unknown> | null
}

/** AQU-2308: a hand-set milestone listed UNDER a division the file supplied. */
export interface NamedSubdivision {
  key: string
  /** The name exactly as typed. */
  label: string
  shortLabel: string
  firstCellId: string
  firstIndex: number
  cellIds: readonly string[]
}

export interface DerivedMilestoneNavigation {
  milestoneByCellId: ReadonlyMap<string, ImportMilestone>
  orderedMilestones: readonly {
    milestone: ImportMilestone
    firstCellId: string
    firstIndex: number
    cellIds: readonly string[]
    /**
     * AQU-2308: hand-set milestones nested inside this division, in file
     * order. Present only on divisions the FILE supplied — a hand-set
     * milestone over app-invented cells replaces them instead, and becomes a
     * top-level entry of its own.
     */
    named?: readonly NamedSubdivision[]
  }[]
}

/** Read only the validated generic envelope; arbitrary metadata is ignored. */
export function readImportMilestone(
  metadata: Record<string, unknown> | null | undefined,
): ImportMilestone | undefined {
  const envelope = record(metadata?.aquillaImport)
  return milestone(envelope?.milestone)
}

export interface MilestoneNavigationOptions {
  /**
   * Scored cell boundaries for this file, from AQU-1386's seam cache (AQU-1387).
   *
   * Passed in rather than read from the cache here so this module stays a pure
   * derivation: the hook that owns the cache decides when answers exist, and a
   * test can hand over a fixture. Absent — the default — leaves navigation
   * exactly as it was.
   */
  boundaries?: BoundarySource
  /**
   * Override the AI-section kill switch. Omitted, the switch decides; `false`
   * is how a surface that must show stable divisions opts out regardless.
   */
  aiSections?: boolean
  /**
   * AQU-2308: the file's hand-set milestones, as stored (`useFileMilestones`).
   *
   * Passed in rather than read here for the same reason `boundaries` is: this
   * module stays a pure derivation, the hook owns the fetch, and a test can
   * hand over a fixture. Absent — the default — leaves navigation exactly as
   * it was.
   */
  userMilestones?: readonly FileMilestone[]
}

/**
 * Build navigation in the caller's display order. New imports use persisted
 * assignments; legacy imports derive from canonical refs, normalized addresses,
 * Biblica metadata, structural headings, timing, then deterministic parts.
 *
 * When `options.boundaries` has answers, the app-invented divisions — "Part N"
 * and the 5-minute buckets, and only those — are replaced by AI sections cut at
 * the scored boundaries (AQU-1387). Divisions read out of the file are never
 * touched, which is a structural guarantee rather than a rule to remember: the
 * overlay only ever looks at `part` and `time-range` assignments.
 */
export function deriveMilestoneNavigation(
  cells: readonly MilestoneNavigationCell[],
  options: MilestoneNavigationOptions = {},
): DerivedMilestoneNavigation {
  const rawSeeds = cells.map(legacyMilestoneSeed)
  const seeds = identityPreservingSeeds(rawSeeds)
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
          ? nextScripture[index] ?? previous ?? fallback[index]
          : previous ?? nextScripture[index] ?? fallback[index]
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
      ? {
          key: "section:start",
          kind: "section",
          label: translate(undefined, "editor.milestone.vocab.startLabel"),
          shortLabel: "S",
        }
      : undefined
    let current: ImportMilestone | undefined
    for (let index = 0; index < cells.length; index += 1) {
      if (seeds[index]) current = seeds[index]
      resolved[index] = current
        ?? (index < firstSeedIndex ? startMilestone : undefined)
        ?? nextSeed[index]
        ?? fallback[index]
    }
  } else {
    for (let index = 0; index < cells.length; index += 1) {
      resolved[index] = fallback[index]
    }
  }

  // AQU-1164 lets a persisted generic `part` inherit the identity around it, so
  // the header no longer swaps to "Part N" mid-file. The cell is still one the
  // app invented a division for, so the AI overlay may re-cut it (AQU-1387);
  // when the overlay is off or has no answers the inherited identity stands.
  // Scripture mode ignored `part` seeds before AQU-1164 too, so it is left out.
  const inheritedPart = (index: number) => !scriptureMode && rawSeeds[index]?.kind === "part"

  // AQU-2308: hand-set milestones are planned against the divisions as the
  // file left them, BEFORE the AI overlay runs. That order is what makes "the
  // overlay never re-cuts a hand-set milestone" structural rather than a rule
  // to remember: by the time `applyAiSections` looks, a replaced run no longer
  // reads as app-invented, so the overlay has nothing to take there.
  const plan = planUserMilestones(
    cells.map((cell) => cell.id),
    resolved,
    options.userMilestones ?? [],
  )
  for (const placement of plan.placements) {
    if (placement.mode !== "replace") continue
    for (let index = placement.startIndex; index <= placement.endIndex; index += 1) {
      resolved[index] = placement.milestone
    }
  }
  // `inheritedPart` reads the RAW seeds, so a cell a hand-set milestone just
  // took over could still answer yes and be re-cut out from under it. Exclude
  // the replaced indices explicitly.
  applyAiSections(
    cells,
    resolved,
    options,
    (index) => inheritedPart(index) && !plan.replacedIndices.has(index),
  )

  // A hand-set milestone taken out of the middle of an app-invented division
  // leaves the cells either side of it in one group under one key, which would
  // list them as a single entry that silently spans the milestone. Splitting
  // the leftovers into their own contiguous runs is what produces the honest
  // "Part 1 · The storm · Part 2".
  if (plan.replacedIndices.size > 0) {
    splitInterruptedRuns(resolved, plan.replacedIndices)
    renumberParts(resolved)
  }

  const milestoneByCellId = new Map<string, ImportMilestone>()
  const groups = new Map<string, {
    milestone: ImportMilestone
    firstCellId: string
    firstIndex: number
    cellIds: string[]
    named?: NamedSubdivision[]
  }>()
  cells.forEach((cell, index) => {
    const assignment = resolved[index]
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

  // Nested placements are attached after grouping, so the parent division's
  // own cellIds — and therefore its figures — are exactly what they were.
  for (const placement of plan.placements) {
    if (placement.mode !== "nest") continue
    const parent = groups.get(placement.parentKey)
    if (!parent) continue
    const cellIds = cells
      .slice(placement.startIndex, placement.endIndex + 1)
      .map((cell) => cell.id)
    if (cellIds.length === 0) continue
    ;(parent.named ??= []).push({
      key: placement.milestone.key,
      label: placement.milestone.label,
      shortLabel: placement.milestone.shortLabel,
      firstCellId: cellIds[0],
      firstIndex: placement.startIndex,
      cellIds,
    })
  }

  return {
    milestoneByCellId,
    orderedMilestones: [...groups.values()],
  }
}

/**
 * Give each contiguous run of an app-invented division its own key.
 *
 * Only runs a hand-set milestone interrupted are touched: the first run keeps
 * the original key so nothing that remembered it (an active-key, a deep link)
 * breaks, and each later run gets a suffixed one so it lists as its own entry.
 *
 * Re-keying does not re-LABEL. `renumberParts` below renumbers "Part N",
 * because that number is pure invention and a stale one reads as a gap. A
 * 5-minute bucket's label is its clock range, which stays true of both halves
 * of a split bucket, so two rows may legitimately read "05:00–10:00" — that is
 * what they both are.
 */
function splitInterruptedRuns(
  resolved: ImportMilestone[],
  replacedIndices: ReadonlySet<number>,
): void {
  const runsSeen = new Map<string, number>()
  let previousKey: string | undefined
  for (let index = 0; index < resolved.length; index += 1) {
    const division = resolved[index]
    if (replacedIndices.has(index) || !isAppInventedMilestoneKind(division?.kind)) {
      previousKey = undefined
      continue
    }
    const originalKey = division.key
    if (previousKey === originalKey) continue
    previousKey = originalKey
    const seen = (runsSeen.get(originalKey) ?? 0) + 1
    runsSeen.set(originalKey, seen)
    if (seen === 1) continue
    // Re-key this whole run.
    const splitKey = `${originalKey}#${seen}`
    for (let member = index; member < resolved.length; member += 1) {
      if (resolved[member]?.key !== originalKey) break
      resolved[member] = { ...division, key: splitKey }
    }
    previousKey = splitKey
  }
}

/**
 * Renumber "Part N" over the parts that are actually listed.
 *
 * "Part N" is an invention of the app's, numbered by position in the file. Once
 * a hand-set milestone has taken a stretch out, the surviving parts must be
 * numbered 1..N over themselves or the navigator shows a gap ("Part 1 · The
 * storm · Part 3") or, after a split, the same number twice.
 */
function renumberParts(resolved: ImportMilestone[]): void {
  const ordinalByKey = new Map<string, number>()
  for (const division of resolved) {
    if (division?.kind !== "part") continue
    if (ordinalByKey.has(division.key)) continue
    ordinalByKey.set(division.key, ordinalByKey.size + 1)
  }
  if (ordinalByKey.size === 0) return
  const relabelled = new Map<string, ImportMilestone>()
  for (let index = 0; index < resolved.length; index += 1) {
    const division = resolved[index]
    if (division?.kind !== "part") continue
    let next = relabelled.get(division.key)
    if (!next) {
      const ordinal = ordinalByKey.get(division.key) ?? 1
      next = {
        ...division,
        label: translate(undefined, "editor.milestone.label.part", { number: ordinal }),
        shortLabel: String(ordinal),
      }
      relabelled.set(division.key, next)
    }
    resolved[index] = next
  }
}

export interface MilestonePageEntry {
  key: string
  cellIds: readonly string[]
  subsections?: readonly { key: string; cellIds: readonly string[] }[]
}

/**
 * Cells that belong on one navigator destination. Split-into-milestones view
 * always asks for the whole division. A subsection key is the picker jump
 * into a 50-cell range of a long IDML story, used only in continuous view.
 */
export function cellIdsForMilestonePage(
  navigation: readonly MilestonePageEntry[],
  milestoneKey: string,
  subsectionKey?: string,
): readonly string[] | undefined {
  const entry = navigation.find((item) => item.key === milestoneKey)
  if (!entry) return undefined
  if (subsectionKey) {
    const subsection = entry.subsections?.find((item) => item.key === subsectionKey)
    if (subsection) return subsection.cellIds
  }
  return entry.cellIds
}

/**
 * Replace app-invented divisions with AI sections, in place.
 *
 * Works run by run rather than over the whole file: a file can be part
 * structured and part not (a USFM with an unreferenced tail, a transcript with
 * one titled segment), and only the unstructured stretches are the app's to
 * re-cut. Each run is planned independently with the seam indices offset to the
 * run's start, so a section can never straddle a division that came out of the
 * file.
 */
function applyAiSections(
  cells: readonly MilestoneNavigationCell[],
  resolved: ImportMilestone[],
  options: MilestoneNavigationOptions,
  inheritedPart: (index: number) => boolean,
): void {
  const { boundaries } = options
  if (!boundaries) return
  if (!(options.aiSections ?? areAiSectionMilestonesEnabled())) return

  let runStart: number | null = null
  for (let index = 0; index <= cells.length; index += 1) {
    const invented = index < cells.length
      && (isAppInventedKind(resolved[index]?.kind) || inheritedPart(index))
    if (invented) {
      if (runStart === null) runStart = index
      continue
    }
    if (runStart === null) continue
    replaceRun(cells, resolved, runStart, index - 1, boundaries)
    runStart = null
  }
}

/** Divisions the app made up when the file offered none. */
function isAppInventedKind(kind: ImportMilestoneKind | undefined): boolean {
  return kind === "part" || kind === "time-range"
}

function replaceRun(
  cells: readonly MilestoneNavigationCell[],
  resolved: ImportMilestone[],
  start: number,
  end: number,
  boundaries: BoundarySource,
): void {
  const timeline = resolved[start]?.kind === "time-range"
  const assignments = aiSectionMilestones(
    cells.slice(start, end + 1).map((cell) => ({
      key: cell.id,
      text: cell.original,
      ...(cell.startMs === undefined ? {} : { startMs: cell.startMs }),
    })),
    (seam) => boundaries(start + seam),
    {
      clockPrefix: timeline,
      // A run whose cells are all empty gets the bare vocabulary word; the
      // milestone's shortLabel still carries the ordinal, so the picker can
      // tell two of them apart. Composing "Section" + a number here would be
      // the frame-filling this module's header argues against.
      fallbackLabel: () => translate(undefined, "editor.milestone.vocab.section"),
    },
  )
  if (!assignments) return
  for (let index = 0; index < assignments.length; index += 1) {
    resolved[start + index] = assignments[index]
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
          label: translate(undefined, "editor.milestone.label.slide", { number: slide }),
          shortLabel: slide,
        }
      }
      const locator = record(envelope?.sourceLocator)
      if (locator?.kind === "idml") {
        const story = string(locator.storyId) ?? memberPath
        return {
          key: `story:${memberPath}:${story}`,
          kind: "story",
          label: friendlyMemberLabel(
            memberPath,
            translate(undefined, "editor.milestone.vocab.story"),
          ),
          shortLabel: shortOrdinal(memberPath),
        }
      }
      return {
        key: `group:${memberPath}`,
        kind: "group",
        label: friendlyMemberLabel(
          memberPath,
          translate(undefined, "editor.milestone.vocab.group"),
        ),
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
      label: compactLabel(cell.original) || translate(undefined, "editor.milestone.vocab.section"),
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
  const book = match[1].toUpperCase()
  const chapter = Number(match[2])
  if (book === "OBS") {
    return {
      key: `story:OBS:${chapter}`,
      kind: "story",
      label: translate(undefined, "editor.milestone.label.story", { number: chapter }),
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
    return {
      key: "time:untimed",
      kind: "time-range",
      label: translate(undefined, "editor.timeline.laneUntimed"),
      shortLabel: "—",
    }
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
      label: translate(undefined, "editor.milestone.label.part", { number: part }),
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

/**
 * AQU-1164: `part` is the only milestone kind that carries no identity — it is
 * the deterministic 50-cell "Part N" label used when a file offers nothing
 * better. A file that has real identity somewhere (a Scripture chapter, a
 * Biblica chapter, a heading section, an IDML story, a slide, a group) must not
 * swap its header to "Part N" partway down just because some of its cells were
 * persisted with the generic fallback — those cells belong to the book or
 * section already in effect. Dropping the generic seeds lets the inheritance
 * below carry the surrounding identity across them, exactly as it already does
 * for a cell that has no seed at all.
 *
 * A file that is generic all the way through keeps its persisted `Part N`
 * labels untouched: there is no identity to inherit, so "Part N" is the
 * deliberate answer rather than a mid-file surprise.
 */
function identityPreservingSeeds(
  seeds: readonly (ImportMilestone | undefined)[],
): (ImportMilestone | undefined)[] {
  const hasIdentity = seeds.some((seed) => seed && seed.kind !== "part")
  if (!hasIdentity) return [...seeds]
  return seeds.map((seed) => (seed?.kind === "part" ? undefined : seed))
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
    || value === "ai-section"
    // "user" is here for completeness of the guard, but a persisted import
    // envelope can never legitimately carry it: a hand-set milestone is its
    // own record, assembled below rather than read off a cell (AQU-2308).
    || value === "user"
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
