// AQU-1278: the short verses of one chapter, as a row of chips.
//
// The chapter card answers "which cells", and until now it answered it with two
// bars — which say how many, never which. A chip per outstanding verse turns the
// answer into somewhere to click.
//
// THE ROW NEVER WRAPS; IT SCROLLS. Sam's first rule (2026-09-16) was "as many as
// fit in one row, I do not want any wrapping", and the row folded the rest into
// a "+N" chip. His second, the same day, was to let the row scroll instead:
// every verse reachable, the card's height still fixed, and no count chip,
// because the card's own header already says how many are left. So this
// module no longer decides how many chips fit — it only decides which verses
// are short and what each chip says. The chips are still a fixed width, so
// the strip reads as a set where a ragged one reads as a sentence.

import type { PlanOpenKind } from "@/lib/plan/plan-status"

/** A verse as the chapter detail returns it. */
export interface ShortVerse {
  /**
   * The cell to open. Optional: a worker from before AQU-1278 sends no cell id
   * at all, and a new client meets one for the length of a deploy. A chip
   * exists to be clicked, so `shortVerses` drops a verse without one rather
   * than drawing a chip that cannot keep its promise.
   */
  cellId?: string
  ref: string
  filled: boolean
  validated: boolean
  /**
   * The verse's own takes. Optional: a worker from before they were sent
   * omits both, and an absent flag is "unknown" — an audio lead then lists
   * no chips rather than every verse.
   */
  recorded?: boolean
  audioValidated?: boolean
}

/**
 * Which verses of a chapter are outstanding, in the order the server returned
 * them (canonical).
 *
 * `lead` is the chapter's own `planOpenKind`: a chapter with untranslated
 * cells lists THOSE, because a cell nobody has written cannot be validated and
 * a chip pointing at one would send a reader to do the other job first; then
 * the unvalidated; then, once the text is finished, the verses with no take,
 * and after AQU-490 the takes nobody has signed off. Never two queues — the
 * row has space for one.
 */
export function shortVerses(
  verses: readonly ShortVerse[],
  lead: PlanOpenKind,
): (ShortVerse & { cellId: string })[] {
  // A verse with no cell id cannot be opened — see `ShortVerse.cellId` — and a
  // chip that cannot land on its verse is worse than no chip: it repeats a
  // key across the strip and opens the top of the file when pressed.
  const openable = verses.filter((v): v is ShortVerse & { cellId: string } => Boolean(v.cellId))
  switch (lead) {
    case "untranslated": return openable.filter((v) => !v.filled)
    case "unvalidated": return openable.filter((v) => v.filled && !v.validated)
    case "unrecorded": return openable.filter((v) => v.recorded === false)
    case "unsigned": return openable.filter((v) => v.recorded === true && v.audioValidated === false)
  }
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
