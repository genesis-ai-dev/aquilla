// The language and direction of the pack's original-language text (AQU-1700).
//
// Pack 1.2.0 adds the Old Testament: Hebrew morphemes (and Aramaic ones, in
// parts of Daniel, Ezra, Jeremiah 10:11 and Genesis 31:47), which read right
// to left inside an interface that may read left to right. Whatever shows a
// pack word or a note's quote marks it with these, so the browser lays it out
// RTL and picks a Hebrew font, and a screen reader knows the language. Pure.

import { getTestament } from "@/lib/codex-editor/bible-books"
import type { BkpWord, BkpWordId } from "./pack-types"

export interface OriginalScript {
  /** BCP 47: Koine Greek, Biblical Hebrew, or (Official) Aramaic. */
  lang: "grc" | "hbo" | "arc"
  dir: "ltr" | "rtl"
}

const GREEK: OriginalScript = { lang: "grc", dir: "ltr" }
const HEBREW: OriginalScript = { lang: "hbo", dir: "rtl" }
const ARAMAIC: OriginalScript = { lang: "arc", dir: "rtl" }

/** A pack word's script: an OT morpheme ("o…") is Hebrew, or Aramaic when Macula says so; an NT word is Greek. */
export function wordScript(wordId: BkpWordId, word?: Pick<BkpWord, "lang">): OriginalScript {
  if (!wordId.startsWith("o")) return GREEK
  return word?.lang === "A" ? ARAMAIC : HEBREW
}

/** The script of a book's original text, for what has no word of its own (a note's quote). */
export function bookScript(book: string): OriginalScript {
  return getTestament(book) === "OT" ? HEBREW : GREEK
}
