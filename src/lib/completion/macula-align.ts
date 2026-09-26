/**
 * macula-align.ts — original-language (Greek/Hebrew) word alignment. (AQU-462)
 *
 * Pure, deterministic, client-side. No network calls.
 *
 * ## What this adds over `alignCell`
 *
 * `interlinear.ts` aligns whatever string sits in `cell.original` to the
 * translation. When that string is a Macula Hebrew or Greek verse, aligning the
 * *surface* forms alone is a losing game: the original languages inflect so
 * heavily that a given form often occurs once in a whole book, and a
 * co-occurrence model has nothing to say about a token it has seen once.
 *
 * The Macula import already stores the lemma of every word (`cell_word_morph`,
 * AQU-178). So when the surface form draws a blank we align the *lemma*
 * instead — the lexical form is shared by every inflection of the word, so it
 * accumulates the statistics the surface form cannot. That is the "fuzzy"
 * alignment the ticket asks for: a dirty-but-useful link, clearly labelled as
 * lemma-derived so the translator can weigh it accordingly.
 *
 * Alignment quality is never silently overstated: a lemma-derived link is
 * discounted (`LEMMA_CONFIDENCE_DISCOUNT`) and carries `basis: "lemma"`, and a
 * word with no support at all comes back as `basis: "none"` rather than being
 * dropped — the interlinear must show every original word, including the ones
 * the model cannot place.
 */

import {
  alignCell,
  CONFIDENCE_MIN,
  type AlignmentLink,
  type AlignmentModel,
} from "./interlinear"
import type { MorphWord } from "@/lib/sync/morph-read"

/** Same class as `interlinear.ts` — combining marks belong to the word. */
const TOKEN_RE = /[\p{L}\p{N}\p{M}]+/gu

/**
 * A lemma link is real evidence, but weaker than a surface match: it says
 * "some inflection of this word tends to be rendered here", not "this form
 * was". The discount keeps a lemma guess from outranking a surface hit in any
 * UI that sorts or bands by confidence.
 */
export const LEMMA_CONFIDENCE_DISCOUNT = 0.85

/** How a word's target link was arrived at. */
export type AlignmentBasis = "surface" | "lemma" | "none"

/** One original-language word with the target word it maps to (if any). */
export interface OriginalWordAlignment {
  /** 1-based position within the cell, straight from the morph row. */
  wordSeq: number
  surface: string
  lemma?: string
  morphCode?: string
  /** Whichever Strong's number the corpus carries for this word. */
  strongs?: string
  /** Aligned target token, or null when the model cannot place this word. */
  tgtToken: string | null
  /** Confidence in [0, 1]; 0 when `basis` is "none". */
  confidence: number
  basis: AlignmentBasis
}

export interface AlignOriginalOpts {
  /** Minimum confidence for a link to be offered. Default `CONFIDENCE_MIN`. */
  threshold?: number
}

function tokenCount(s: string): number {
  return Array.from(s.matchAll(TOKEN_RE)).length
}

/**
 * Token index ranges, one per word, over the tokenization of `words.map(pick)`
 * joined by spaces — the exact string handed to `alignCell`.
 *
 * A word is not always one token: a Hebrew form joined by maqqef tokenizes into
 * two, and a punctuation-only entry into none. Walking the counts in order is
 * what keeps word N pointing at its own tokens rather than drifting after the
 * first multi-token word in the verse.
 */
function wordTokenRanges(parts: readonly string[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  let cursor = 0
  for (const part of parts) {
    const count = tokenCount(part)
    ranges.push({ start: cursor, end: cursor + count })
    cursor += count
  }
  return ranges
}

/** Best link whose source token falls inside [start, end). */
function bestLinkInRange(
  links: readonly AlignmentLink[],
  range: { start: number; end: number },
): AlignmentLink | null {
  let best: AlignmentLink | null = null
  for (const link of links) {
    if (link.srcIndex < range.start || link.srcIndex >= range.end) continue
    if (!best || link.confidence > best.confidence) best = link
  }
  return best
}

/** The verse as the alignment model sees it: surface forms in text order. */
export function originalWordsToText(words: readonly MorphWord[]): string {
  return words.map((w) => w.surface).join(" ").normalize("NFC")
}

/**
 * Align each original-language word of a cell to a target word.
 *
 * @param words   Morph rows for one cell, in `wordSeq` order.
 * @param target  The translation of that cell.
 * @param model   Model from `buildAlignmentModel` (trained on this project's
 *                own source↔target pairs — i.e. on the original-language text,
 *                when the project's source file is the Macula import).
 * @returns One entry per input word, in the same order. Never drops a word.
 */
export function alignOriginalWords(
  words: readonly MorphWord[],
  target: string,
  model: AlignmentModel | null,
  opts: AlignOriginalOpts = {},
): OriginalWordAlignment[] {
  const threshold = opts.threshold ?? CONFIDENCE_MIN

  const base = words.map((w) => ({
    wordSeq: w.wordSeq,
    surface: w.surface,
    ...(w.lemma ? { lemma: w.lemma } : {}),
    ...(w.morphCode ? { morphCode: w.morphCode } : {}),
    ...(w.strongsH ?? w.strongsG ? { strongs: w.strongsH ?? w.strongsG } : {}),
    tgtToken: null as string | null,
    confidence: 0,
    basis: "none" as AlignmentBasis,
  }))

  if (base.length === 0 || !model || !target.trim()) return base

  const surfaces = words.map((w) => w.surface.normalize("NFC"))
  const surfaceLinks = alignCell(surfaces.join(" "), target, model, { threshold })
  const surfaceRanges = wordTokenRanges(surfaces)

  // The lemma pass runs over its own string, so it needs its own ranges: a
  // lemma rarely tokenizes to the same count as the form it stands for.
  const lemmas = words.map((w) => (w.lemma ?? w.surface).normalize("NFC"))
  const lemmaLinks = alignCell(lemmas.join(" "), target, model, {
    // Ask below the caller's floor and apply the discount ourselves, so a link
    // that only clears the bar before discounting is not reported as if it did.
    threshold: threshold * LEMMA_CONFIDENCE_DISCOUNT,
  })
  const lemmaRanges = wordTokenRanges(lemmas)

  return base.map((word, i) => {
    const surfaceLink = bestLinkInRange(surfaceLinks, surfaceRanges[i])
    if (surfaceLink) {
      return {
        ...word,
        tgtToken: surfaceLink.tgtToken,
        confidence: surfaceLink.confidence,
        basis: "surface" as AlignmentBasis,
      }
    }

    const lemmaLink = bestLinkInRange(lemmaLinks, lemmaRanges[i])
    if (lemmaLink) {
      const confidence = lemmaLink.confidence * LEMMA_CONFIDENCE_DISCOUNT
      if (confidence >= threshold) {
        return {
          ...word,
          tgtToken: lemmaLink.tgtToken,
          confidence,
          basis: "lemma" as AlignmentBasis,
        }
      }
    }

    return word
  })
}
