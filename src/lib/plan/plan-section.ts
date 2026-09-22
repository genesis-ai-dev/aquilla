// AQU-1278: what a section key IS, decided once.
//
// A planning unit breaks into sections, and a section key is machine-made from
// `canonical_ref` — "GEN 12" for a chapter, a bare "GEN" for a book's front
// matter or for a book that has no chapters at all, "Scene 4" for a document's
// own heading, "t:000000300000" for a media file's five-minute bucket. Four
// surfaces have to agree about which is which: the chapter grid positions
// tiles by it, the board's row names the short chapters by it, the chapter
// card titles itself with it, and the inspector counts unassigned chapters
// with it. Three of them used to answer it separately and one of the three
// was looser than the others.
//
// THE BARE BOOK CODE IS THE WHOLE REASON THIS MODULE EXISTS. "TIT" is Titus,
// which has one chapter, and Sam's rule (2026-09-16) is that a one-chapter book
// is still a book with a chapter in it: "if it's a single chapter it still is
// just a chapter, so you just put a little one there." But the identical key
// shape also arrives as Genesis's USFM front matter, sitting beside GEN 1…GEN
// 50, where calling it chapter 1 would put two tiles in one square. The key
// alone cannot tell those apart. What separates them is whether any OTHER key
// claims a numbered chapter of the same book — so every answer here takes the
// unit's whole key list, and none of these functions can be called on a key by
// itself.

import { isKnownBookCode } from "@/lib/file-labeling/bible-book-names"

/** A media file's time buckets, which are not sections anyone plans by. */
const TIME_BUCKET_PREFIX = "t:"

export type PlanSectionKind =
  /** A numbered chapter — or a one-chapter book, which is chapter 1. */
  | { kind: "chapter"; n: number }
  /** A book's front matter: a bare code beside that book's numbered chapters. */
  | { kind: "frontMatter" }
  /** Anything else with a name of its own: "Scene 4", "Prologue". */
  | { kind: "section" }

/**
 * The chapter number in a "GEN 12"-shaped key, or null.
 *
 * TWO TRAPS LIVE HERE, and both of them put a tile in the wrong square rather
 * than failing loudly.
 *
 * The first is a looser label rule — one that only has to produce something to
 * print will read "Scene 4" as "4". A grid POSITIONS by this number, so
 * borrowing that rule sits scene four in chapter four's square and leaves a
 * document file looking like a book with holes in it.
 *
 * The second is subtler: "Act 2" passes any book-code test you write, because
 * ACT is Acts. A section key is machine-made from `canonical_ref` and a USFM
 * book code is upper case in every one of them; a human-written section name in
 * a document is not. Requiring the prefix to be upper case AS WELL AS a known
 * code is what separates "ACT 2" (Acts, chapter two) from "Act 2" (the second
 * act of something), and there is no other signal in the key that can.
 */
export function planChapterNumber(key: string): number | null {
  const match = /^(\S+)\s+(\d+)$/.exec(key)
  if (!match) return null
  const [, prefix, chapter] = match
  if (prefix !== prefix.toUpperCase()) return null
  if (!isKnownBookCode(prefix)) return null
  const n = Number(chapter)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Is this key a bare book code — "TIT", "GEN" — rather than a chapter? */
function bareBookCode(key: string): boolean {
  return key === key.toUpperCase() && isKnownBookCode(key)
}

/**
 * Which book codes own at least one NUMBERED chapter in this set of keys.
 *
 * Computed over the whole list once and passed down, rather than asked per key:
 * the question "is this bare code front matter?" is about the other keys, and a
 * per-key helper would have to re-scan the list for every tile in the grid.
 */
export function numberedBookCodes(keys: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>()
  for (const key of keys) {
    if (planChapterNumber(key) == null) continue
    out.add(key.split(" ")[0])
  }
  return out
}

/**
 * What this key is, given everything else in the unit.
 *
 * A bare book code is CHAPTER 1 when nothing else claims a numbered chapter of
 * that book — a one-chapter book referenced without one — and FRONT MATTER when
 * something does, because then chapter 1 is already spoken for.
 */
export function classifyPlanSection(
  key: string,
  numbered: ReadonlySet<string>,
): PlanSectionKind {
  const chapter = planChapterNumber(key)
  if (chapter != null) return { kind: "chapter", n: chapter }
  if (bareBookCode(key)) {
    return numbered.has(key) ? { kind: "frontMatter" } : { kind: "chapter", n: 1 }
  }
  return { kind: "section" }
}

/**
 * What a tile or a row prints for this key: the chapter number, or the key
 * itself for anything that is not a chapter.
 *
 * Front matter deliberately keeps its raw key here rather than growing a word:
 * the word is translated copy and this module holds no catalog. The grid asks
 * `classifyPlanSection` and labels front matter itself.
 */
export function planSectionLabel(key: string, numbered: ReadonlySet<string>): string {
  const kind = classifyPlanSection(key, numbered)
  return kind.kind === "chapter" ? String(kind.n) : key
}

/** Is this key a media file's time bucket? Those are nobody's chapter. */
export function isTimeBucketKey(key: string): boolean {
  return key.startsWith(TIME_BUCKET_PREFIX)
}
