/**
 * Equipping Biblical Leaders (EBL) IDML style rules.
 *
 * EBL is a Biblica training programme: four modules of six topics, each topic
 * run as three lessons, shipped as a facilitator guide and a participant guide
 * per module (`ukEng_MODULE 1_EBL_FACILITATOR GUIDE.idml`). Unlike the other
 * three Biblica templates, an EBL guide is *not* a Bible with material set
 * around it — it is written material throughout, quoting scripture the way any
 * teaching book does. So there is no scripture to skip and no deny-list to
 * write: every text-bearing paragraph is a cell.
 *
 * What the template does give, and what this module reads, is an unusually
 * disciplined outline. Every paragraph style is spelled `NN_Section:marker`,
 * where the numbered prefix names the part of the guide the paragraph belongs
 * to and the marker is a USFM-ish code:
 *
 * - `01_Intro page` — the cover line and the programme introduction
 * - `02_TOC` — contents (`tc1`…`tc4`)
 * - `03_About Programme`, `04_Training Facilitators` — the front matter
 * - `05_Modules` — the module opener spread
 * - `06_Lesson Intro` — a topic opener: `ms3` is "TOPIC 1.1", `ms1` its title
 * - `07_Lessons` — the lessons: `ms1` is "Lesson 2", `ms2` its title
 *
 * `msN` is a heading at level N, and the template uses level 1 consistently for
 * "a new part of the guide starts here" — which is what makes the outline
 * recoverable (see `./notes`). Deeper levels (`ms2`…`ms8`, plus decorated
 * variants like `ms2_shade`) are headings *within* a division and never open
 * one; `ms2` is the exception the two numbered groups make, where it carries
 * the title belonging to the `ms1` above it.
 *
 * Nothing here interprets prose. A rule reads the style name, and — for the two
 * places the guide numbers itself — the leading "TOPIC 1.1" / "Lesson 2" of a
 * heading it has already identified by style.
 */

/** InDesign ACE placeholder markers (page numbers, section markers, jumps). */
const ACE_MARKER_PATTERN = /<\?ACE\s+\d+\?>/gi

/**
 * Auto-generated page furniture. Deliberately short: an EBL guide is written
 * material end to end, so an unrecognised style is far more likely to be a
 * one-off heading or callout than something to drop, and arriving as a cell is
 * the recoverable outcome. InDesign's unnamed defaults are *not* listed —
 * the cover line ("Equipping Biblical Leaders") is set in one.
 *
 * Number-only table cells and ruled write-in lines are dropped by content
 * (`isNonTextualContent`), not by style, because the same styles also carry
 * real sentences.
 */
const FURNITURE_STYLES: ReadonlySet<string> = new Set([
  "*DEFAULT PARAGRAPH*",
  "*Page number",
])

