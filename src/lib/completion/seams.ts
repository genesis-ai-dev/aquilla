// Seam classification and drafting units (AQU-1386).
//
// A SEAM is the boundary between two adjacent cells in one file. A DRAFTING
// UNIT is a run of cells whose seams are all "joined" — a whole thought that
// must be drafted in ONE model call. Cell-by-cell drafting is what Biblica's
// translators called "a nightmare": EBL exercise 5 splits "…he said" across two
// cells, so each half is drafted blind to the other and neither reads naturally.
//
// Nothing here merges cells. The cell structure export depends on is untouched;
// only the *grouping of cells into calls* changes.
//
// Constraints for anything added here — SAME contract as ./prompt-build.ts,
// because auth-worker's seam route imports this module so the combine rule that
// decides a seam server-side is byte-identical to the one the SPA re-derives
// from cached answers:
//   - NO `@/` path aliases, transitively (worker tsconfigs have no path mapping).
//   - NO DOM, no `import.meta.env`, no storage access, no i18n.
//   - Pure functions only.
//
// The decision model is Jev (TypeSafe), a decision-only model returning
// calibrated probabilities rather than text. Its published guidance — and the
// reason this file looks the way it does — is that ONE broad question scores far
// worse than several narrow ones combined in code (62.6% → 95% in TypeSafe's own
// study). So we ask four atomic booleans plus one level score, and do the
// combining HERE, in testable code, where the rule can be argued about.

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

/** The four atomic booleans. Each is asked about ONE property of the seam. */
export type SeamQuestionKey =
  | "continues_sentence"
  | "same_item"
  | "refers_back"
  | "section_break"

export interface SeamQuestion {
  key: SeamQuestionKey
  /** Verbatim question text sent to the decision model. */
  question: string
}

/**
 * Asked per seam. `continues_sentence` / `same_item` / `refers_back` are the
 * three ways two cells can belong together (the OR); `section_break` is the
 * veto (the AND NOT). They are deliberately narrow and non-overlapping —
 * "do these belong together?" as a single question is exactly the broad
 * formulation that underperforms.
 */
export const SEAM_QUESTIONS: readonly SeamQuestion[] = [
  {
    key: "continues_sentence",
    question:
      "Does CELL B finish a sentence that CELL A leaves grammatically incomplete?",
  },
  {
    key: "same_item",
    question:
      "Are CELL A and CELL B parts of the same exercise, list item, or dialogue turn?",
  },
  {
    key: "refers_back",
    question:
      "Does CELL B depend on CELL A for its meaning (a pronoun, connective, or ellipsis that only resolves against CELL A)?",
  },
  {
    key: "section_break",
    question:
      "Does CELL B begin a new heading, section, or exercise?",
  },
]

/**
 * A single `score` question emitted alongside the booleans. This ticket reads
 * only `join`, but the level is cached with the seam so the follow-up passage/
 * milestone work (AQU-1387) and the media-chapter spike (AQU-1388) can threshold
 * the SAME cached answers at 3 and at 4 instead of re-classifying. That is why
 * the seam scorer is a shared module rather than a drafting-private helper.
 */
export const BOUNDARY_LEVEL_QUESTION = {
  key: "boundary_level" as const,
  question:
    "How strong is the boundary between CELL A and CELL B? " +
    "0 = the same sentence continues; " +
    "1 = a new sentence in the same thought; " +
    "2 = a new thought in the same paragraph or exercise; " +
    "3 = a new paragraph, pericope, or exercise; " +
    "4 = a new section or chapter-level topic.",
  levels: [0, 1, 2, 3, 4] as const,
}

export type BoundaryLevel = 0 | 1 | 2 | 3 | 4

// ---------------------------------------------------------------------------
// Answers + thresholds
// ---------------------------------------------------------------------------

/**
 * One seam's answers as returned by the decision model. Every field is
 * optional: a partial answer set is normal (the model may decline a question)
 * and must degrade to the heuristic rather than throw.
 */
export interface SeamAnswers {
  /** Probability in [0,1] that the named property holds. */
  continues_sentence?: number
  same_item?: number
  refers_back?: number
  section_break?: number
  /** Most likely level, plus its full distribution when the model returns one. */
  boundary_level?: { level: number; distribution?: number[] }
}

