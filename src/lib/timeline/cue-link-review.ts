// The pairing review list: what a person should actually look at.
// (AQU-646 stage 4, 2026-08-15)
//
// The timeline marks unpaired cells amber, which tells you WHERE they are and
// nothing about whether they matter. Episode 101 has 10 unpaired heard lines
// and 18 unpaired subtitles, and most of them are fine — "Whoa!", "Nah.",
// "Mm-hmm." are genuinely unsubtitled, and the opening screen cards are text
// nobody speaks. Scanning 28 amber chips to find the two that are real misses
// is not a job with an end.
//
// THE SIGNAL IS A HOLE IN THE ALIGNMENT, NOT PROXIMITY. Sam's instinct was
// that a lone unpaired cue surrounded by well-paired ones is suspicious in a
// way that a cluster of unpaired ones at the head of the file is not, and the
// precise version of that is: take an unpaired cue, find its nearest PAIRED
// neighbours on either side, and look at which subtitles those neighbours pair
// to. Everything between them is unaccounted for. If exactly one unpaired
// subtitle sits in that window, it is almost certainly the partner.
//
// Measured on episode 101: all 10 unpaired cues are bracketed, 5 have exactly
// one candidate, 0 are ambiguous, and the remaining 5 have none — which are
// precisely the genuinely unsubtitled utterances. So it turns 28 amber chips
// into 5 rows and a count. The opening screen cards never rank, because they
// sit outside the alignment's span and cannot bracket.
//
// AND IT FINDS MISSES THE MATCHER CANNOT MAKE. Two of those five are identical
// wording half a second apart — "No." against "No.", "We?" against "We?" —
// which `planCueLinks` can never pair, because it requires the cues to OVERLAP
// in time and two short cues that near each other do not. Rather than loosen
// the matcher (auto-linking on zero overlap is genuinely risky), the finding is
// proposed here and a person clicks accept.
//
// IT ALSO CARRIES WHAT THE MATCHER FOUND AND DELIBERATELY DID NOT WRITE
// (Sam, 2026-08-15): cross-script and weak-wording matches. Those used to be
// auto-paired, which made the person's job noticing what had been decided for
// them — nothing verified what either pair of lines actually says. They arrive
// here as proposals in their own right rather than being rediscovered by the
// bracketing, since the analysis already did that work and discarding it would
// be lossy. On episode 101 this holds back 2 of 655 pairings.

import { cueSimilarity, dominantScript, planCueLinks, type LinkableCue } from "./cue-links"
import type { CueLink } from "@/lib/sync/cell-links-read"

/** Above this, identical-enough wording makes the pairing near-certain. */
const CONFIDENT_SIM = 0.6

/** An existing pairing scraped together below this is worth an eyeball. */
const LOW_CONFIDENCE = 0.45

export interface ReviewCandidate {
  cueCellId: string
  textCellId: string
  /** max(dice, containment) between the two — 1 means the words are the same. */
  similarity: number
  /** How far apart the two starts are, seconds. */
  gapSec: number
}

export interface ReviewPair {
  cueCellId: string
  textCellId: string
  confidence: number | null
}

export interface CueLinkReview {
  /** Same words, near in time, sitting in a hole in the alignment. Accept. */
  confident: ReviewCandidate[]
  /** The matcher found these and deliberately did NOT pair them: the timings
   *  line up but the two sides are in different writing systems, so nothing
   *  compared what they say. Strong, unverified — a person's call. */
  crossScriptCandidates: ReviewCandidate[]
  /** Overlapping in time with a little shared wording, but not enough to be
   *  sure. Also found by the matcher and deliberately not paired. */
  weakCandidates: ReviewCandidate[]
  /** The only unpaired line in the hole, but the words do not agree. Judgement. */
  uncertain: ReviewCandidate[]
  /** Unpaired heard lines with no candidate at all — the real orphans. */
  unpairedCues: string[]
  /** Unpaired subtitles with no candidate — screen cards and the like. */
  unpairedText: string[]
  /** Pairings that exist but barely cleared the bar. */
  lowConfidence: ReviewPair[]
  /** Pairings between different writing systems, made on timing alone because
   *  no word comparison was possible. Nothing verified their meaning. */
  crossScript: ReviewPair[]
  /** Everything above, as one number — the size of the job. */
  actionable: number
}

const key = (textCellId: string, cueCellId: string): string => `${textCellId} ${cueCellId}`

export interface ReviewCueLinksArgs {
  /** In document order. */
  textCells: readonly LinkableCue[]
  /** In document order. */
  audioCues: readonly LinkableCue[]
  links: readonly CueLink[]
  /** Pairs a person has said are NOT pairs. Never proposed again. */
  rejected?: readonly { fromCellId: string; toCellId: string }[]
}

