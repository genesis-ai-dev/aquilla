/**
 * Where to cut a Treasure Hunt note into sentence-sized cells.
 *
 * Same scan as the study-Bible cutter (`../sentence-cuts`), tuned for what this
 * edition actually contains. Treasure Hunt copy is written for children: short
 * declarative sentences, direct questions, and activity instructions. It carries
 * almost none of the scholarly abbreviations a study note does, and — the
 * difference that matters — it names passages in running prose, "Adam's name is
 * first used in Genesis 4. Before that he is just called the man." A study Bible
 * would set that as a citation, so its cutter refuses to break after any bare
 * number; here that refusal would weld most fact blocks into one cell. Numbered
 * lists are the case that rule protects, and in this template they only ever
 * open a paragraph ("1. Go deep in the Bible"), which `numberEndsSentence`
 * still leaves alone.
 */

import { sentenceCutPoints } from "../sentence-cuts"

/**
 * Abbreviations that appear in Treasure Hunt copy. The scholarly apparatus of a
 * study note ("cf.", "lit.", "LXX.") is absent; what remains is titles, times
 * and eras, plus the two Latin connectives the front matter uses.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "e.g.", "i.e.", "etc.", "vs.",
  "mr.", "mrs.", "ms.", "dr.", "st.", "sts.", "rev.", "fr.", "jr.", "sr.",
  "a.d.", "b.c.", "b.c.e.", "c.e.", "a.m.", "p.m.",
  "no.", "nos.", "p.", "pp.", "cm.", "km.", "kg.",
])

/**
 * Cut points for Treasure Hunt note text.
 *
 * `text` must be the unit's concatenated slot text — the coordinate space
 * `sliceIdmlUnit` cuts in.
 */
export function treasureHuntSentenceCutPoints(text: string): readonly number[] {
  return sentenceCutPoints(text, { abbreviations: ABBREVIATIONS, numberEndsSentence: true })
}
