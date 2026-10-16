// AQU-1486 — "Validate all repeated rows, or just this one?"
//
// AQU-1391 fills a validated row's repetitions and leaves them UNVALIDATED,
// so a reviewer who meant "this sentence is right everywhere" then had to sign
// off every repeat by hand. This module plans the other answer: which rows a
// "Validate all" would sign off, and — for the bulk gestures, which validate
// many rows at once — which text each repetition group receives.
//
// Pure planning only. The workspace hook (`useRepetitionValidation`) asks the
// reviewer, emits the events and owns the toast/Undo.

import { normalizeRepetitionSource } from "./autopropagation"
import {
  planRepetitionPropagation,
  repetitionCommitFor,
  type RepetitionCell,
  type RepetitionCommit,
  type PlanRepetitionPropagationInput,
} from "./repetition-propagation"
import { isVisibleCell } from "@/lib/cells/hidden"

/** The reviewer's answer: sign the repetitions off too, or only fill them. */
export type RepetitionChoice = "all" | "one"

/**
 * How the validation happened. A click may open a dialog; a typed edit settles
 * when the translator LEAVES the row, so it never does — interrupting the move
 * to the next row is exactly what the decision ruled out.
 */
export type RepetitionGesture = "click" | "typed"

export interface RepetitionValidationCell extends RepetitionCell {
  /** Who has signed off the active lane's current text. */
  activeValidators?: readonly string[]
}

/** Can the caller write this row at all (not locked by someone else, in scope)? */
export type RepetitionWritable = (cell: { id: string; fileId: string }) => boolean

type ResolveParentId = PlanRepetitionPropagationInput["resolveParentId"]

/** The fill a validation owes, and what "Validate all" would add to it. */
export interface RepetitionPlan {
  /** Rows whose text changes (AQU-1391's fill), already writable-filtered. */
  fills: RepetitionCommit[]
  /**
   * Rows "Validate all" signs off: every filled row, plus repetitions that
   * already carry the identical text but nobody has validated (a fill from an
   * earlier "Just this row", say). The fill planner skips those — they need no
   * write — which is why this set is computed apart from `fills`.
   */
  validateIds: string[]
}

function sameGroup(
  cells: readonly RepetitionValidationCell[],
  fileId: string,
  key: string,
): RepetitionValidationCell[] {
  return cells.filter(
    (c) => isVisibleCell(c) && c.fileId === fileId && normalizeRepetitionSource(c.original) === key,
  )
}

/**
 * Identical-text repetitions nobody needs to write but "Validate all" signs
 * off: not validated, not already carrying this reader's vote.
 */
function identicalToValidate(
  members: readonly RepetitionValidationCell[],
  value: string,
  skipIds: ReadonlySet<string>,
  username: string,
  isWritable: RepetitionWritable,
): string[] {
  const text = value.trim()
  return members
    .filter((c) =>
      !skipIds.has(c.id)
      && c.status !== "validated"
      && c.translated.trim() === text
      && !c.activeValidators?.includes(username)
      && isWritable(c))
    .map((c) => c.id)
}

/** The repetition plan for ONE validated row (the click and typed-edit paths). */
export function planRepetitionValidation({
  seedId,
  cells,
  username,
  isWritable,
  resolveParentId,
}: {
  seedId: string
  cells: readonly RepetitionValidationCell[]
  username: string
  isWritable: RepetitionWritable
  resolveParentId?: ResolveParentId
}): RepetitionPlan {
  const seed = cells.find((c) => c.id === seedId && isVisibleCell(c))
  const key = seed ? normalizeRepetitionSource(seed.original) : ""
  if (!seed || !key || !seed.translated.trim()) return { fills: [], validateIds: [] }

  const fills = planRepetitionPropagation({
    confirmedCellId: seedId,
    cells: [...cells],
    resolveParentId,
  }).filter((c) => isWritable({ id: c.cellId, fileId: c.fileId }))

  const filled = new Set(fills.map((c) => c.cellId))
  const identical = identicalToValidate(
    sameGroup(cells, seed.fileId, key),
    seed.translated,
    new Set([seedId, ...filled]),
    username,
    isWritable,
  )
  // A filled row's earlier votes are reset by the fill commit itself, so it
  // always needs this reader's vote — even if it carried one before.
  return { fills, validateIds: [...filled, ...identical] }
}

/** One distinct translation the run's own rows hold for a repeated source. */
export interface RepetitionCandidate {
  value: string
  valueHtml?: string
  /** The run's rows holding it, in document order. */
  cellIds: string[]
}