export function reviewCueLinks({
  textCells,
  audioCues,
  links,
  rejected,
}: ReviewCueLinksArgs): CueLinkReview {
  const cueToText = new Map<string, string[]>()
  const textToCue = new Map<string, string[]>()
  for (const l of links) {
    ;(cueToText.get(l.toCellId) ?? cueToText.set(l.toCellId, []).get(l.toCellId)!).push(l.fromCellId)
    ;(textToCue.get(l.fromCellId) ?? textToCue.set(l.fromCellId, []).get(l.fromCellId)!).push(l.toCellId)
  }
  const declined = new Set((rejected ?? []).map((r) => key(r.fromCellId, r.toCellId)))

  const textIndex = new Map(textCells.map((c, i) => [c.id, i]))
  const unpairedTextIdx = textCells
    .map((c, i) => (textToCue.has(c.id) ? -1 : i))
    .filter((i) => i >= 0)

  // What the matcher FOUND but declined to write. These are proposals in their
  // own right rather than something the bracketing has to rediscover — the
  // analysis already did the work, and throwing it away would be lossy.
  const crossScriptCandidates: ReviewCandidate[] = []
  const weakCandidates: ReviewCandidate[] = []
  for (const plan of planCueLinks({ textCells, audioCues })) {
    if (plan.basis === "words") continue
    if (cueToText.has(plan.cueCellId) || textToCue.has(plan.textCellId)) continue
    if (declined.has(key(plan.textCellId, plan.cueCellId))) continue
    const cue = audioCues.find((c) => c.id === plan.cueCellId)
    const text = textCells.find((c) => c.id === plan.textCellId)
    const row: ReviewCandidate = {
      cueCellId: plan.cueCellId,
      textCellId: plan.textCellId,
      similarity: plan.basis === "cross-script" ? 0 : plan.confidence,
      gapSec: Math.abs((cue?.startTime ?? 0) - (text?.startTime ?? 0)),
    }
    ;(plan.basis === "cross-script" ? crossScriptCandidates : weakCandidates).push(row)
  }
  const proposedCues = new Set([...crossScriptCandidates, ...weakCandidates].map((r) => r.cueCellId))
  const proposedText = new Set([...crossScriptCandidates, ...weakCandidates].map((r) => r.textCellId))

  const confident: ReviewCandidate[] = []
  const uncertain: ReviewCandidate[] = []
  const unpairedCues: string[] = []
  const claimed = new Set<string>(proposedText)

  for (let i = 0; i < audioCues.length; i++) {
    const cue = audioCues[i]
    if (cueToText.has(cue.id)) continue
    // Already the subject of a matcher proposal above — asking twice about the
    // same cue in two different groups would be noise.
    if (proposedCues.has(cue.id)) continue

    // The nearest PAIRED cues either side. Without both, this cue sits outside
    // the alignment's span — the head or tail of the file — and there is no
    // window to look in. That is what keeps the opening screen cards out of
    // the list rather than needing a rule of their own.
    let before: number | null = null
    let after: number | null = null
    for (let j = i - 1; j >= 0; j--) if (cueToText.has(audioCues[j].id)) { before = j; break }
    for (let j = i + 1; j < audioCues.length; j++) if (cueToText.has(audioCues[j].id)) { after = j; break }
    if (before === null || after === null) {
      unpairedCues.push(cue.id)
      continue
    }

    // The subtitle window those neighbours imply. Everything strictly inside it
    // is unaccounted for by the alignment.
    const lo = Math.max(
      ...(cueToText.get(audioCues[before].id) ?? []).map((t) => textIndex.get(t) ?? -1),
    )
    const hi = Math.min(
      ...(cueToText.get(audioCues[after].id) ?? []).map((t) => textIndex.get(t) ?? Infinity),
    )
    const candidates = unpairedTextIdx.filter(
      (t) => t > lo && t < hi && !claimed.has(textCells[t].id) && !declined.has(key(textCells[t].id, cue.id)),
    )

    // Exactly one is the whole point. Several means the alignment has a wide
    // hole and guessing inside it would be noise; none means the line is
    // genuinely unsubtitled, which is a fact rather than a problem.
    if (candidates.length !== 1) {
      unpairedCues.push(cue.id)
      continue
    }
    const text = textCells[candidates[0]]
    claimed.add(text.id)
    const row: ReviewCandidate = {
      cueCellId: cue.id,
      textCellId: text.id,
      similarity: cueSimilarity(cue.original ?? "", text.original ?? ""),
      gapSec: Math.abs((cue.startTime ?? 0) - (text.startTime ?? 0)),
    }
    ;(row.similarity >= CONFIDENT_SIM ? confident : uncertain).push(row)
  }

  const unpairedText = unpairedTextIdx
    .map((i) => textCells[i].id)
    .filter((id) => !claimed.has(id))

  // Existing pairings worth a second look. Cross-script ones are separated
  // because nothing compared their words at all — they were made on timing
  // alone — so a low score there means something different from a low score
  // between two lines in the same alphabet.
  const textById = new Map(textCells.map((c) => [c.id, c]))
  const cueById = new Map(audioCues.map((c) => [c.id, c]))
  const lowConfidence: ReviewPair[] = []
  const crossScript: ReviewPair[] = []
  for (const l of links) {
    const t = textById.get(l.fromCellId)
    const c = cueById.get(l.toCellId)
    if (!t || !c) continue
    const pair: ReviewPair = {
      cueCellId: l.toCellId,
      textCellId: l.fromCellId,
      confidence: l.confidence,
    }
    const ts = dominantScript(t.original ?? "")
    const cs = dominantScript(c.original ?? "")
    if (ts && cs && ts !== cs) crossScript.push(pair)
    else if (l.confidence != null && l.confidence < LOW_CONFIDENCE) lowConfidence.push(pair)
  }

  // Sorted so the most certain answer is the first thing you act on, and the
  // least certain judgement call is the last.
  confident.sort((a, b) => b.similarity - a.similarity || a.gapSec - b.gapSec)
  uncertain.sort((a, b) => a.gapSec - b.gapSec)
  crossScriptCandidates.sort((a, b) => a.gapSec - b.gapSec)
  weakCandidates.sort((a, b) => b.similarity - a.similarity)
  lowConfidence.sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0))

  return {
    confident,
    crossScriptCandidates,
    weakCandidates,
    uncertain,
    unpairedCues,
    unpairedText,
    lowConfidence,
    crossScript,
    actionable:
      confident.length +
      crossScriptCandidates.length +
      weakCandidates.length +
      uncertain.length +
      lowConfidence.length +
      crossScript.length,
  }
}
