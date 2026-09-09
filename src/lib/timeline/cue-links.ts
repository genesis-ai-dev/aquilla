// The deterministic auto-linker: which subtitle line does each heard line
// perform? (AQU-646 stage 4)
//
// An episode ships two cue lists. The SUBTITLE VTT is what gets translated;
// the AUDIO VTT is a near-verbatim transcript of what is actually heard, and
// it is what the picture demands when recording. They deliberately disagree —
// subtitles are condensed for reading, dub lines are cut for the mouth — so on
// episode 101, 93 subtitle cells are performed as two or more heard lines and
// 91 heard lines span two or more subtitle rows. The relationship is
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
// Measured on corrected episode 101: 730 overlapping candidates, 655 scoring
// well enough to pair, 648 auto-linked. The rejections at the scoring stage are
// genuinely different lines that merely overlap in time — two speakers at once,
// e.g. "No! No!" against "What is that?". The five dropped after it are a
// different animal and are the subject of `claimWords`.

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
 *  - `redundant`: the pairing scored well enough, and then explained nothing
 *    the cue did not already have explained. See `claimWords`.
 *
 * Only `words` is auto-linked. The middle two are surfaced in the review drawer
 * as proposals, because a pairing nothing verified should be a person's
 * decision rather than something they have to notice was made for them.
 * `redundant` is neither linked nor proposed — it is kept in the returned plan
 * so a report can say what was dropped and why, since "nothing appeared" is a
 * hard thing to check.
 */
export type CueLinkBasis = "words" | "cross-script" | "weak-words" | "redundant"

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
 *
 * WHICH APOSTROPHE, THOUGH (2026-08-17). Keeping only the straight one was a
 * silent defect: the audio VTT types contractions with a curly U+2019 and the
 * subtitle file with a straight quote, so the curly one fell through to the
 * punctuation strip and "that's" became `that|s` on one side against `that's`
 * on the other. Identical lines scored as low as 0.5 — measured on episode
 * 101, "That's right." against "That's right." and "You taught God's law."
 * against itself. 37 of the 548 cues carry a curly apostrophe and every
 * contraction in them was being counted as a miss. They fold together here,
 * before anything else can throw one of them away.
 *
 * EXPORTED because `lib/import/timebase.ts` keys its drift anchors with it. Two
 * tokenisers would mean the curly-apostrophe fold applied on one side of the
 * import and not the other, which is the same class of silent miscount this
 * comment already documents.
 */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    // U+2019 right single quote and U+02BC modifier letter apostrophe: the two
    // characters that mean "apostrophe" without being one.
    .replace(/[’ʼ]/g, "'")
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
  const shared = sharedInstances(counted(ta), counted(tb))
  const containment = shared / Math.min(ta.length, tb.length)
  return Math.max(dice(shared, ta.length, tb.length), containment)
}

/** How many word INSTANCES two bags have in common. */
function sharedInstances(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let shared = 0
  for (const [t, n] of a) shared += Math.min(n, b.get(t) ?? 0)
  return shared
}

/** Dice on its own — deliberately available without the containment rescue,
 *  because the claiming rule below needs a measure that a one-word remainder
 *  CANNOT score 1.00 on. See `claimWords`. */