/** One repeated source touched by a bulk validation. */
export interface BulkRepetitionGroup {
  fileId: string
  key: string
  /**
   * Distinct translations among the run's rows in this group, in document
   * order of their first row. More than one is a conflict: the rows outside
   * the run can only receive one of them (decision 5 — ask the reviewer).
   */
  candidates: RepetitionCandidate[]
  /** Rows outside the run that may receive a candidate: visible, unvalidated, writable. */
  targets: RepetitionValidationCell[]
}

/**
 * Plan a bulk validation's repetitions AS A WHOLE (decision 3). A row the run
 * validates is a seed: it keeps its own text and is never a target, so two
 * repetitions validated in the same gesture can never overwrite each other.
 * Groups with no row left to receive anything are dropped.
 */
export function planBulkRepetitionGroups({
  seedIds,
  cells,
  isWritable,
}: {
  seedIds: readonly string[]
  cells: readonly RepetitionValidationCell[]
  isWritable: RepetitionWritable
}): BulkRepetitionGroup[] {
  const seedSet = new Set(seedIds)
  const groups = new Map<string, BulkRepetitionGroup>()
  // Walk in document order so candidates and targets come out in it too.
  for (const cell of cells) {
    if (!seedSet.has(cell.id) || !isVisibleCell(cell)) continue
    const key = normalizeRepetitionSource(cell.original)
    const value = cell.translated
    if (!key || !value.trim()) continue
    const groupKey = `${cell.fileId}\u0000${key}`
    let group = groups.get(groupKey)
    if (!group) {
      group = { fileId: cell.fileId, key, candidates: [], targets: [] }
      groups.set(groupKey, group)
    }
    const existing = group.candidates.find((c) => c.value.trim() === value.trim())
    if (existing) existing.cellIds.push(cell.id)
    else group.candidates.push({ value, valueHtml: cell.translatedHtml, cellIds: [cell.id] })
  }

  const out: BulkRepetitionGroup[] = []
  for (const group of groups.values()) {
    group.targets = sameGroup(cells, group.fileId, group.key).filter(
      (c) => !seedSet.has(c.id) && c.status !== "validated" && isWritable(c),
    )
    if (group.targets.length > 0) out.push(group)
  }
  return out
}

/** How a "Do the same for the rest of this run" answer applies to the next conflict. */
export type ConflictRule = "first" | "last" | "skip"

/** The candidate a remembered conflict rule picks, or null for "skip". */
export function candidateForRule(
  group: BulkRepetitionGroup,
  rule: ConflictRule,
): RepetitionCandidate | null {
  if (rule === "skip") return null
  const { candidates } = group
  return (rule === "first" ? candidates[0] : candidates[candidates.length - 1]) ?? null
}

/**
 * The rule a pick stands for, so it can be reused for later conflicts. A pick
 * between the first and last candidate has no positional meaning, so it
 * cannot be remembered.
 */
export function ruleForPick(group: BulkRepetitionGroup, pick: number | "skip"): ConflictRule | null {
  if (pick === "skip") return "skip"
  if (pick === 0) return "first"
  if (pick === group.candidates.length - 1) return "last"
  return null
}

/** One group's fill and sign-off once its text is chosen. */
export function planGroupRepetition({
  group,
  candidate,
  username,
  resolveParentId,
}: {
  group: BulkRepetitionGroup
  candidate: RepetitionCandidate
  username: string
  resolveParentId?: ResolveParentId
}): RepetitionPlan {
  const text = candidate.value.trim()
  const fills = group.targets
    .filter((c) => c.translated.trim() !== text)
    .map((c) => repetitionCommitFor(c, candidate.value, candidate.valueHtml, resolveParentId))
  const filled = new Set(fills.map((c) => c.cellId))
  // Targets are already writable-filtered.
  const identical = identicalToValidate(group.targets, candidate.value, filled, username, () => true)
  return { fills, validateIds: [...filled, ...identical] }
}

/**
 * Decision 7: the project's "Batch validation size" caps a bulk run, and the
 * repetitions it signs off count toward it. Returns how many repetition votes
 * still fit after the run's own rows; null when the run is uncapped.
 */
export function repetitionValidationRoom(cap: number | null | undefined, seedCount: number): number | null {
  if (typeof cap !== "number" || cap <= 0) return null
  return Math.max(0, cap - seedCount)
}
