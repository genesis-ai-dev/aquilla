// The deterministic auto-linker: which subtitle line does each heard line
// perform? (AQU-646 stage 4)
//
// An episode ships two cue lists. The SUBTITLE VTT is what gets translated;
// the AUDIO VTT is a near-verbatim transcript of what is actually heard, and
// it is what the picture demands when recording. They deliberately disagree —
// subtitles are condensed for reading, dub lines are cut for the mouth — so on
// episode 101, 93 subtitle cells are performed as two or more heard lines and
// 154 heard lines span two or more subtitle rows. The relationship is
// many-to-many and the output is a set of pairwise edges.
//
// THIS RUNS ONCE, AT IMPORT, AND WRITES ORDINARY LINK EVENTS. It is never
// recomputed live. That is the whole design: recomputing would silently undo
// every manual correction the next time anything re-imported, and a link you
// cannot correct is worse than no link at all.
//
// WHY TIME OVERLAP IS TRUSTWORTHY AGAIN. It wasn't, until 2026-08-14: the
// audio VTT was authored at 24fps against a 23.976 master, so its cues drifted
// up to ~3s late and the two lists genuinely didn't line up. With the timebase
// corrected at import (see lib/import/timebase.ts), word agreement where they
// overlap went from 65% to 97%. So a plain pairwise rule is enough here, and
// the sequence alignment this looked like it needed is not required.
//
// Measured on corrected episode 101: 730 overlapping candidates, 654 linked.
// The rejections are genuinely different lines that merely overlap in time —
// two speakers at once, e.g. "No! No!" against "What is that?".

/** The minimum a cell must carry to take part. `CellData` satisfies it. */
export interface LinkableCue {
  id: string
  /** Seconds. */
  startTime?: number
  endTime?: number
  /** The cue's own words — subtitle text on one side, transcript on the other. */
  original?: string
}

/**
 * What the pairing rests on — and therefore whether it may be written without
 * asking. (Sam, 2026-08-15)
 *
 *  - `words`: the two lines say the same thing. Safe to pair automatically.
 *  - `cross-script`: the timings line up, and the words CANNOT be compared
 *    because the two sides are in different writing systems. Strong evidence,
 *    but nothing has actually checked that they mean the same thing.
 *  - `weak-words`: they overlap in time and share a little wording, but not
 *    enough to be sure.
 *
 * Only `words` is auto-linked. The other two are surfaced in the review drawer
 * as proposals, because a pairing nothing verified should be a person's
 * decision rather than something they have to notice was made for them.
 */
export type CueLinkBasis = "words" | "cross-script" | "weak-words"

export interface CueLinkPlan {
  /** The subtitle cell. */
  textCellId: string
  /** The audio cue. */
  cueCellId: string
  /** `max(dice, containment)`, or the time-overlap fraction when the two sides
   *  are in different scripts and words cannot be compared at all. */
  confidence: number
  basis: CueLinkBasis
}

/** The pairings safe to write without asking. Every emit path filters through
 *  this; the review drawer reads the whole list. */
export function autoLinkable(plans: readonly CueLinkPlan[]): CueLinkPlan[] {
  return plans.filter((p) => p.basis === "words")
}

/** Below this the two cues merely touch; they do not overlap. */
const MIN_OVERLAP_SEC = 0.05

/** Words agree this well ⇒ link, however the timings fall. */
const STRONG_SIM = 0.5

/** Weaker agreement still links when the spans genuinely coincide. */
const WEAK_SIM = 0.2
const WEAK_SIM_MIN_FRAC = 0.5

/** With no comparable words at all (different scripts), the spans have to do
 *  all the work, so they must coincide properly. */
const CROSS_SCRIPT_MIN_FRAC = 0.5

/**
 * Tokenise for comparison.
 *
 * NOT `normalizeSource`/`sourceSimilarity` from lib/analysis/buckets.ts, which
 * looks like the right thing to reuse and is not: it lowercases and collapses
 * whitespace but keeps punctuation attached, so the single most characteristic
 * difference between these two files — "Two." against "Two, please." — scores
 * ZERO there. Cue text has to be stripped to bare words first. Apostrophes are
 * kept, since "don't" and "dont" are the same word and splitting on it would
 * turn one token into two.
 */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
}

function counted(list: readonly string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of list) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}

/**
 * How alike two cues' words are: the better of Dice and containment.
 *
 * Dice alone punishes a length mismatch, and a length mismatch is exactly what
 * a condensed subtitle IS. "Sometimes…" against the full spoken line
 * "Sometimes, I wonder if what we can know of Adonai…" scores 0.11 on Dice and
 * 1.00 on containment; measured on episode 101, taking the better of the two
 * recovers 13 real pairs that Dice alone throws away.
 */