/** Production stamps and typesetter notes (`#NB check`, `zz.proofs`). */
const PRODUCTION_MARKER_PATTERN = /^(?:#|zz\.)/

/** The style group holding a topic opener spread. */
export const EBL_TOPIC_GROUP = "lesson intro"

/** The style group holding the lessons themselves. */
export const EBL_LESSON_GROUP = "lessons"

export type EblUnitKind = "furniture" | "content"

/**
 * The style name on its own: the engine reports the applied style as InDesign
 * writes it, `ParagraphStyle/07_Lessons%3ams1`, URL-encoding the `:` that
 * separates a style group from its children. Both are undone here so every rule
 * below can work in plain `Group:marker` form.
 */
export function decodeStyleName(styleName: string): string {
  const name = styleName.startsWith("ParagraphStyle/")
    ? styleName.slice("ParagraphStyle/".length)
    : styleName
  if (!name.includes("%")) return name
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

export interface EblStylePath {
  /**
   * The group reduced to its identity: lower-cased, without the `NN_` ordering
   * prefix, so `06_Lesson Intro` and a re-numbered `07_Lesson Intro` compare
   * equal. Empty when the style names no group.
   */
  readonly groupId: string
  /** The group as the template spells it, minus the ordering prefix. */
  readonly groupLabel: string
  /** The last segment — the marker, e.g. `ms1`, `tc2`, `table no`. */
  readonly marker: string
}

/** Split a style name into its group identity and its marker. */
export function styleParts(styleName: string): EblStylePath {
  const segments = decodeStyleName(styleName).split(":")
  const marker = (segments.at(-1) ?? "").trim()
  const groupLabel = segments.length > 1
    ? (segments[0] ?? "").trim().replace(/^\d+_/, "")
    : ""
  return { groupId: groupLabel.toLowerCase(), groupLabel, marker }
}

/** True for auto page numbers, InDesign defaults and production notes. */
export function isEblFurnitureStyle(paragraphStyle: string): boolean {
  const decoded = decodeStyleName(paragraphStyle)
  if (FURNITURE_STYLES.has(decoded)) return true
  return PRODUCTION_MARKER_PATTERN.test(styleParts(paragraphStyle).marker)
}

/**
 * Which bucket a paragraph falls into. Only furniture is dropped, so an
 * unrecognised guide style is imported rather than lost.
 */
export function classifyEblUnit(paragraphStyle: string): EblUnitKind {
  return isEblFurnitureStyle(paragraphStyle) ? "furniture" : "content"
}

/**
 * The heading level of an `msN` marker, or `undefined` for body text.
 *
 * Only the bare marker counts: the template decorates variants it wants to look
 * different (`ms2_shade`, `ms3_shade`), and those sit inside a division rather
 * than titling one.
 */
export function eblHeadingLevel(paragraphStyle: string): number | undefined {
  const level = /^ms(\d+)$/.exec(styleParts(paragraphStyle).marker)?.[1]
  return level ? Number(level) : undefined
}

/** True for the `TOPIC 1.1` tag that opens a topic spread. */
export function isEblTopicNumberStyle(paragraphStyle: string): boolean {
  const { groupId } = styleParts(paragraphStyle)
  return groupId === EBL_TOPIC_GROUP && eblHeadingLevel(paragraphStyle) === 3
}

/** True for the topic title set under that tag ("How God shows himself"). */
export function isEblTopicTitleStyle(paragraphStyle: string): boolean {
  const { groupId } = styleParts(paragraphStyle)
  return groupId === EBL_TOPIC_GROUP && eblHeadingLevel(paragraphStyle) === 1
}

/** True for the `Lesson 2` tag that opens a lesson. */
export function isEblLessonNumberStyle(paragraphStyle: string): boolean {
  const { groupId } = styleParts(paragraphStyle)
  return groupId === EBL_LESSON_GROUP && eblHeadingLevel(paragraphStyle) === 1
}

/** True for the lesson title set under that tag ("Seeing God up close"). */
export function isEblLessonTitleStyle(paragraphStyle: string): boolean {
  const { groupId } = styleParts(paragraphStyle)
  return groupId === EBL_LESSON_GROUP && eblHeadingLevel(paragraphStyle) === 2
}

/**
 * The dotted number a topic tag carries ("TOPIC 1.1" → `1.1`).
 *
 * Absent when the tag is worded some other way, which leaves the topic named by
 * its title alone rather than dropping it.
 */
export function parseEblTopicNumber(text: string): string | undefined {
  return /^\s*topic\s+(\d+(?:\.\d+)*)/i.exec(text)?.[1]
}

/** The number a lesson tag carries ("Lesson 2" → `2`). */
export function parseEblLessonNumber(text: string): number | undefined {
  const value = /^\s*lesson\s+(\d+)/i.exec(text)?.[1]
  return value ? Number(value) : undefined
}

/** True when visible text is empty after stripping ACE markers and whitespace. */
export function isStructuralOnlyContent(segments: readonly string[]): boolean {
  return visiblePlain(segments.join("")).length === 0
}

/**
 * True when a cell would have nothing to translate: empty, a table number
 * ("8"), or a ruled write-in line ("----", "____"). "30 min" and "Lesson 1"
 * keep their letters and stay.
 */
export function isNonTextualContent(segments: readonly string[]): boolean {
  const visible = visiblePlain(segments.join(""))
  if (visible.length === 0) return true
  return !/\p{L}/u.test(visible)
}

function visiblePlain(text: string): string {
  return text.replace(ACE_MARKER_PATTERN, "").replace(/\s+/g, " ").trim()
}

/**
 * Heading text as a label: ACE markers dropped and whitespace collapsed, capped
 * so one long heading cannot crowd the navigator.
 *
 * Only ever given one line. A `<Br/>` is a protected token rather than a
 * newline, so a two-line heading ("Facilitator Guide" over "Module 1") reads as
 * one run of text here — the caller partitions the unit at its line breaks
 * first and labels the division with the line that names it.
 */
export function compactHeading(text: string): string {
  const normalized = text.replace(ACE_MARKER_PATTERN, "").replace(/\s+/g, " ").trim()
  return normalized.length > 80 ? `${normalized.slice(0, 79).trimEnd()}…` : normalized
}

/** A heading reduced to a stable, key-safe slug. */
export function headingSlug(text: string): string {
  return compactHeading(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "")
}
