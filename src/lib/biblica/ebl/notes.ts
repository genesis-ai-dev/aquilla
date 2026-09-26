/**
 * Select the content of an EBL guide from a fully parsed IDML package, and
 * recover the outline it is organized by.
 *
 * Unlike the other three Biblica editions there is nothing to leave out for
 * being scripture: an Equipping Biblical Leaders guide is written material
 * end to end. Page furniture still drops, and so does a cell with nothing to
 * translate — a table number ("8") or a ruled write-in line.
 *
 * The work here is therefore the **division** each cell belongs to. A module
 * guide runs to roughly 850 paragraphs — six topics, three lessons each, behind
 * a stack of front matter — and a flat file that long is unusable to navigate.
 * The template numbers its own outline, so the divisions are read from it
 * rather than invented:
 *
 * - a level-1 heading (`msN` with N = 1) opens a division, in every style group
 * - in the topic group the opener is instead the `TOPIC 1.1` tag, and the
 *   level-1 heading under it is that topic's title
 * - in the lesson group the opener is the `Lesson 2` tag, and the level-2
 *   heading under it is that lesson's title
 *
 * so the file divides into "Introduction", "About the programme", "MODULE 1 …",
 * "Topic 1.1: How God shows himself", "Lesson 1: Seeing God from a distance",
 * and so on — which is exactly how a facilitator refers to the material.
 *
 * **Two things the package makes awkward.**
 *
 * A guide's pull-out boxes — the per-lesson "30 min" timing badge, the "TOPIC
 * SUMMARY" banner, a matching-exercise table — are separate InDesign frames
 * rather than part of the threaded body, and an IDML package records no page
 * for a story. So they cannot be filed under the lesson they are printed
 * beside, and they arrive wherever the package lists them, which is ahead of
 * the guide. Worse, a timing badge is set in the same level-1 style a lesson
 * tag uses, so taken at face value it would open a division called "30 min".
 * Both are handled by only reading the outline out of a story that *has* one —
 * a story where a level-1 heading is followed by the body it heads. Everything
 * else is a loose frame, and consecutive loose frames group together.
 *
 * A heading may be set over two lines ("Facilitator Guide" above "Module 1").
 * A line break is a protected token rather than a newline, so the division is
 * named from the heading's first line, after the unit is partitioned.
 *
 * Contents lines park a page number next to the title — either as its own
 * character run, or behind tab leaders in the same run. The number will still
 * be a number after translation, so it is left in the package rather than
 * imported: a separate run is dropped from the line's locator (export keeps
 * the source slot), and a same-run trailer is sliced off (export keeps the
 * unmentioned remainder).
 *
 * This is a presentation filter over parsed units — it never reinterprets the
 * package. Every emitted cell is an engine projection or slice of its
 * paragraph, so protected-HTML editing keeps working on the original bytes:
 * line parts are real locators the engine merges on export, and sentence slices
 * carry the `rejoin` ranges the exporter uses to rebuild their line first.
 */

import {
  partitionIdmlUnitAtLineBreaks,
  projectIdmlUnitToLocator,
  sliceIdmlUnit,
  type IdmlSliceRange,
  type IdmlTranslationUnit,
} from "@aquilla/idml-roundtrip"
import { eblSentenceCutPoints } from "./sentence-cuts"
import {
  classifyEblUnit,
  compactHeading,
  eblHeadingLevel,
  headingSlug,
  isEblContentsStyle,
  isEblLessonNumberStyle,
  isEblLessonTitleStyle,
  isEblTopicNumberStyle,
  isEblTopicTitleStyle,
  isNonTextualContent,
  isPageNumberRun,
  parseEblLessonNumber,
  parseEblTopicNumber,
  trailingPageNumberStart,
} from "./note-rules"

/**
 * What a division is, for grouping and for the label it shows. Every kind
 * navigates as a section — the guide has no chapters — so this distinction is
 * about provenance, not about how the navigator behaves.
 */
export type EblDivisionKind = "section" | "topic" | "lesson" | "boxes"

export interface EblDivision {
  /** Stable within one guide and across re-imports of the same package. */
  readonly key: string
  readonly kind: EblDivisionKind
  /** What the navigator shows, e.g. "Topic 1.2: How the Bible was inspired". */
  readonly label: string
  /** Compact badge a reader can jump by: "1.2", "1.2.3", "4", "B". */
  readonly shortLabel: string
}

export interface EblNoteRejoin {
  readonly index: number
  readonly count: number
  readonly ranges: readonly IdmlSliceRange[]
}

