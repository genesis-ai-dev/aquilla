// AQU-1278: the short verses of one chapter, as a row of chips.
//
// The chapter card answers "which cells", and until now it answered it with two
// bars — which say how many, never which. A chip per outstanding verse turns the
// answer into somewhere to click.
//
// THE ROW NEVER WRAPS. Sam's rule (2026-09-16): "as many as fit in one row,
// depending entirely on if the pills fit — I do not want any wrapping." A
// second row would push the planning controls below the fold on a short panel
// and make a card whose height depends on how badly a chapter is doing. So the
// chips are a FIXED WIDTH and the count is arithmetic over the row's measured
// width, exactly as `PlanRow` fits its avatar strip.
//
// Pure and free of React so the overflow rule can be tested directly: happy-dom
// reports every width as zero, so a component test can never exercise it.

/**
 * One chip's width in pixels, and the gap between two.
 *
 * A verse label is "12:4" — four or five characters at 11px in the app's
 * tabular numerals, plus the chip's own padding. Fixed rather than measured
 * because the fit has to be decided BEFORE anything is rendered, and because a
 * row of chips that are all the same width reads as a set where a ragged one
 * reads as a sentence. "150:26" is the widest a real reference gets and still
 * fits; a longer one truncates rather than widening the row.
 */
export const VERSE_CHIP_PX = 46
export const VERSE_CHIP_GAP_PX = 4

/** How many chips fit across `available` pixels, gaps included. */
export function verseChipsThatFit(available: number): number {
  if (!Number.isFinite(available)) return Number.POSITIVE_INFINITY
  if (available < VERSE_CHIP_PX) return 0
  return 1 + Math.floor((available - VERSE_CHIP_PX) / (VERSE_CHIP_PX + VERSE_CHIP_GAP_PX))
}

/**
 * Split the short verses into the chips this row can draw and the number it has
 * to fold into a "+N".
 *
 * THE COUNT CHIP IS RESERVED FIRST AND DROPPED LAST, the same rule the board's
 * avatar strip follows and for the same reason: a reader who counts two chips
 * and believes two cells are left has been misled by the panel rather than
 * informed by it. When only one slot survives it holds "+7", not one arbitrary
 * verse — a single verse out of seven is the least useful thing the row could
 * say with its last slot.
 */
export function verseChipSplit(
  total: number,
  capacity: number,
): { shown: number; overflow: number } {
  if (total <= 0) return { shown: 0, overflow: 0 }
  if (capacity >= total) return { shown: total, overflow: 0 }
  // Everything below here needs a count chip, so one slot is spoken for.
  const shown = Math.max(0, Math.min(total, capacity - 1))
  return { shown, overflow: total - shown }
}

/** A verse as the chapter detail returns it. */
export interface ShortVerse {
  cellId: string
  ref: string
  filled: boolean
  validated: boolean
}

/**
 * Which verses of a chapter are outstanding, in the order the server returned
 * them (canonical).
 *
 * `lead` follows the unit's own shortfall: a chapter with untranslated cells
 * lists THOSE, because a cell nobody has written cannot be validated and a chip
 * pointing at one would send a reader to do the other job first. Otherwise it
 * lists the unvalidated. Never both — the row has space for one queue.
 */
export function shortVerses(
  verses: readonly ShortVerse[],
  lead: "untranslated" | "unvalidated",
): ShortVerse[] {
  return lead === "untranslated"
    ? verses.filter((v) => !v.filled)
    : verses.filter((v) => v.filled && !v.validated)
}

/**
 * What one chip prints: the chapter and verse, without the book.
 *
 * "GEN 12:4" → "12:4". The card's own title already says which chapter, and the
 * book is three inches up in the panel header — repeating either costs the row
 * a chip. A ref with no chapter at all ("TIT:4", a one-chapter book) keeps just
 * its verse, and anything unparseable falls back to the whole ref rather than
 * inventing a number.
 */
export function verseChipLabel(ref: string, sectionKey: string): string {
  const tail = ref.startsWith(`${sectionKey}:`) ? ref.slice(sectionKey.length + 1) : null
  if (tail !== null && tail.length > 0) {
    // "GEN 12:4" under section "GEN 12" leaves "4"; prefix the chapter back on
    // so a chip reads as a reference rather than as a bare ordinal.
    const chapter = /\s(\d+)$/.exec(sectionKey)?.[1]
    return chapter ? `${chapter}:${tail}` : tail
  }
  // Not this section's own shape. Strip a leading book code if there is one.
  const match = /^\S+\s+(\d+:\d+)$/.exec(ref)
  return match ? match[1] : ref
}
