// Scoring for the Bridge 1/2 alignment evaluation (AQU-1694).
//
// A link is a (Greek word id, target token id) pair. Gold is Clear's manual
// alignment: a record with sources S and targets T gives every S × T pair.
//   precision = predicted links in gold / predicted links
//   recall    = predicted links in gold / gold links
//   word hit  = Greek words with at least one correct link / Greek words with gold
// Recall counts only words the gold aligns. Precision counts every predicted
// link, so a link from a word the gold leaves unaligned (an article) is wrong.
//
// Classes are the ones Who's Who tints:
//   pronoun      — personal pronouns (class pron, type personal);
//   subject-verb — verbs whose implied subject the pack names (mention kind "subject");
//   proper       — proper nouns;
//   mention      — every word the pack's people layer names.

import type { BkpWord } from "../../src/lib/bible-data/pack-types"

export const CLASSES = ["all", "pronoun", "subject-verb", "proper", "mention"] as const
export type WordClass = (typeof CLASSES)[number]

export interface PredictedLink {
  wordId: string
  targetId: string
  conf: number
}

export interface ClassScore {
  predicted: number
  correct: number
  gold: number
  words: number
  wordsHit: number
}

export interface Scorer {
  add(ids: readonly string[], words: readonly BkpWord[], links: readonly PredictedLink[]): void
  scores: Record<WordClass, ClassScore>
  /** Per class, every predicted link's confidence and whether gold has it. */
  confidences: Record<WordClass, { conf: number; ok: boolean }[]>
}

export function classesOf(word: BkpWord, id: string, mentions: ReadonlyMap<string, string>): WordClass[] {
  const out: WordClass[] = ["all"]
  if (word.class === "pron" && word.type === "personal") out.push("pronoun")
  if (mentions.get(id) === "subject") out.push("subject-verb")
  if (word.class === "noun" && word.type === "proper") out.push("proper")
  if (mentions.has(id)) out.push("mention")
  return out
}

export function createScorer(gold: ReadonlyMap<string, ReadonlySet<string>>, mentions: ReadonlyMap<string, string>): Scorer {
  const empty = (): ClassScore => ({ predicted: 0, correct: 0, gold: 0, words: 0, wordsHit: 0 })
  const scores = Object.fromEntries(CLASSES.map((c) => [c, empty()])) as Record<WordClass, ClassScore>
  const confidences = Object.fromEntries(CLASSES.map((c) => [c, []])) as unknown as Scorer["confidences"]
  return {
    scores,
    confidences,
    add(ids, words, links) {
      const byWord = new Map<string, PredictedLink[]>()
      for (const link of links) byWord.set(link.wordId, [...(byWord.get(link.wordId) ?? []), link])
      ids.forEach((id, k) => {
        const expected = gold.get(id)
        const classes = classesOf(words[k], id, mentions)
        let hit = false
        for (const link of byWord.get(id) ?? []) {
          const ok = expected?.has(link.targetId) ?? false
          hit ||= ok
          for (const c of classes) {
            scores[c].predicted++
            if (ok) scores[c].correct++
            confidences[c].push({ conf: link.conf, ok })
          }
        }
        if (!expected || expected.size === 0) return
        for (const c of classes) {
          scores[c].gold += expected.size
          scores[c].words++
          if (hit) scores[c].wordsHit++
        }
      })
    },
  }
}

const pct = (n: number, d: number) => (d === 0 ? "  -  " : `${((100 * n) / d).toFixed(1)}`.padStart(5))

export function scoreRow(score: ClassScore): string {
  return `P ${pct(score.correct, score.predicted)}  R ${pct(score.correct, score.gold)}  hit ${pct(score.wordsHit, score.words)}  (${score.predicted} links, ${score.gold} gold, ${score.words} words)`
}

/** Precision of the links at or above each confidence, and how many there are. */
export function precisionByConfidence(
  points: readonly { conf: number; ok: boolean }[],
  thresholds: readonly number[],
): { min: number; precision: number | null; links: number }[] {
  return thresholds.map((min) => {
    const kept = points.filter((point) => point.conf >= min)
    return { min, precision: kept.length ? kept.filter((point) => point.ok).length / kept.length : null, links: kept.length }
  })
}

/** Precision of the links in [low, high). */
export function bandPrecision(points: readonly { conf: number; ok: boolean }[], low: number, high: number): number | null {
  const kept = points.filter((point) => point.conf >= low && point.conf < high)
  return kept.length ? kept.filter((point) => point.ok).length / kept.length : null
}