export interface EblNote {
  /**
   * The cell's unit: one sentence of a line, one whole line, or the whole
   * paragraph when it holds neither a line break nor a sentence boundary.
   */
  readonly unit: IdmlTranslationUnit
  /**
   * Set when the unit is one sentence of a larger line, which the exporter has
   * to rebuild before handing the line to the engine. Absent when the unit is
   * the whole thing its locator addresses.
   */
  readonly rejoin?: EblNoteRejoin
  /**
   * Absent only when the package has no recoverable outline at all, which
   * leaves the shared importer's own fallback to divide the file.
   */
  readonly division?: EblDivision
}

export interface EblSelection {
  readonly notes: readonly EblNote[]
  /** Units dropped as page furniture or as holding no visible text. */
  readonly otherUnitCount: number
  /** The divisions found, in document order. Empty when none were. */
  readonly divisions: readonly EblDivision[]
}

export interface SelectEblNotesOptions {
  /**
   * When true (default), cut each line at sentence boundaries so long blocks
   * arrive as one cell per sentence. When false, each line is one cell.
   */
  readonly splitSentences?: boolean
}

/** The coordinate space sentence cuts are expressed in: slot text, nothing else. */
function slotText(unit: IdmlTranslationUnit): string {
  return unit.slots.map((slot) => slot.text).join("")
}

function hasVisibleText(unit: IdmlTranslationUnit): boolean {
  return !isNonTextualContent(unit.slots.map((slot) => slot.text))
}

/** One line of one content paragraph, with the context needed to place it. */
interface ContentLine {
  readonly unit: IdmlTranslationUnit
  readonly paragraphStyle: string
  readonly storyId: string
  /**
   * Set on a paragraph's first line only: the whole paragraph read as one
   * heading. A division is named from this rather than from the line, because a
   * heading is routinely set over two lines ("MODULE 1" above "How we have the
   * Bible") and either half alone is a poor name for the division.
   */
  readonly heading?: string
  /** False for a loose frame, whose headings do not divide anything. */
  readonly inBodyStory: boolean
  readonly text: string
}

/** A division under construction: its label is completed by a later title. */
interface DivisionDraft {
  key: string
  kind: EblDivisionKind
  label: string
  shortLabel: string
}

/**
 * True for a heading that would open a division if it stood in a body story.
 * Used both to find the body stories and to divide them, so the two agree.
 */
function opensDivision(paragraphStyle: string): boolean {
  return eblHeadingLevel(paragraphStyle) === 1 || isEblTopicNumberStyle(paragraphStyle)
}

/**
 * Which stories carry the guide's outline.
 *
 * A story qualifies when one of its division-opening headings is followed by
 * content it heads. That is what separates the threaded body — headings with
 * material under them — from a pull-out frame such as the "30 min" badge, which
 * is a level-1 heading and nothing else.
 */
function findBodyStories(units: readonly IdmlTranslationUnit[]): ReadonlySet<string> {
  const byStory = new Map<string, IdmlTranslationUnit[]>()
  for (const unit of units) {
    const storyId = unit.locator.storyId ?? unit.locator.memberPath
    const existing = byStory.get(storyId)
    if (existing) existing.push(unit)
    else byStory.set(storyId, [unit])
  }

  const bodyStories = new Set<string>()
  for (const [storyId, storyUnits] of byStory) {
    const opener = storyUnits.findIndex((unit) => opensDivision(unit.paragraphStyleId ?? ""))
    if (opener < 0) continue
    const headed = storyUnits
      .slice(opener + 1)
      .some((unit) => !opensDivision(unit.paragraphStyleId ?? ""))
    if (headed) bodyStories.add(storyId)
  }
  return bodyStories
}

/**
 * Every content paragraph as its lines, in document order.
 *
 * Lines rather than paragraphs because this template sets lists — objectives,
 * materials, contents entries, the lesson list on a topic opener — as a single
 * paragraph with a `<Br/>` between items, which would otherwise arrive as one
 * cell holding every entry. It is also what exposes a two-line heading's first
 * line, which is the line that names its division.
 */
function contentLines(
  units: readonly IdmlTranslationUnit[],
  bodyStories: ReadonlySet<string>,
): { lines: ContentLine[]; otherUnitCount: number } {
  const lines: ContentLine[] = []
  let otherUnitCount = 0

  for (const unit of units) {
    const paragraphStyle = unit.paragraphStyleId ?? ""
    if (classifyEblUnit(paragraphStyle) === "furniture" || !hasVisibleText(unit)) {
      otherUnitCount += 1
      continue
    }
    const storyId = unit.locator.storyId ?? unit.locator.memberPath
    const visible = partitionIdmlUnitAtLineBreaks(unit)
      .map((line) => (
        isEblContentsStyle(paragraphStyle) ? dropStandalonePageNumberSlots(line) : line
      ))
      .filter(hasVisibleText)
    // Joined with a space: the engine reports a line break as a protected token
    // rather than whitespace, so the paragraph's own text would run its lines
    // together ("MODULE 1How we have the Bible").
    const heading = compactHeading(visible.map(slotText).join(" "))
    for (const [index, line] of visible.entries()) {
      lines.push({
        unit: line,
        paragraphStyle,
        storyId,
        ...(index === 0 && heading ? { heading } : {}),
        inBodyStory: bodyStories.has(storyId),
        text: slotText(line),
      })
    }
  }

  return { lines, otherUnitCount }
}

