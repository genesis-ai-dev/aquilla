// The bridges, composed (AQU-1694; design §4.5).
//
// Bridge 1 links a pack word (Greek) to a token of the project's source cell;
// Bridge 2 links a source token to a token of the target cell. Through both,
// a pack word reaches target tokens with confidence conf1 × conf2 (the best
// path when there are several).
//
// A tint draws solid only when its confidence is at least TINT_SOLID_MIN AND
// every bridge under it was trained on at least SOLID_MIN_PAIRS verse cells.
// Otherwise it draws dotted, and Who's Who calls it "approximate". An
// alignment link is never a warning, whatever its confidence: it only places
// a tint.
//
// The numbers come from scripts/bridge-align-eval.ts, against Clear's manual
// SBLGNT→BSB alignment (CC BY 4.0), with Bridge 1 trained on one book at a
// time as the product trains it:
//   • John: links at confidence ≥ 0.5 were right 92.2% of the time for
//     pronouns and for all Who's Who mentions; links below it 58–62%.
//     Composed through a second English text (Greek → BSB → YLT, Bridge 2
//     trained on 120 verses or more) the links ≥ 0.5 stayed at 91.7–94.3%.
//   • All 12 NT books of 149 verses or more kept their ≥ 0.5 pronoun links
//     at 87.7% or better (mention links: 84.6% or better). Of the 15 books
//     of 113 verses or fewer, 12 fell below 85% in pronouns or mentions (to
//     50% at worst). No NT book has between 114 and 148 verses, so 120 sits
//     in that gap. Bridge 2 measured the same way: 85.0–88.5% at 50 verses,
//     91.7–92.0% at 120.
//   • Links below ALIGN_LINK_MIN (word-align.ts) are not drawn at all; a
//     composed link below it is dropped too.
//   • AQU-1700: Old Testament pronouns fall short of the bar, so they draw
//     dotted whatever their confidence (OT_PRONOUNS_ALWAYS_DOTTED).

import type { BkpTextLayer, BkpWordId } from "./pack-types"
import { ALIGN_LINK_MIN, type AlignLink } from "./word-align"

/** At or above: a solid tint (when the training was big enough). Below: dotted, "approximate". */
export const TINT_SOLID_MIN = 0.5

/** A bridge trained on fewer verse cells than this draws only dotted tints. */
export const SOLID_MIN_PAIRS = 120

/** Bridge 2 does not run on fewer translated verse cells than this. */
export const BRIDGE2_MIN_PAIRS = 25

/** A pack word linked to a token (`tokenize` index) of some cell's text. */
export interface WordTokenLink {
  wordId: BkpWordId
  token: number
  conf: number
}

/**
 * Bridge 1 then Bridge 2: pack word → target token, conf = conf1 × conf2,
 * the best path kept, links below `min` dropped. Sorted by token, then word.
 */
export function composeBridges(
  bridge1: readonly WordTokenLink[],
  bridge2: readonly AlignLink[],
  min: number = ALIGN_LINK_MIN,
): WordTokenLink[] {
  const bySourceToken = new Map<number, AlignLink[]>()
  for (const link of bridge2) {
    const list = bySourceToken.get(link.src)
    if (list) list.push(link)
    else bySourceToken.set(link.src, [link])
  }
  const best = new Map<string, WordTokenLink>()
  for (const first of bridge1) {
    for (const second of bySourceToken.get(first.token) ?? []) {
      const conf = first.conf * second.conf
      if (conf < min) continue
      const key = `${first.wordId}\u0000${second.tgt}`
      const held = best.get(key)
      if (!held || held.conf < conf) best.set(key, { wordId: first.wordId, token: second.tgt, conf })
    }
  }
  return [...best.values()].sort((a, b) => a.token - b.token || a.wordId.localeCompare(b.wordId))
}

/**
 * How a tint draws: solid only at TINT_SOLID_MIN or above, and only when the
 * smallest training set under it (one bridge, or the smaller of two) had
 * SOLID_MIN_PAIRS verse cells.
 */
export function tintStyle(conf: number, trainedPairs: number): "solid" | "dotted" {
  return conf >= TINT_SOLID_MIN && trainedPairs >= SOLID_MIN_PAIRS ? "solid" : "dotted"
}

/**
 * AQU-1700: an Old Testament pronoun (a Macula Hebrew word of class "pron":
 * a pronominal suffix such as the ־ִי "me" of בִּי, or an independent pronoun)
 * draws dotted whatever its confidence and training size. AQU-1694 draws a
 * class solid only when its links at TINT_SOLID_MIN or above are right about
 * 85% of the time; Hebrew pronouns are not. Measured with
 * scripts/bridge-align-eval.ts (pack 1.2.0, Bridge 1 to the BSB, against
 * Clear's manual WLCM→BSB alignment; personal pronouns and pronominal
 * suffixes, links at 0.5 or above): GEN 77.6% right (1,358 links), RUT 66.7%
 * (51 links), against 92.2% for John's Greek pronouns. Set it to false once
 * they measure above the bar again, for example with suffix tokens that keep
 * person and number (every suffix has the lemma הוּא) or with a Hebrew
 * transliteration for the name constraint. NT words are never affected.
 */
export const OT_PRONOUNS_ALWAYS_DOTTED = true

/** The words of `text` whose tints draw dotted whatever their confidence: OT pronouns, while OT_PRONOUNS_ALWAYS_DOTTED. */
export function alwaysDottedWords(text: BkpTextLayer): (wordId: BkpWordId) => boolean {
  return (wordId) => {
    // A Macula Hebrew morpheme id starts with "o"; an SBLGNT word id with "n".
    if (!OT_PRONOUNS_ALWAYS_DOTTED || !wordId.startsWith("o")) return false
    const word = Object.hasOwn(text.words, wordId) ? text.words[wordId] : undefined
    return word?.class === "pron"
  }
}
