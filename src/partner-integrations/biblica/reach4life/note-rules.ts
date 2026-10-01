/**
 * Reach4Life IDML style rules.
 *
 * Reach4Life is a Biblica New Testament for teenagers: the NIrV text plus a
 * workbook of lessons, journeys, hot topics and book introductions built around
 * it. It ships as two InDesign templates that a single import has to read,
 * because one edition is split across packages from both:
 *
 * - The **scripture volumes** (`…_ukNIRV-120x180mm_BLUE.idml`) group styles by
 *   typographic role: `Paragraphs:Regular paragraphs:p`, `Poetry:q1`,
 *   `Embedded:Embedded prose:pm`, `Headings:s1`, `Titles:mt1` carry the
 *   published NIrV; `Metatext_BBI Bible Book Intros:im`, `Intros:ili`,
 *   `Copyright:pc` and `Additional:TOC Entry` carry the material around it.
 * - The **workbook sections** (`ukEngR4Lv4_NT_*.idml`) put everything under
 *   `R4Lv4 Paragraph Styles:` and then a numbered group per feature —
 *   `4_WAI` (Who am I?), `5_Story`, `8_T4J Journeys`, `9_SIE`, `10_HOT Hot
 *   Topics`, `11_DEEP Thats Deep`, `12_R4L Group`, `7_Psalms`, `13_Copyright`.
 *
 * Both spell a style as a `:`-separated path whose last segment is a USFM-ish
 * marker and whose leading segments name the group. So the rules read the
 * *group path*, not the marker: `q1` is scripture under `Poetry` and under
 * `7_Psalms:Poetry`, but is a pull-quote inside a lesson under `4_WAI` — the
 * marker alone cannot tell those apart.
 *
 * As with the Treasure Hunt template, the rule is a deny-list: skip scripture,
 * skip page furniture, take everything else. A Reach4Life edition carries a
 * long tail of one-off lesson styles, and an unrecognised one is far more
 * likely to be new workbook prose than new scripture — arriving as a cell is
 * the recoverable outcome.
 */

import { matchLeadingBookName } from "../book-names"

/** InDesign ACE placeholder markers (page numbers, section markers, jumps). */
const ACE_MARKER_PATTERN = /<\?ACE\s+\d+\?>/gi

/**
 * Group names that hold the published NIrV. Matched anywhere in the group path,
 * so `Poetry:q1` in a scripture volume and `7_Psalms:Poetry:q1` in the workbook
 * are both scripture, while the identically-named `4_WAI:q1` pull-quote is not.
 */
const SCRIPTURE_GROUPS: ReadonlySet<string> = new Set([
  "paragraphs",  // p, p-b, p-chpt1, li1, pi1, m-b, mi-b — Bible prose and its lists
  "poetry",      // q1, q2, q3, qc, pc — Bible poetry
  "embedded",    // pm, pmo, pmc — letters and speeches embedded in the text
  "headings",    // s1 — section headings, set from the scripture files
  "titles",      // mt1 — the book title on a scripture page
])

/** Page numbers, running heads, TOC markers and production remarks. */
const FURNITURE_GROUPS: ReadonlySet<string> = new Set(["page elements"])

/**
 * A psalm's own superscription (`d-h`, "For the director of music…") and its
 * acrostic letters (`qa`, "Beth") are scripture even though they sit in the
 * workbook's `Psalm heading` group beside the Reach4Life-authored heading
 * ("Psalm 1 (see Live lesson 3 on Rpg 92)") that introduces the reading.
 */
const PSALM_HEADING_GROUP = "psalm heading"
const PSALM_SCRIPTURE_MARKERS: ReadonlySet<string> = new Set(["d-h", "qa"])

/** The workbook template's root group, which names no section of its own. */
const TEMPLATE_ROOT_GROUPS: ReadonlySet<string> = new Set(["r4lv4 paragraph styles"])

/** InDesign's unnamed defaults, which no Reach4Life content uses. */
const FURNITURE_STYLES: ReadonlySet<string> = new Set([
  "*DEFAULT PARAGRAPH*",
  "$ID/[No paragraph style]",
])