export function cueSimilarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.length === 0 || tb.length === 0) return 0
  const ma = counted(ta)
  const mb = counted(tb)
  let shared = 0
  for (const [t, n] of ma) shared += Math.min(n, mb.get(t) ?? 0)
  const dice = (2 * shared) / (ta.length + tb.length)
  const containment = shared / Math.min(ta.length, tb.length)
  return Math.max(dice, containment)
}

/**
 * Which writing system a cue is in, or null when it has no letters to judge by
 * (a cue of pure digits or punctuation commits to nothing).
 *
 * Only used to notice a MISMATCH. Sam spotted this case through the quotation
 * marks those subtitles carry — foreign dialogue is subtitled even for English
 * viewers, and the subtitle is quoted — but the quotes are a correlate, not the
 * cause: on episode 101, two of the four quoted subtitles are English scripture
 * being read aloud, where the words match perfectly and no special case is
 * wanted. The real reason similarity fails is that Hebrew characters and Latin
 * ones can only ever score zero against each other, so the script is what to
 * detect.
 */
export function dominantScript(text: string): string | null {
  const counts = new Map<string, number>()
  const bump = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1)
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c >= 0x0590 && c <= 0x05ff) bump("hebrew")
    else if (c >= 0x0600 && c <= 0x06ff) bump("arabic")
    else if (c >= 0x0370 && c <= 0x03ff) bump("greek")
    else if (c >= 0x0400 && c <= 0x04ff) bump("cyrillic")
    else if (c >= 0x4e00 && c <= 0x9fff) bump("han")
    else if (/\p{Script=Latin}/u.test(ch)) bump("latin")
  }
  let best: string | null = null
  let bestN = 0
  for (const [name, n] of counts) {
    if (n > bestN) {
      best = name
      bestN = n
    }
  }
  return best
}

export interface PlanCueLinksArgs {
  /** The subtitle file's cells. */
  textCells: readonly LinkableCue[]
  /** The audio-cue sibling's cells — ALREADY timebase-corrected. */
  audioCues: readonly LinkableCue[]
}

/**
 * Pair the two cue lists. Pure and total; no I/O, no ids minted.
 *
 * Deliberately pairwise rather than a sequence alignment. A monotonic DP would
 * be the right tool if the lists disagreed about ORDER, and they don't — they
 * disagree about segmentation, which pairwise overlap handles directly, and
 * the DP's gap penalties would need tuning that the data does not justify.
 *
 * O(text x audio) in the worst case, but the inner loop breaks out as soon as
 * a subtitle starts after the cue ends, so on real files it is near-linear.
 */
export function planCueLinks({ textCells, audioCues }: PlanCueLinksArgs): CueLinkPlan[] {
  const timed = (cells: readonly LinkableCue[]) =>
    cells
      .filter(
        (c): c is LinkableCue & { startTime: number; endTime: number } =>
          typeof c.startTime === "number" &&
          typeof c.endTime === "number" &&
          Number.isFinite(c.startTime) &&
          Number.isFinite(c.endTime) &&
          c.endTime > c.startTime,
      )
      .sort((a, b) => a.startTime - b.startTime)

  const texts = timed(textCells)
  const cues = timed(audioCues)
  const plans: CueLinkPlan[] = []

  for (const cue of cues) {
    const cueText = cue.original ?? ""
    const cueScript = dominantScript(cueText)
    for (const text of texts) {
      // Sorted by start, so once a subtitle begins after this cue ends, so does
      // every subtitle after it.
      if (text.startTime >= cue.endTime) break
      const overlap = Math.min(cue.endTime, text.endTime) - Math.max(cue.startTime, text.startTime)
      if (overlap <= MIN_OVERLAP_SEC) continue

      const shorter = Math.min(cue.endTime - cue.startTime, text.endTime - text.startTime)
      const frac = shorter > 0 ? overlap / shorter : 0
      const subtitleText = text.original ?? ""
      const subtitleScript = dominantScript(subtitleText)

      // Different writing systems: the words cannot be compared, so the spans
      // decide alone. Only when BOTH sides commit to a script — a cue with no
      // letters at all must not trigger this.
      if (cueScript && subtitleScript && cueScript !== subtitleScript) {
        if (frac >= CROSS_SCRIPT_MIN_FRAC) {
          plans.push({
            textCellId: text.id,
            cueCellId: cue.id,
            confidence: frac,
            basis: "cross-script",
          })
        }
        continue
      }

      const sim = cueSimilarity(cueText, subtitleText)
      if (sim >= STRONG_SIM) {
        plans.push({ textCellId: text.id, cueCellId: cue.id, confidence: sim, basis: "words" })
      } else if (sim >= WEAK_SIM && frac >= WEAK_SIM_MIN_FRAC) {
        plans.push({ textCellId: text.id, cueCellId: cue.id, confidence: sim, basis: "weak-words" })
      }
    }
  }

  return plans
}
