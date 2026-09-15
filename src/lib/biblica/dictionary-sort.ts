/**
 * AQU-1276 — re-sorting a translated BSB Bible Dictionary into the target
 * language's alphabet.
 *
 * The dictionary volume is a Biblica front/back-matter IDML package (AQU-862):
 * one `head:ms1` heading per English letter, and under each a run of entries.
 * An entry is a headword paragraph followed by one or more explanation
 * paragraphs. Translation leaves that English A–Z order in place, so "Church"
 * stays under **C** even though the French headword "Église" belongs under
 * **E** and the Arabic one belongs in a different script entirely.
 *
 * This module is the ordering engine on its own: it reads the *target* text,
 * groups each headword with the paragraphs that explain it, orders the blocks
 * by locale-aware collation, and says which letter headings the target alphabet
 * needs. It deliberately stops there — it returns a *plan* (cell ids in their
 * new order) and never mutates its input, so the source (English) order is
 * untouched and the source/target alignment still round-trips.
 *
 * Applying that plan is a separate, undecided question (the ticket's Open
 * question 1: IDML export vs. an in-app action vs. a per-language script). Note
 * for whoever takes it: `exportIdml` replaces text *in place* at each cell's
 * original locator, so applying this plan at export time means writing entry
 * N's text into entry M's locators — which only works where the two blocks hold
 * the same number of paragraphs. That mismatch is the real cost of the
 * export-time option and is why this module reports block sizes.
 */

import { isBiblicaMajorSectionHeadingStyle } from "./note-rules"

/**
 * The cell shape the sort reads. Structural rather than `CellData` so a
 * one-off per-language script can feed it rows straight from the projection.
 */
export interface DictionaryCell {
  readonly id: string
  /** `metadata.biblica.paragraphStyle` — the InDesign style the paragraph is set in. */
  readonly paragraphStyle?: string | undefined
  /** The translated text of this paragraph. Empty where the cell is untranslated. */
  readonly text: string
}

export type DictionaryBlockKind =
  /** A `head:ms1` per-letter heading ("A", "B", …) from the source alphabet. */
  | "letter-heading"
  /** A headword paragraph plus the explanation paragraphs that follow it. */
  | "entry"
  /** Anything ahead of the first letter heading — the volume title, a preface. */
  | "preamble"

export interface DictionaryBlock {
  readonly kind: DictionaryBlockKind
  /** Every cell in the block, in document order. Always at least one. */
  readonly cellIds: readonly string[]
  /**
   * The text the block sorts by: the translated headword for an entry, the
   * heading text for a letter heading, `""` for preamble.
   */
  readonly headword: string
  /** Position in the source document, used to break collation ties. */
  readonly sourceIndex: number
}

export interface DictionaryGrouping {
  readonly blocks: readonly DictionaryBlock[]
  /**
   * The paragraph style a headword is set in, inferred from the volume itself:
   * the first content paragraph after a letter heading is a headword by
   * construction, so its style names the headword style for the whole volume.
   * `null` when the volume carries no style information to infer it from.
   */
  readonly headwordStyle: string | null
}

/** A letter of the target alphabet, and the entries that fall under it. */
export interface DictionaryLetter {
  /** The collation letter itself, upper-cased for the locale ("E", "ا"). */
  readonly letter: string
  /**
   * The source heading cell reused for this letter, or `undefined` when the
   * target alphabet needs a letter the English volume never had a heading for.
   */
  readonly headingCellId?: string
  readonly entryCount: number
}

export interface SortDictionaryOptions {
  /** BCP-47 tag of the target language — "fr", "ar", "mr". */
  readonly locale: string
  /**
   * Leading articles to ignore when deriving a headword's letter. Arabic
   * headwords commonly carry the definite article "ال", which would otherwise
   * file the whole dictionary under alef. Empty by default: which articles a
   * language sorts under is a call for the translators, not a default to guess
   * (the ticket's Open question 3).
   */
  readonly ignoreLeadingArticles?: readonly string[]
}