/**
 * Walk the lines once, opening a division at each heading that starts one and
 * naming it from the heading — completing topic and lesson labels from the
 * title line that follows the numbered tag.
 *
 * Returns one division index per line, `undefined` for a body line the guide
 * has not opened a division for yet — the cover line above the heading of the
 * title page it introduces. Those reach forward to the division they open.
 */
function divideLines(lines: readonly ContentLine[]): {
  drafts: DivisionDraft[]
  indexByLine: (number | undefined)[]
} {
  const drafts: DivisionDraft[] = []
  const indexByLine: (number | undefined)[] = new Array(lines.length).fill(undefined)

  // With no story carrying an outline there is nothing to divide by, and
  // calling the whole package "Boxes and tables" would be a worse answer than
  // the shared importer's own even parts. A cover or plate volume lands here.
  if (!lines.some((line) => line.inBodyStory)) return { drafts, indexByLine }

  /** The division opened by the guide's own outline; loose frames never set it. */
  let current: number | undefined
  /** The run of loose frames being collected, reset by any body line. */
  let currentBox: number | undefined
  let sectionOrdinal = 0
  let boxRun = 0
  let topicNumber: string | undefined
  let topicOrdinal = 0
  let lessonOrdinal = 0
  /** A tag whose title is expected on the very next line, and nowhere later. */
  let awaitingTitle: { kind: "topic" | "lesson"; draft: DivisionDraft } | undefined

  function open(draft: DivisionDraft): number {
    drafts.push(draft)
    return drafts.length - 1
  }

  for (const [index, line] of lines.entries()) {
    const pendingTitle = awaitingTitle
    awaitingTitle = undefined
    const style = line.paragraphStyle

    // A loose frame divides nothing, and is not part of whatever division the
    // guide is in — the package records no page for it, so there is nothing to
    // say it belongs there. Each run of them groups on its own instead.
    if (!line.inBodyStory) {
      if (currentBox === undefined) {
        boxRun += 1
        currentBox = open({
          key: `ebl:boxes:${boxRun}`,
          kind: "boxes",
          label: "Boxes and tables", // i18n-exempt: persisted at import, see planImportMilestones
          shortLabel: boxRun === 1 ? "B" : `B${boxRun}`,
        })
      }
      indexByLine[index] = currentBox
      continue
    }
    currentBox = undefined

    const heading = line.heading

    if (heading) {
      if (isEblTopicNumberStyle(style)) {
        const number = parseEblTopicNumber(heading)
        topicOrdinal += 1
        topicNumber = number
        lessonOrdinal = 0
        const draft: DivisionDraft = {
          key: `ebl:topic:${number ?? `n${topicOrdinal}`}`,
          kind: "topic",
          label: number ? `Topic ${number}` : heading,
          shortLabel: number ?? `T${topicOrdinal}`,
        }
        current = open(draft)
        awaitingTitle = { kind: "topic", draft }
        indexByLine[index] = current
        continue
      }

      if (isEblTopicTitleStyle(style)) {
        if (pendingTitle?.kind === "topic") {
          // "Topic 1.1" + "How God shows himself" name one division together.
          pendingTitle.draft.label = `${pendingTitle.draft.label}: ${heading}`
          indexByLine[index] = current
          continue
        }
        topicOrdinal += 1
        topicNumber = undefined
        lessonOrdinal = 0
        current = open({
          key: `ebl:topic:${topicOrdinal}:${headingSlug(heading)}`,
          kind: "topic",
          label: heading,
          shortLabel: `T${topicOrdinal}`,
        })
        indexByLine[index] = current
        continue
      }

      if (isEblLessonTitleStyle(style) && pendingTitle?.kind === "lesson") {
        pendingTitle.draft.label = `${pendingTitle.draft.label}: ${heading}`
        indexByLine[index] = current
        continue
      }

      const lessonNumber = isEblLessonNumberStyle(style)
        ? parseEblLessonNumber(heading)
        : undefined
      if (lessonNumber !== undefined) {
        lessonOrdinal += 1
        const within = topicNumber
          ? `${topicNumber}.${lessonNumber}`
          : `L${lessonOrdinal}`
        const draft: DivisionDraft = {
          key: `ebl:lesson:${topicNumber ?? `n${topicOrdinal}`}:${lessonNumber}`,
          kind: "lesson",
          label: heading,
          shortLabel: within,
        }
        current = open(draft)
        awaitingTitle = { kind: "lesson", draft }
        indexByLine[index] = current
        continue
      }

      // Every other level-1 heading names a part of the guide directly: the
      // front matter, the module opener, and the back matter after the lessons.
      if (eblHeadingLevel(style) === 1) {
        sectionOrdinal += 1
        current = open({
          key: `ebl:section:${sectionOrdinal}:${headingSlug(heading)}`,
          kind: "section",
          label: heading,
          shortLabel: String(sectionOrdinal),
        })
        indexByLine[index] = current
        continue
      }
    }

    indexByLine[index] = current
  }

  return { drafts, indexByLine }
}