export interface SeamThresholds {
  /** Combined join probability at or above which the seam joins. */
  join: number
  /**
   * Minimum decision confidence (0 = coin flip, 1 = certain) below which the
   * model's answer is discarded in favour of the deterministic heuristic.
   * Gating on confidence is the whole point of using a calibrated model: an
   * uncertain classifier that still votes is worse than punctuation.
   */
  confidence: number
}

/**
 * Starting thresholds. These are PROVISIONAL — `scripts/seam-eval.ts` is the
 * instrument that replaces them with numbers justified by labelled data, and
 * the flag stays off until it has run. 0.5 is the neutral join point; 0.4
 * confidence means "the model must be at least moderately off the fence", which
 * on a calibrated model routes roughly the murkiest fifth of seams to the
 * heuristic.
 */
export const DEFAULT_SEAM_THRESHOLDS: SeamThresholds = {
  join: 0.5,
  confidence: 0.4,
}

/** How the seam was ultimately decided — surfaced so the eval can separate
 *  model accuracy from heuristic accuracy instead of scoring the blend. */
export type SeamDecidedBy = "model" | "heuristic"

export interface SeamDecision {
  /** True when the two cells belong in the same drafting unit. */
  join: boolean
  /**
   * Combined probability behind `join`. Heuristic decisions report 1 or 0 —
   * the heuristic is deterministic, not probabilistic, and pretending otherwise
   * would let it win a "weakest seam" tie-break against a real 0.51.
   */
  joinProbability: number
  /** Confidence in the decision (0 = coin flip, 1 = certain). */
  confidence: number
  decidedBy: SeamDecidedBy
  /** Cached for AQU-1387 / AQU-1388; unused by drafting. */
  boundaryLevel: BoundaryLevel | null
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * A seam's cache key is the pair of `sourceEventId`s on either side of it.
 *
 * This is what makes "editing a source cell invalidates only its two seams"
 * fall out for free rather than needing invalidation logic: a source commit
 * mints a new event id, so the two keys that mention the edited cell stop
 * matching and every other key in the file still hits. Content-addressed, so a
 * re-import that produces identical events re-uses the answers.
 *
 * Returns null when either side has no source event yet (a cell created locally
 * and not yet acked). An unkeyable seam is simply not cacheable — callers fall
 * back to the heuristic rather than inventing a key that could collide.
 */
export function seamKey(
  prevSourceEventId: string | null | undefined,
  nextSourceEventId: string | null | undefined,
): string | null {
  if (!prevSourceEventId || !nextSourceEventId) return null
  return `${prevSourceEventId}~${nextSourceEventId}`
}

// ---------------------------------------------------------------------------
// The deterministic fallback
// ---------------------------------------------------------------------------

/**
 * Sentence-final punctuation, allowing for closing quotes/brackets after it
 * ("…he said." / «…» / 。」) and for the CJK and Arabic full stops. Ellipsis and
 * a trailing dash are deliberately NOT sentence-final: "…" and "—" at the end of
 * a cell are the classic mid-thought split this whole feature exists to catch.
 */
const SENTENCE_FINAL = /[.!?;:։۔؟।॥。！？…]$/u
const TRAILING_CLOSERS = /[\s"'”’»›）)\]}」』]+$/u
const TRAILING_ELLIPSIS = /(\.\.\.|…)$/u
const TRAILING_DASH = /[-–—]$/u

/**
 * The fallback used whenever the model is unavailable, silent, or not confident
 * enough: cell A ending without sentence-final punctuation means the sentence
 * runs on, so join.
 *
 * It is intentionally crude. Its job is to be *never worse than today* — today
 * the seam is decided by an index modulo 10, which knows nothing at all — and to
 * be the baseline the shadow eval scores the model against.
 */
export function heuristicJoin(prevSource: string): boolean {
  const trimmed = prevSource.trim()
  if (!trimmed) return false // nothing to continue from
  const withoutClosers = trimmed.replace(TRAILING_CLOSERS, "")
  if (!withoutClosers) return false
  // An ellipsis or a dangling dash is a continuation marker, not a full stop.
  if (TRAILING_ELLIPSIS.test(withoutClosers) || TRAILING_DASH.test(withoutClosers)) return true
  return !SENTENCE_FINAL.test(withoutClosers)
}

// ---------------------------------------------------------------------------
// The combine rule
// ---------------------------------------------------------------------------

/** Distance from a coin flip, normalized to [0,1]. */
function certainty(p: number): number {
  return Math.min(1, Math.max(0, Math.abs(p - 0.5) * 2))
}

function isProbability(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1
}

function normalizeBoundaryLevel(answers: SeamAnswers): BoundaryLevel | null {
  const raw = answers.boundary_level?.level
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null
  const rounded = Math.round(raw)
  if (rounded < 0 || rounded > 4) return null
  return rounded as BoundaryLevel
}

/**
 * Combine one seam's answers into a decision.
 *
 * The rule, from the ticket:
 *     join = (continues_sentence OR same_item OR refers_back) AND NOT section_break
 *
 * On probabilities, the OR is `max` (any one of the three suffices) and the
 * AND-NOT scales by the complement of the veto, so a confident section break
 * drives the join probability to ~0 no matter how strongly the three agree.
 * This matters: a new exercise that happens to open with a pronoun should NOT
 * be glued to the previous exercise's last line.
 *
 * Confidence is computed the way a person would reason about the same boolean
 * expression, not as an average:
 *   - The OR is confident when it is confidently TRUE (one arm is high) or
 *     confidently FALSE (the highest arm is still low) — in both cases that is
 *     the distance of `max` from 0.5.
 *   - A TRUE conjunction needs BOTH terms confident, so it takes the min.
 *   - A FALSE conjunction only needs whichever term forced the FALSE, so it
 *     takes the max over the terms that did.
 * Averaging instead would let a certain veto be diluted by an undecided OR.
 *
 * When too few answers arrive, or confidence lands under the gate, the
 * heuristic decides and `decidedBy` says so.
 */
export function combineSeam(
  answers: SeamAnswers | null | undefined,
  prevSource: string,
  thresholds: SeamThresholds = DEFAULT_SEAM_THRESHOLDS,
): SeamDecision {
  const boundaryLevel = answers ? normalizeBoundaryLevel(answers) : null

  const fallback = (): SeamDecision => {
    const join = heuristicJoin(prevSource)
    return {
      join,
      joinProbability: join ? 1 : 0,
      confidence: 1,
      decidedBy: "heuristic",
      boundaryLevel,
    }
  }

  if (!answers) return fallback()

  const orArms = [answers.continues_sentence, answers.same_item, answers.refers_back]
    .filter(isProbability)
  const veto = answers.section_break

  // Both sides of the expression must be answered. A missing veto is not "no
  // veto": an unanswered section_break is an unknown, and gluing an exercise
  // boundary shut is precisely the failure that makes grouping feel like a bug.
  if (orArms.length === 0 || !isProbability(veto)) return fallback()

  const orValue = Math.max(...orArms)
  const joinProbability = orValue * (1 - veto)

  const orConfidence = certainty(orValue)
  const vetoConfidence = certainty(veto)
  const orTrue = orValue >= 0.5
  const vetoTrue = veto >= 0.5

  let confidence: number
  if (orTrue && !vetoTrue) {
    confidence = Math.min(orConfidence, vetoConfidence)
  } else {
    const forcing: number[] = []
    if (!orTrue) forcing.push(orConfidence)
    if (vetoTrue) forcing.push(vetoConfidence)
    confidence = Math.max(...forcing)
  }

  if (confidence < thresholds.confidence) return fallback()

  return {
    join: joinProbability >= thresholds.join,
    joinProbability,
    confidence,
    decidedBy: "model",
    boundaryLevel,
  }
}

// ---------------------------------------------------------------------------
// Drafting units
// ---------------------------------------------------------------------------

/** The minimum a cell must expose to be grouped. Structural, so both `CellRow`
 *  and the worker's SQL rows satisfy it without importing either type graph. */
export interface SeamCell {
  id: string
  fileId: string
  sourceEventId?: string | null
}

/** One derived unit: the cell ids, plus the join probability of each internal
 *  seam (length = ids.length - 1) so an oversize unit can be split at its
 *  weakest point rather than at an arbitrary index. */
export interface DraftingUnit {
  ids: string[]
  /** `seamStrength[i]` is the seam between `ids[i]` and `ids[i + 1]`. */
  seamStrength: number[]
}

/** Resolves the decision for the seam between two adjacent cells. */
export type SeamResolver = (prev: SeamCell, next: SeamCell) => SeamDecision

/**
 * Group an ordered cell list into drafting units.
 *
 * A file boundary always starts a new unit — a unit never spans files, for the
 * same reason `gatherPrecedingContext` refuses to cross one.
 *
 * `cells` must be in document order (the order useCells/useProject returns).
 */
export function deriveDraftingUnits(
  cells: readonly SeamCell[],
  resolve: SeamResolver,
): DraftingUnit[] {
  if (cells.length === 0) return []

  const units: DraftingUnit[] = []
  let current: DraftingUnit = { ids: [cells[0].id], seamStrength: [] }

  for (let i = 1; i < cells.length; i++) {
    const prev = cells[i - 1]
    const cell = cells[i]
    const sameFile = prev.fileId === cell.fileId
    const decision = sameFile ? resolve(prev, cell) : null

    if (decision?.join) {
      current.ids.push(cell.id)
      current.seamStrength.push(decision.joinProbability)
    } else {
      units.push(current)
      current = { ids: [cell.id], seamStrength: [] }
    }
  }

  units.push(current)
  return units
}

/** The unit containing `cellId`, or null when it is not in `units`. Used by the
 *  single-cell sparkle path: clicking one cell drafts its whole unit, so a
 *  request can never return text that ends mid-sentence. */
export function draftingUnitForCell(
  units: readonly DraftingUnit[],
  cellId: string,
): DraftingUnit | null {
  for (const unit of units) {
    if (unit.ids.includes(cellId)) return unit
  }
  return null
}

/**
 * Split an oversize unit at its weakest seams until every piece fits `budget`.
 *
 * Recursive weakest-seam bisection rather than a fixed stride: a 14-cell unit
 * with a clear dip at index 9 should break THERE, not at 10. Ties break toward
 * the middle so the pieces stay balanced.
 */
function splitUnit(unit: DraftingUnit, budget: number): DraftingUnit[] {
  if (unit.ids.length <= budget) return [unit]

  const mid = (unit.seamStrength.length - 1) / 2
  let weakest = 0
  for (let i = 1; i < unit.seamStrength.length; i++) {
    const s = unit.seamStrength[i]
    const best = unit.seamStrength[weakest]
    if (s < best || (s === best && Math.abs(i - mid) < Math.abs(weakest - mid))) {
      weakest = i
    }
  }

  const left: DraftingUnit = {
    ids: unit.ids.slice(0, weakest + 1),
    seamStrength: unit.seamStrength.slice(0, weakest),
  }
  const right: DraftingUnit = {
    ids: unit.ids.slice(weakest + 1),
    seamStrength: unit.seamStrength.slice(weakest + 1),
  }
  return [...splitUnit(left, budget), ...splitUnit(right, budget)]
}

/**
 * Pack whole units into calls of at most `budget` cells.
 *
 * The contract that matters, and the one the tests pin: a unit is NEVER split
 * across two calls unless it alone exceeds the budget. That is the difference
 * from today's fixed `slice(i, i + 10)`, which splits a sentence whenever it
 * happens to straddle a multiple of ten.
 *
 * Greedy left-to-right, because the cells are in document order and every call
 * carries the previous call's context forward — reordering to pack tighter
 * would trade discourse flow for a marginally fuller prompt.
 */
export function packUnitsIntoCalls(
  units: readonly DraftingUnit[],
  budget: number,
): string[][] {
  if (budget <= 0) return []

  const calls: string[][] = []
  let current: string[] = []

  for (const unit of units) {
    for (const piece of splitUnit(unit, budget)) {
      if (current.length > 0 && current.length + piece.ids.length > budget) {
        calls.push(current)
        current = []
      }
      current.push(...piece.ids)
    }
  }

  if (current.length > 0) calls.push(current)
  return calls
}