export type SortDictionaryResult =
  | {
      readonly ok: true
      /** Every cell id in target-alphabet order, entry blocks kept intact. */
      readonly order: readonly string[]
      readonly letters: readonly DictionaryLetter[]
      /**
       * Source letter headings the target alphabet has no entries for — an
       * English "K" section whose headwords all moved elsewhere. Left behind,
       * these are the "empty English letters" the ticket calls out.
       */
      readonly retiredHeadingCellIds: readonly string[]
      /** Entry blocks whose headword is still untranslated, so cannot be placed. */
      readonly untranslatedEntryCellIds: readonly string[]
    }
  | {
      readonly ok: false
      readonly reason: "no-headword-style"
      readonly detail: string
    }

/** Combining marks NFD splits an accented Latin letter into. */
const COMBINING_MARKS = /[̀-ͯ]/g

/** Arabic harakat and sukun — diacritics NFD does not decompose. */
const ARABIC_DIACRITICS = /[ً-ْٰ]/g

/** Alef with any hamza/madda sits under plain alef. */
const ALEF_VARIANTS = /[آأإٱ]/g

/** Bucket for a headword whose first character is not a letter at all. */
export const OTHER_LETTER = "#"

/**
 * Group a dictionary volume's cells into letter headings and entry blocks.
 *
 * Entry boundaries are the ticket's Open question 2. Rather than hard-coding a
 * style name we have no sample of, the headword style is inferred from the
 * volume: the first text-bearing paragraph after a letter heading *is* a
 * headword, so whatever style it is set in is the headword style. Every later
 * paragraph in that style opens a new entry; everything else attaches to the
 * entry above it, which is what keeps explanations with their headword.
 */
export function groupDictionaryEntries(
  cells: readonly DictionaryCell[],
): DictionaryGrouping {
  const headwordStyle = inferHeadwordStyle(cells)
  const blocks: DictionaryBlock[] = []
  let current: { kind: DictionaryBlockKind; cellIds: string[]; headword: string; sourceIndex: number } | null = null

  const flush = () => {
    if (current) blocks.push({ ...current, cellIds: [...current.cellIds] })
    current = null
  }

  for (const [index, cell] of cells.entries()) {
    const style = cell.paragraphStyle ?? ""
    if (style && isBiblicaMajorSectionHeadingStyle(style)) {
      flush()
      blocks.push({
        kind: "letter-heading",
        cellIds: [cell.id],
        headword: normalizeHeadword(cell.text),
        sourceIndex: index,
      })
      continue
    }
    const opensEntry = headwordStyle !== null && style === headwordStyle
    if (opensEntry || current === null) {
      flush()
      current = {
        kind: opensEntry ? "entry" : "preamble",
        cellIds: [cell.id],
        headword: opensEntry ? normalizeHeadword(cell.text) : "",
        sourceIndex: index,
      }
      continue
    }
    current.cellIds.push(cell.id)
  }
  flush()

  return { blocks, headwordStyle }
}

/**
 * The letter a headword files under in the target alphabet.
 *
 * Accents fold into their base letter so French "Église" files under **E**, and
 * Arabic alef variants fold into plain alef so "أب" and "ابن" share a section.
 * Leading punctuation and quotes are skipped; a headword with no letter in it
 * at all falls to {@link OTHER_LETTER}.
 */
export function dictionaryCollationLetter(
  headword: string,
  options: SortDictionaryOptions,
): string {
  let text = normalizeHeadword(headword)
  for (const article of options.ignoreLeadingArticles ?? []) {
    if (article && text.startsWith(article) && text.length > article.length) {
      text = text.slice(article.length).trimStart()
      break
    }
  }
  const folded = text
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(ARABIC_DIACRITICS, "")
    .replace(ALEF_VARIANTS, "ا")
  for (const char of folded) {
    // `\p{L}` rather than a case check: Arabic and Devanagari are caseless.
    if (/\p{L}/u.test(char)) return char.toLocaleUpperCase(options.locale)
  }
  return OTHER_LETTER
}

