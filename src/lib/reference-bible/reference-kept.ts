// AQU-1573: does the translation keep the verse references the source cites?
//
// A sermon line that says 'Isaiah 40:25 says, "…"' must still say 40:25 in
// the translation (Sam, 2026-10-04). The book name is NOT checked: the
// translation names the book in its own language ("إشعياء 40: 25", "رومية 5: 8").
// Only the numbers are, and loosely:
//
//   * the chapter and the first verse must both appear as numbers, chapter
//     first; anything may sit between them ("40:25", "40: 25", "40.25",
//     "الأصحاح 3، الآية 16");
//   * Western digits and Arabic-Indic / Eastern Arabic-Indic digits (٠-٩, ۰-۹)
//     all count, so "٤٠:٢٥" keeps Isaiah 40:25;
//   * a one-chapter book (Obadiah, Philemon, 2–3 John, Jude) needs the verse only;
//   * a range is kept by its chapter and first verse ("John 3:16-18" by 3 then
//     16), and a list is checked one passage at a time ("John 3:16, 18" needs
//     3 then 16, and 3 then 18).
//
// Which references count is the finder's call (reference-finder.ts): only an
// explicit chapter-and-verse reference, never a chapter-only mention such as
// "Read Romans 8". This needs no verse text, so it runs with or without a
// reference Bible.
//
// No path aliases: auth-worker imports this file too (see types.ts).

import { isSingleChapterBook } from "./book-aliases"
import { findScriptureReferences, uniqueReferences } from "./reference-finder"
import type { FoundReference, ScriptureRef } from "./types"

/** A reference the source cites whose numbers the translation leaves out. */
export interface DroppedReference {
  canonical: string
  /** Reader form, e.g. "Isaiah 40:25". */
  label: string
  /** Where the reference sits in the SOURCE (its first occurrence). */
  sourceStart: number
  sourceEnd: number
}

/** A run of digits in any of the three digit sets; mixed runs are not expected. */
const DIGIT_RUN = /[0-9٠-٩۰-۹]+/gu

function digitValue(ch: string): number {
  const c = ch.codePointAt(0)!
  if (c >= 0x0660 && c <= 0x0669) return c - 0x0660
  if (c >= 0x06f0 && c <= 0x06f9) return c - 0x06f0
  return c - 0x30
}

/** Every number written in `text`, in order, whatever its digits. */
export function numbersIn(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(DIGIT_RUN)) {
    let n = 0
    for (const ch of m[0]) n = n * 10 + digitValue(ch)
    out.push(n)
  }
  return out
}

/** True when `numbers` (from numbersIn) hold the reference's chapter and then its first verse. */
export function keepsReference(numbers: readonly number[], ref: ScriptureRef): boolean {
  if (isSingleChapterBook(ref.book)) return numbers.includes(ref.verseStart)
  const chapterAt = numbers.indexOf(ref.chapter)
  return chapterAt >= 0 && numbers.indexOf(ref.verseStart, chapterAt + 1) > chapterAt
}

/**
 * The references `source` cites that `target` leaves out, one per distinct
 * reference, in source order. Nothing for an empty target or a source with no
 * explicit reference.
 */
export function findDroppedReferences(
  source: string,
  target: string,
  opts: { references?: readonly FoundReference[] } = {},
): DroppedReference[] {
  if (!source || !target.trim()) return []
  const found = opts.references ?? findScriptureReferences(source)
  if (found.length === 0) return []
  const numbers = numbersIn(target)
  return uniqueReferences(found)
    .filter((f) => !keepsReference(numbers, f.ref))
    .map((f) => ({ canonical: f.canonical, label: f.label, sourceStart: f.start, sourceEnd: f.end }))
}
