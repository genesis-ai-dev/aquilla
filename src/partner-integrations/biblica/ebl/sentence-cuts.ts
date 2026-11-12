/**
 * Where to cut an EBL paragraph into sentence-sized cells.
 *
 * Same scan as the study-Bible cutter (`../sentence-cuts`), tuned for training
 * material: plain instructional prose written to be read aloud to a group, with
 * scripture named in running text ("Read Genesis 1:1–3 together.") rather than
 * set as a scholarly citation.
 *
 * It keeps the study Bible's refusal to break after a bare number. A facilitator
 * guide is full of numbered steps set as one paragraph — "1. Ask the group what
 * they see. 2. Read the passage again." — so a break after "2." would strand the
 * enumerator on the end of the previous cell. Passage references here always
 * carry a chapter–verse colon or sit inside parentheses, so nothing is lost by
 * leaving bare numbers alone.
 */

import { sentenceCutPoints } from "../sentence-cuts"

/**
 * Abbreviations that appear in EBL copy: the reference and era forms its Bible
 * teaching uses, the clock forms its session timings use, and the ordinary
 * titles of English prose.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "e.g.", "i.e.", "cf.", "etc.", "vs.", "v.", "vv.", "ch.", "chs.",
  "mr.", "mrs.", "ms.", "dr.", "st.", "sts.", "rev.", "fr.", "jr.", "sr.",
  "a.d.", "b.c.", "b.c.e.", "c.e.", "a.m.", "p.m.",
  "no.", "nos.", "p.", "pp.", "min.", "hr.", "approx.",
])

/**
 * Cut points for EBL paragraph text.
 *
 * `text` must be the unit's concatenated slot text — the coordinate space
 * `sliceIdmlUnit` cuts in.
 */
export function eblSentenceCutPoints(text: string): readonly number[] {
  return sentenceCutPoints(text, { abbreviations: ABBREVIATIONS })
}