export function selectEblNotes(
  units: readonly IdmlTranslationUnit[],
  options?: SelectEblNotesOptions,
): EblSelection {
  const splitSentences = options?.splitSentences !== false
  const bodyStories = findBodyStories(units)
  const { lines, otherUnitCount } = contentLines(units, bodyStories)
  const { drafts, indexByLine } = divideLines(lines)

  // A line the guide had not opened a division for belongs with the division it
  // introduces — a cover line sits above the heading of its title page, not in
  // a division of its own. Mirrors how the shared importer fills a leading gap.
  const nextDivision: (number | undefined)[] = new Array(indexByLine.length)
  let following: number | undefined
  for (let index = indexByLine.length - 1; index >= 0; index -= 1) {
    following = indexByLine[index] ?? following
    nextDivision[index] = following
  }
  // Loose frames normally arrive in one run, and one unnumbered "Boxes and
  // tables" reads better than a numbered one. Number them only when a package
  // splits them, so two runs are still told apart.
  const boxRuns = drafts.filter((draft) => draft.kind === "boxes").length
  let boxRun = 0
  const divisions: readonly EblDivision[] = drafts.map((draft) => {
    if (draft.kind !== "boxes" || boxRuns < 2) return { ...draft }
    boxRun += 1
    return { ...draft, label: `${draft.label} ${boxRun}` }
  })

  const notes: EblNote[] = []
  for (const [index, line] of lines.entries()) {
    const divisionIndex = indexByLine[index] ?? nextDivision[index]
    const division = divisionIndex === undefined ? undefined : divisions[divisionIndex]
    const common = division ? { division } : {}

    for (const note of importableLine(line, splitSentences)) {
      notes.push({ ...note, ...common })
    }
  }

  return { notes, otherUnitCount, divisions }
}

/**
 * A contents page number that is its own character run is dropped from the
 * line's locator. Export never sees a translation for that slot, so the
 * publisher's number stays in the package. Trailing empty runs left behind
 * by tab leaders are dropped the same way — they have nothing to translate.
 */
function dropStandalonePageNumberSlots(unit: IdmlTranslationUnit): IdmlTranslationUnit {
  if (unit.slots.length < 2) return unit
  const keep = unit.slots.flatMap((slot, index) => (isPageNumberRun(slot.text) ? [] : [index]))
  if (keep.length === 0 || keep.length === unit.slots.length) return unit
  if (isNonTextualContent(keep.map((index) => unit.slots[index]!.text))) return unit
  while (keep.length > 1) {
    const last = keep.at(-1)!
    if (unit.slots[last]!.text.replace(/\s+/g, "").length > 0) break
    keep.pop()
  }
  const locator = {
    ...unit.locator,
    slotIndexes: keep.map((index) => unit.locator.slotIndexes[index]!),
  }
  return projectIdmlUnitToLocator(unit, locator) ?? unit
}

/**
 * The cells one contents or body line becomes. Sentence cuts stay as they were;
 * a same-run contents page number is sliced off and never imported, so export
 * keeps the publisher's trailer.
 */
function importableLine(
  line: ContentLine,
  splitSentences: boolean,
): Array<Pick<EblNote, "unit" | "rejoin">> {
  const pageStart = isEblContentsStyle(line.paragraphStyle)
    ? trailingPageNumberStart(line.text)
    : undefined
  const importEnd = pageStart ?? line.text.length
  const sentenceCuts = splitSentences
    ? eblSentenceCutPoints(line.text).filter((cut) => cut < importEnd)
    : []
  const cuts = pageStart === undefined ? sentenceCuts : [...sentenceCuts, pageStart]
  const slices = sliceIdmlUnit(line.unit, cuts)
  const imported = pageStart === undefined ? slices : slices.slice(0, -1)
  if (imported.length === 0) return [{ unit: line.unit }]
  const needsRejoin = imported.length > 1 || pageStart !== undefined
  return imported.map((slice, sliceIndex) => ({
    unit: slice.unit,
    ...(needsRejoin
      ? { rejoin: { index: sliceIndex, count: imported.length, ranges: slice.ranges } }
      : {}),
  }))
}