/** Production stamps and typesetter notes (`#NB PINK to check`, `zz.proofs`). */
const PRODUCTION_MARKER_PATTERN = /^(?:#|zz\.)/

/** Running-head separator glyph, the only visible text in an `rh1` frame. */
const RUNNING_HEAD_GLYPH_PATTERN = /^[|\s]+$/

export type Reach4LifeUnitKind = "scripture" | "furniture" | "content"

/**
 * The style name on its own: the engine reports the applied style as InDesign
 * writes it, `ParagraphStyle/Poetry%3aq1`, URL-encoding the `:` that separates
 * a style group from its children. Both are undone here so every rule below can
 * work in plain `Group:Subgroup:marker` form.
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

export interface Reach4LifeStylePath {
  /** Group segments, outermost first, with the marker removed. */
  readonly groups: readonly string[]
  /** The last segment — the USFM-ish marker, e.g. `q1`, `im`, `TOC Entry`. */
  readonly marker: string
}

/** Split a style name into its group path and its marker. */
export function styleParts(styleName: string): Reach4LifeStylePath {
  const segments = decodeStyleName(styleName).split(":")
  return {
    groups: segments.slice(0, -1),
    marker: segments[segments.length - 1] ?? "",
  }
}

/**
 * A group segment reduced to its identity: lower-cased, with the ordering
 * prefix the workbook numbers its features with (`8_T4J Journeys`) and the
 * scripture volume's `Metatext_` qualifier removed. That makes the two
 * templates' names for one thing — `Metatext_BBI Bible Book Intros` and
 * `6_BBI Bible Book Intros` — compare equal.
 */
export function normalizeGroup(segment: string): string {
  return segment
    .trim()
    .toLowerCase()
    .replace(/^\d+_/, "")
    .replace(/^metatext_/, "")
}

/** True for the published NIrV text, its poetry, headings and book titles. */
export function isReach4LifeScriptureStyle(paragraphStyle: string): boolean {
  const { groups, marker } = styleParts(paragraphStyle)
  const normalized = groups.map(normalizeGroup)
  if (normalized.some((group) => SCRIPTURE_GROUPS.has(group))) return true
  return normalized.includes(PSALM_HEADING_GROUP)
    && PSALM_SCRIPTURE_MARKERS.has(marker.trim().toLowerCase())
}

/** True for page numbers, running heads, TOC markers and production notes. */
export function isReach4LifeFurnitureStyle(paragraphStyle: string): boolean {
  const decoded = decodeStyleName(paragraphStyle)
  if (FURNITURE_STYLES.has(decoded)) return true
  const { groups, marker } = styleParts(paragraphStyle)
  if (groups.map(normalizeGroup).some((group) => FURNITURE_GROUPS.has(group))) return true
  return PRODUCTION_MARKER_PATTERN.test(marker.trim())
}

/**
 * Which of the three buckets a paragraph falls into. Anything that is neither
 * scripture nor furniture is content, so an unrecognised lesson style is
 * imported instead of dropped.
 */
export function classifyReach4LifeUnit(paragraphStyle: string): Reach4LifeUnitKind {
  if (isReach4LifeScriptureStyle(paragraphStyle)) return "scripture"
  if (isReach4LifeFurnitureStyle(paragraphStyle)) return "furniture"
  return "content"
}

/** Section a paragraph belongs to, as an identity plus a label to show. */
export interface Reach4LifeSection {
  /** Stable id — the normalized group name, shared across both templates. */
  readonly id: string
  /** User-facing name, e.g. "Who am I?" or "Book introductions". */
  readonly label: string
}

/**
 * Reach4Life's own names for its features. The style groups abbreviate them
 * (`4_WAI`, `9_SIE`) or describe them structurally (`Additional`), neither of
 * which reads well in a navigator.
 */
