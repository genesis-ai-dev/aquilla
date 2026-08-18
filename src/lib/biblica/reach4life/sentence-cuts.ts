/**
 * Where to cut a Reach4Life paragraph into sentence-sized cells.
 *
 * Same scan as the study-Bible cutter (`../sentence-cuts`), tuned for workbook
 * copy written for teenagers: short declarative sentences, direct questions and
 * instructions, with none of a study note's scholarly apparatus.
 *
 * Unlike the Treasure Hunt cutter, this one keeps the study Bible's refusal to
 * break after a bare number. Reach4Life sets enumerated advice as a single
 * paragraph — "1. Listen. This is how we show the person we care. 2. Watch.
 * Signs that someone …" — so a break after "2." would strand the enumerator on
 * the end of the previous cell. Passages are named in parentheses ("(Genesis
 * 1:27)") or on their own reference line, never as a bare trailing number, so
 * nothing is lost by leaving those alone.
 */

import { sentenceCutPoints } from "../sentence-cuts"

/**
 * Abbreviations that appear in Reach4Life copy: titles, eras and times, the
 * page-reference labels the workbook cross-links with ("Rpg 48", "Bpg 112"),
 * and the two Latin connectives its explanatory prose uses.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "e.g.", "i.e.", "etc.", "vs.", "v.", "vv.",
  "mr.", "mrs.", "ms.", "dr.", "st.", "sts.", "rev.", "fr.", "jr.", "sr.",
  "a.d.", "b.c.", "b.c.e.", "c.e.", "a.m.", "p.m.",
  "no.", "nos.", "p.", "pp.", "rpg.", "bpg.",
])

/**
 * Cut points for Reach4Life paragraph text.
 *
 * `text` must be the unit's concatenated slot text — the coordinate space
 * `sliceIdmlUnit` cuts in.
 */
export function reach4LifeSentenceCutPoints(text: string): readonly number[] {
  return sentenceCutPoints(text, { abbreviations: ABBREVIATIONS })
}
