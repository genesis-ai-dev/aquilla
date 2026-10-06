// Bridge 2 (AQU-1694): a project's source text → its target text.
//
// The same aligner as Bridge 1 (word-align.ts), trained on the book's own
// translated cells: each cell's source text paired with its target text.
// Nothing is persisted: a target changes with every commit, so the links are
// recomputed per chapter when Who's Who needs them, and the caller caches
// them by both texts' hashes. The training costs about 0.1 s for a book of
// John's size (scripts/bridge-align-eval.ts), so the model is kept while the
// book's translated text stays the same, and rebuilt when it changes.
//
// The design asked for completion/interlinear.ts here. The measurement says
// otherwise (John, Greek → BSB → YLT): composed through it, 33% of Who's Who
// mention words reached a correct target word, against 73% through
// word-align.ts; and its confidence does not rise with precision, so
// conf1 × conf2 would not mean anything.

import { tokenize } from "@/lib/completion/tokenize"
import { contentHash } from "@/lib/dcs/content-hash"
import { BRIDGE2_MIN_PAIRS } from "./bridge-compose"
import { alignWords, trainWordAlignModel, type AlignLink, type WordAlignModel } from "./word-align"

/** One cell's two texts. */
export interface TargetPairInput {
  cellId: string
  source: string
  target: string
}

export interface TargetCellLinks {
  cellId: string
  sourceHash: string
  targetHash: string
  /** Source token → target token, both in `tokenize` order. */
  links: AlignLink[]
}

export interface TargetAlignment {
  /** The translated cells the model trained on; 0 links below BRIDGE2_MIN_PAIRS. */
  trainedPairs: number
  cells: TargetCellLinks[]
}

export interface TargetModel {
  key: string
  trainedPairs: number
  model: WordAlignModel | null
}

const hasBothTexts = (pair: TargetPairInput) => pair.source.trim() !== "" && pair.target.trim() !== ""

/** A key that changes whenever any training pair does. */
export function corpusKey(corpus: readonly TargetPairInput[]): string {
  return contentHash(corpus.filter(hasBothTexts).map((pair) => `${pair.cellId}\u0001${pair.source}\u0001${pair.target}`).join("\u0002"))
}

/** Train Bridge 2 on the book's translated cells (none below BRIDGE2_MIN_PAIRS). */
export function trainTargetModel(corpus: readonly TargetPairInput[]): TargetModel {
  const pairs = corpus.filter(hasBothTexts)
  const key = corpusKey(corpus)
  if (pairs.length < BRIDGE2_MIN_PAIRS) return { key, trainedPairs: pairs.length, model: null }
  const model = trainWordAlignModel(pairs.map((pair) => ({ src: tokenize(pair.source), tgt: tokenize(pair.target) })))
  return { key, trainedPairs: pairs.length, model }
}

/** Align the wanted cells with a trained model. */
export function alignTargetCells(trained: TargetModel, wanted: readonly TargetPairInput[]): TargetAlignment {
  const cells = wanted.filter(hasBothTexts).map((pair) => ({
    cellId: pair.cellId,
    sourceHash: contentHash(pair.source),
    targetHash: contentHash(pair.target),
    links: trained.model ? alignWords(trained.model, tokenize(pair.source), tokenize(pair.target)) : [],
  }))
  return { trainedPairs: trained.trainedPairs, cells }
}