function dice(shared: number, lenA: number, lenB: number): number {
  return lenA + lenB === 0 ? 0 : (2 * shared) / (lenA + lenB)
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
/** Non-overlapping codepoint ranges checked in `dominantScript`. Latin has no
 * single contiguous range, so it stays a regex test outside this table. */
const SCRIPT_CODEPOINT_RANGES: ReadonlyArray<{ name: string; min: number; max: number }> = [
  { name: "hebrew", min: 0x0590, max: 0x05ff },
  { name: "arabic", min: 0x0600, max: 0x06ff },
  { name: "greek", min: 0x0370, max: 0x03ff },
  { name: "cyrillic", min: 0x0400, max: 0x04ff },
  { name: "han", min: 0x4e00, max: 0x9fff },
]

export function dominantScript(text: string): string | null {
  const counts = new Map<string, number>()
  const bump = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1)
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    const range = SCRIPT_CODEPOINT_RANGES.find((r) => c >= r.min && c <= r.max)
    if (range) bump(range.name)
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

/** A candidate plus what the claiming pass needs to order it. Kept off
 *  `CueLinkPlan` deliberately: callers persist that shape. */
interface Candidate {
  plan: CueLinkPlan
  /** How many of the cue's word instances this row accounts for. */
  explains: number
  /** Overlap as a share of the SHORTER of the two spans. THE PRIMARY ORDER —
   *  see `claimWords`. */
  overlapFrac: number
  overlapSec: number
  cueStart: number
  textStart: number
}

/**
 * How rare a word has to be, across the episode's own lines, to count as
 * evidence that a second row is really part of a heard line.
 *
 * Measured rather than guessed: on episode 101 this leaves "i", "you", "the",
 * "and", "oh" out — the words an echo hands back — while keeping every word
 * that names something. 2% of a 650-line file is thirteen lines.
 */
const DISTINCTIVE_MAX_DOC_FREQ = 0.02

/**
 * How much of a row this cue must take for the row to count as genuinely part
 * of it despite carrying no distinctive word.
 *
 * HALF, measured rather than chosen. Real steps hand over every word they have
 * (1.00) and a row split across two cues gives about half; an echo gives a
 * third or less — John's "I told you, I won't forget." offers two words of six.
 * Swept across all four episodes, half is the point where both of episode 306's
 * echoes are caught and NOT ONE subtitle row loses a pairing it would have kept
 * without this rule at all. At 0.6 three rows start paying for it; at 0.8, five.
 */
const WHOLLY_CONSUMED = 0.5

/** A word is distinctive when it appears in few enough of the episode's lines.
 *  Built from BOTH files: they are the same script, and one corpus means a
 *  word cannot be common on one side and rare on the other. */
function distinctiveWords(lines: readonly string[]): (token: string) => boolean {
  const docFreq = new Map<string, number>()
  for (const line of lines) {
    for (const t of new Set(tokens(line))) docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
  }
  const ceiling = Math.max(1, lines.length * DISTINCTIVE_MAX_DOC_FREQ)
  // A corpus too small to have a shape at all cannot condemn anything, so
  // every word counts — the synthetic two-line cases in the tests, and any
  // file short enough that "rare" is meaningless.
  if (lines.length < 20) return () => true
  return (token: string) => (docFreq.get(token) ?? 0) <= ceiling
}

const deduct = (ledger: Map<string, number>, token: string, n: number): void => {
  const left = (ledger.get(token) ?? 0) - n
  if (left > 0) ledger.set(token, left)
  else ledger.delete(token)
}

/**
 * AN EXTRA LINK HAS TO EXPLAIN WORDS THAT ARE NOT ALREADY EXPLAINED.
 * (Sam, 2026-08-17)
 *
 * Scoring each pair on its own merits — which is all this did until now — has
 * no way to notice that a cue is already fully accounted for. Subtitle rows
 * tile the timeline back to back, so any cue whose window runs a fraction past
 * its own row touches the next one, and in a two-hander that next row is the
 * other actor. Five cues in episode 101 ended up with two speakers that way,
 * on 72–334ms of overlap, and the character spreadsheet is what exposed them.
 *
 * Four of the five could in principle have been caught by a confidence floor:
 * the real edge scored 1.0 and the junk 0.5–0.67. The fifth cannot be caught
 * by any score at all — two students each say "Rabbi." and BOTH rows match the
 * heard "Rabbi." perfectly. The only thing that separates them is that after
 * the first row is accepted there is nothing left of the line for the second
 * to explain.
 *
 * So links are awarded one at a time, best first, and each award CLAIMS the
 * word instances it explains on both cells. A candidate whose words are all
 * spoken for is not a pairing; it is arithmetic about two windows touching.
 *
 * BEST FIRST, NOT FIRST IN THE FILE. Document order gets four of the five and
 * fails on 45:58, where the junk row ("...but it didn't") STARTS EARLIER than
 * the real one ("Of course, it didn't.") and would claim the shared tail
 * before the real partner was ever considered. Ordering by score, then by
 * overlap, puts the better explanation first in every known case — and overlap
 * is what settles the two students, since their scores are identical.
 *
 * ONLY THE CUE IS SPENT. This is the part that has to be asymmetric, and the
 * real files caught it: two audio cues at 39:54 both transcribe "Yes, Rabbi."
 * — overlapping utterances, a crowd answering together — against ONE condensed
 * subtitle row. Claiming on the row's side too used that row up on the first
 * cue and left the second with no line to read at all. A cue is one person
 * speaking once, so once its words are explained there is nothing further to
 * explain; a subtitle row is a unit of READING and is meant to be shared, and
 * this file has 93 rows performed as two or more heard lines. So a row is
 * never depleted and can answer for as many cues as genuinely need it.
 *
 * WHAT IT MUST NOT BREAK. A subtitle row that straddles two heard lines is
 * real and common: three in episode 101, e.g. the cue "Simon, I came with
 * about 60 percent of what I owe." where one row supplies the head and the
 * next supplies "of what I owe". Each of those genuinely contributes unclaimed
 * words, so each survives. Instances are counted rather than types, so a cue
 * transcribed "Rabbi. Rabbi." can still honour both students' rows — its
 * ledger holds `rabbi × 2`.
 *
 * Greedy, with the usual caveat: an early award can in principle block a
 * better global assignment. With scores this coarse that stayed theoretical
 * across all 655 edges of episode 101, and the alternative — a full assignment
 * search — needs tuning this data does not justify.
 *
 * Mutates `basis` in place; returns nothing.
 *
 * The two sides are looked up in SEPARATE maps rather than one keyed by cell
 * id. Cell ids are unique across files in the app, but leaning on that here
 * was briefly a real bug: the test fixtures number cues from zero in BOTH
 * files, so a single map had the audio side overwrite the subtitle side and
 * every cue was scored against the wrong words. Two maps cannot collide, and
 * no caller has to promise anything.
 */
function claimWords(
  candidates: readonly Candidate[],
  textWords: ReadonlyMap<string, string>,
  cueWords: ReadonlyMap<string, string>,
  distinctive: (token: string) => boolean,
): void {
  const ordered = candidates
    // Different writing systems have no comparable words, so there is nothing
    // to claim and nothing to be redundant against — every one of them would
    // contribute the empty set and be thrown away. Their timing rule stands.
    .filter((c) => c.plan.basis !== "cross-script")
    // Total, and independent of input order, so the same two files always
    // produce the same links.
    .sort(
      (a, b) =>
        // MOST-EXPLAINED FIRST. The order is load-bearing rather than
        // cosmetic — whoever claims a word first keeps it — and all four
        // orderings worth trying were measured across all four episodes,
        // counting the junk links the character sheets independently expose:
        //
        //   words explained  1 junk link   <- this one
        //   overlap seconds  2
        //   overlap share    4
        //   similarity       2, and one more row left unpaired
        //
        // By SIMILARITY is the worst kind of wrong: it puts an echo ahead of
        // the line it echoes. At 43:36 Simon repeats Nadab's question back at
        // him, and Nadab's shorter row scores 0.86 against Simon's 0.70 purely
        // because containment divides by the shorter side, so the echo claims
        // the words and the real line is left redundant — the exact inversion
        // of what this pass is for. How MUCH of the cue a row accounts for has
        // no such bias.
        //
        // It is not perfect and the failure is known: when the interloper is
        // the LONGER row it can explain more of the cue than the real partner,
        // which is why 306's other echo survives (5:16, "I don't want you to
        // forget." answered by "I told you, I won't forget."). Every ordering
        // that fixes that one costs more elsewhere.
        b.explains - a.explains ||
        b.overlapFrac - a.overlapFrac ||
        b.plan.confidence - a.plan.confidence ||
        a.cueStart - b.cueStart ||
        a.textStart - b.textStart ||
        (a.plan.cueCellId < b.plan.cueCellId ? -1 : a.plan.cueCellId > b.plan.cueCellId ? 1 : 0) ||
        (a.plan.textCellId < b.plan.textCellId ? -1 : a.plan.textCellId > b.plan.textCellId ? 1 : 0),
    )

  /** Words of each cue still wanting an explanation. Deducted from; the only
   *  thing that is spent. */
  const cueLedgers = new Map<string, Map<string, number>>()
  const cueLedgerFor = (id: string): Map<string, number> => {
    const held = cueLedgers.get(id)
    if (held) return held
    const fresh = counted(tokens(cueWords.get(id) ?? ""))
    cueLedgers.set(id, fresh)
    return fresh
  }
  /** A row's words, cached but NEVER deducted — see the asymmetry above. */
  const rowTokens = new Map<string, Map<string, number>>()
  const rowTokensFor = (id: string): Map<string, number> => {
    const held = rowTokens.get(id)
    if (held) return held
    const fresh = counted(tokens(textWords.get(id) ?? ""))
    rowTokens.set(id, fresh)
    return fresh
  }
  /** Cues already holding a link — only they can be over-served. */
  const placedCues = new Set<string>()

  for (const { plan } of ordered) {
    const cueLedger = cueLedgerFor(plan.cueCellId)
    const row = rowTokensFor(plan.textCellId)

    // What this pairing explains that nothing better has explained already.
    const contribution = new Map<string, number>()
    for (const [token, n] of row) {
      const shared = Math.min(n, cueLedger.get(token) ?? 0)
      if (shared > 0) contribution.set(token, shared)
    }

    // Nothing left to say: the cue was already fully spoken for.
    let redundant = contribution.size === 0
    if (!redundant && placedCues.has(plan.cueCellId)) {
      // AN EXTRA ROW MUST BRING BACK A WORD THAT MEANS SOMETHING (2026-08-17).
      //
      // Supplying *a* missing word is too weak a test. Episode 306 has two
      // cases where a character REPEATS another's line — "I don't want you to
      // forget." answered by "I told you, I won't forget.", and Simon echoing
      // Nadab's question back at him — and the junk row survived by handing
      // over the pronouns the real row happened not to use. The words a
      // condensed subtitle drops are exactly the words any neighbouring line
      // also contains, so a scrap of them proves nothing.
      //
      // MEASURES OF SIZE DO NOT WORK HERE, and both were tried. Dice against
      // the remainder collapses on a long staircase — the seven-row scripture
      // at 51:27 has each row supplying a fifth of what is still outstanding,
      // and every row after the first scores under 0.36. The row's own
      // matched fraction collapses the other way, on a subtitle row split
      // across two cues (43:35's "of what I owe. I can't even pay..." gives
      // half its words here and half to the next cue). One rules out the
      // other; neither leaves room for both.
      //
      // What separates them is not how MUCH comes back but WHAT, and a row
      // earns its place by either of two things.
      //
      // It brings back a DISTINCTIVE word — one that is rare across this
      // episode's own lines. That is the data-driven form of the hand-written
      // filler list this replaces, and it needs no guesses about which words
      // are "small". It carries the long rows: 43:35's "of what I owe. I
      // can't even pay..." gives half its words to this cue and half to the
      // next, and "owe" is what says the half belongs here.
      //
      // Or the cue takes essentially ALL of it. Nine real steps in episode 101
      // are nothing but common words — "Out!", "Who are you?", "So...", and
      // the "You..." of the seven-row scripture at 51:27 — and no test on
      // vocabulary alone can keep them. What makes them genuine is that they
      // hold nothing back: every word the row has, this cue wanted. An echo is
      // the opposite, keeping most of itself for the line it really belongs
      // to — John's "I told you, I won't forget." hands over two words of six.
      const rowLen = [...row.values()].reduce((a, b) => a + b, 0)
      const supplied = [...contribution.values()].reduce((a, b) => a + b, 0)
      redundant =
        ![...contribution.keys()].some((t) => distinctive(t)) &&
        supplied < rowLen * WHOLLY_CONSUMED
    }

    if (redundant) {
      plan.basis = "redundant"
      continue
    }

    for (const [token, n] of contribution) deduct(cueLedger, token, n)
    placedCues.add(plan.cueCellId)
  }
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
  const candidates: Candidate[] = []
  const push = (
    plan: CueLinkPlan,
    explains: number,
    overlapFrac: number,
    overlapSec: number,
    cueStart: number,
    textStart: number,
  ): void => {
    candidates.push({ plan, explains, overlapFrac, overlapSec, cueStart, textStart })
  }

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
          const plan: CueLinkPlan = {
            textCellId: text.id,
            cueCellId: cue.id,
            confidence: frac,
            basis: "cross-script",
          }
          push(plan, 0, frac, overlap, cue.startTime, text.startTime)
        }
        continue
      }

      const sim = cueSimilarity(cueText, subtitleText)
      const explains = sharedInstances(counted(tokens(cueText)), counted(tokens(subtitleText)))
      if (sim >= STRONG_SIM) {
        const plan: CueLinkPlan = {
          textCellId: text.id,
          cueCellId: cue.id,
          confidence: sim,
          basis: "words",
        }
        push(plan, explains, frac, overlap, cue.startTime, text.startTime)
      } else if (sim >= WEAK_SIM && frac >= WEAK_SIM_MIN_FRAC) {
        const plan: CueLinkPlan = {
          textCellId: text.id,
          cueCellId: cue.id,
          confidence: sim,
          basis: "weak-words",
        }
        push(plan, explains, frac, overlap, cue.startTime, text.startTime)
      }
    }
  }

  // Everything above judged each pair on its own. This is where they are
  // judged against each other.
  claimWords(
    candidates,
    new Map(texts.map((c) => [c.id, c.original ?? ""])),
    new Map(cues.map((c) => [c.id, c.original ?? ""])),
    distinctiveWords([...texts, ...cues].map((c) => c.original ?? "")),
  )

  // Returned in the order they were found — cue by cue, subtitle by subtitle —
  // which is the order callers have always emitted them in.
  return candidates.map((c) => c.plan)
}