/**
 * Plan a re-sort of a translated dictionary volume.
 *
 * Returns the new cell order and the letter sections the target alphabet needs.
 * Nothing is mutated: `cells` is read only for its target text, so the source
 * side is untouched by construction.
 */
export function sortDictionaryEntries(
  cells: readonly DictionaryCell[],
  options: SortDictionaryOptions,
): SortDictionaryResult {
  const { blocks, headwordStyle } = groupDictionaryEntries(cells)
  if (headwordStyle === null) {
    return {
      ok: false,
      reason: "no-headword-style",
      detail:
        "No headword paragraph style could be inferred: the volume has no `head:ms1` letter heading followed by a styled paragraph.",
    }
  }
  // A headword style is only inferred from a paragraph that then becomes an
  // entry itself, so a volume that gets this far always has entries to sort.
  const entries = blocks.filter((block) => block.kind === "entry")

  const collator = new Intl.Collator(options.locale, {
    usage: "sort",
    sensitivity: "variant",
    numeric: true,
  })
  const placed = entries.filter((entry) => entry.headword !== "")
  const untranslated = entries.filter((entry) => entry.headword === "")
  const sorted = [...placed].sort(
    (a, b) =>
      collator.compare(a.headword, b.headword) || a.sourceIndex - b.sourceIndex,
  )

  // Heading cells are reused letter by letter in the order the sorted entries
  // ask for them, so a volume whose target alphabet is shorter than English
  // leaves the surplus headings behind rather than stranding them mid-volume.
  const sourceHeadings = blocks.filter((block) => block.kind === "letter-heading")
  const letters: DictionaryLetter[] = []
  const order: string[] = []
  for (const block of blocks) {
    if (block.kind === "preamble") order.push(...block.cellIds)
  }
  let currentLetter: string | null = null
  for (const entry of sorted) {
    const letter = dictionaryCollationLetter(entry.headword, options)
    if (letter !== currentLetter) {
      const headingCellId = sourceHeadings[letters.length]?.cellIds[0]
      letters.push({
        letter,
        ...(headingCellId ? { headingCellId } : {}),
        entryCount: 0,
      })
      if (headingCellId) order.push(headingCellId)
      currentLetter = letter
    }
    const open = letters[letters.length - 1]
    if (open) letters[letters.length - 1] = { ...open, entryCount: open.entryCount + 1 }
    order.push(...entry.cellIds)
  }

  // Untranslated entries keep their document order and sit after the alphabet
  // rather than being filed under a letter derived from English.
  for (const entry of untranslated) order.push(...entry.cellIds)

  const retiredHeadingCellIds = sourceHeadings
    .slice(letters.length)
    .flatMap((heading) => [...heading.cellIds])

  return {
    ok: true,
    order,
    letters,
    retiredHeadingCellIds,
    untranslatedEntryCellIds: untranslated.flatMap((entry) => [...entry.cellIds]),
  }
}

/**
 * The style of the first text-bearing paragraph that follows a letter heading.
 * That paragraph is a headword by construction, so it names the style without
 * the importer having to know what Biblica called it.
 */
function inferHeadwordStyle(cells: readonly DictionaryCell[]): string | null {
  let afterHeading = false
  for (const cell of cells) {
    const style = cell.paragraphStyle ?? ""
    if (style && isBiblicaMajorSectionHeadingStyle(style)) {
      afterHeading = true
      continue
    }
    if (afterHeading && style) return style
  }
  return null
}

/** Soft hyphens are typesetting hints InDesign stores in the text itself. */
function normalizeHeadword(text: string): string {
  return text.replace(/­/g, "").replace(/\s+/g, " ").trim()
}