const SECTION_LABELS: ReadonlyMap<string, string> = new Map([
  ["bbi bible book intros", "Book introductions"],
  ["intros", "Introduction"],
  ["copyright", "Copyright"],
  ["additional", "Contents"],
  ["title page", "Title page"],
  ["toc how to use", "How to use this book"],
  ["wai", "Who am I?"],
  ["story", "The story"],
  ["t4j journeys", "The 4 journeys"],
  ["sie", "Sex is everywhere"],
  ["psalms", "Psalms"],
  ["hot hot topics", "Hot topics"],
  ["deep thats deep", "That's deep"],
  ["r4l group", "Reach4Life group"],
])

/** Sections whose content is the workbook's teaching rather than its apparatus. */
const LESSON_SECTIONS: ReadonlySet<string> = new Set([
  "wai", "story", "t4j journeys", "sie", "psalms",
  "hot hot topics", "deep thats deep", "r4l group",
])

const BOOK_INTRO_SECTION = "bbi bible book intros"

/** Which part of the edition a cell came from, for grouping and labels. */
export type Reach4LifeContentType = "book-intro" | "lesson" | "front-matter"

/**
 * The section a content paragraph belongs to.
 *
 * The outermost group that names something — the workbook's template root names
 * only the template — decides, so `R4Lv4 Paragraph Styles:8_T4J Journeys:li1`
 * and `R4Lv4 Paragraph Styles:8_T4J Journeys:m` land in one section, as do a
 * scripture volume's `Intros:ili` and `Intros:is1`.
 */
export function sectionForStyle(paragraphStyle: string): Reach4LifeSection {
  const { groups } = styleParts(paragraphStyle)
  const named = groups
    .map((group) => ({ raw: group, id: normalizeGroup(group) }))
    .find((group) => group.id.length > 0 && !TEMPLATE_ROOT_GROUPS.has(group.id))
  if (!named) return { id: "other", label: "Other" }
  return {
    id: named.id,
    label: SECTION_LABELS.get(named.id) ?? named.raw.trim().replace(/^\d+_/, ""),
  }
}

export function contentTypeForSection(sectionId: string): Reach4LifeContentType {
  if (sectionId === BOOK_INTRO_SECTION) return "book-intro"
  return LESSON_SECTIONS.has(sectionId) ? "lesson" : "front-matter"
}

export function isBookIntroSection(sectionId: string): boolean {
  return sectionId === BOOK_INTRO_SECTION
}

/**
 * True for the paragraph that titles a book introduction (`imt1`, "Matthew").
 * Its text names the book the surrounding introduction is about.
 */
export function isReach4LifeBookTitleStyle(paragraphStyle: string): boolean {
  return isBookIntroMarker(paragraphStyle, "imt1")
}

/**
 * True for the strapline set *above* a book title (`cl`, "Stories about
 * Jesus") — the collection the book belongs to. It is the only paragraph that
 * precedes the title while belonging to the introduction the title opens, so
 * it is also the only one a title may claim backwards.
 */
export function isReach4LifeBookStraplineStyle(paragraphStyle: string): boolean {
  return isBookIntroMarker(paragraphStyle, "cl")
}

function isBookIntroMarker(paragraphStyle: string, marker: string): boolean {
  const parts = styleParts(paragraphStyle)
  return parts.groups.map(normalizeGroup).includes(BOOK_INTRO_SECTION)
    && parts.marker.trim().toLowerCase() === marker
}

/** The USFM code for the book a title paragraph names, when it names one. */
export function parseReach4LifeBookCode(text: string): string | undefined {
  return matchLeadingBookName(text)?.bookCode
}

/** True when visible text is empty after stripping ACE markers and whitespace. */
export function isStructuralOnlyContent(segments: readonly string[]): boolean {
  const visible = segments
    .join("")
    .replace(ACE_MARKER_PATTERN, "")
    .replace(/\s+/g, "")
    .trim()
  return visible.length === 0
}

/**
 * True for a frame holding only the `|` glyph that separates the two halves of
 * a running head. Reach4Life sets each half as its own paragraph, so one side
 * is always just the glyph.
 */
export function isRunningHeadGlyph(text: string): boolean {
  const trimmed = text.replace(ACE_MARKER_PATTERN, "").trim()
  return trimmed.length > 0 && RUNNING_HEAD_GLYPH_PATTERN.test(trimmed)
}
