/**
 * AQU-983: what a file-wide batch may include, decided in the modal.
 *
 * Daniel Losey, 30 Sep 2026: reviewers get a bulk option to validate
 * AI-drafted cells. The 1 Oct note puts batch drafting and batch validation
 * in one kind of modal, with the choices drawn from what this file contains.
 *
 * Two passes, which the role ladder already names:
 * - Contributor is the first-pass translator. They still cannot sweep
 *   untouched AI drafts (AQU-622). Those stay for one cell at a time.
 * - Reviewer is the consultant who signs work off without rewriting it, and
 *   project lead and above are the team leads who do the second pass. They
 *   may include untouched AI drafts. A cell someone has already validated is
 *   ordinary second-pass work even when `aiDrafted` is still set, so it does
 *   not need that option.
 *
 * Contributor sits between reviewer and project lead, so this is not a role
 * floor. A missing role fails open, the same way `canPerform` does on a
 * local project.
 *
 * The selection toolbar does not ask this. Choosing lines and pressing
 * "Validate text" is the per-cell review AQU-1703 restored.
 */
import { ROLE } from "@/lib/frontier/roles"
import { isVisibleCell } from "@/lib/cells/hidden"
import { effectiveSourceText } from "@/lib/cell-text"
import type { SegmentMedium } from "@/lib/sync/cells-read-types"

export function isUntouchedAiDraft(cell: {
  aiDrafted?: boolean
  activeValidators?: readonly string[] | null
}): boolean {
  return cell.aiDrafted === true && (cell.activeValidators?.length ?? 0) === 0
}

export function canIncludeUntouchedAiDrafts(roleLevel: number | null | undefined): boolean {
  if (roleLevel == null) return true
  if (roleLevel === ROLE.REVIEWER) return true
  return roleLevel >= ROLE.PROJECT_LEAD
}

export interface DraftChoiceCell {
  translated: string
  hidden?: boolean
  aiDrafted?: boolean
  activeValidators?: readonly string[] | null
  /** CellSummary's derived flag. Cell views use `status` instead. */
  validated?: boolean
  status?: string
  original?: string
  medium?: SegmentMedium | null
  transcription?: string
}

export interface DraftFileGroups<T> {
  /** Visible cells with source text and an empty target. */
  empty: T[]
  /** Visible untouched AI drafts that still have text to replace. */
  refreshable: T[]
  /** Translations a person owns. Never offered as a draft target. */
  humanOwned: number
  /** Parked with Hide cell. Never drafted. */
  hidden: number
}

export interface DraftRunChoices {
  includeEmpty: boolean
  refreshAiDrafts: boolean
  /** "next" keeps the project's completion package size. "all" does not. */
  scope: "next" | "all"
  batchSize: number
}

export interface ValidateRunChoices {
  includeReadyCells: boolean
  includeUntouchedAiDrafts: boolean
}

function alreadyReviewed(cell: DraftChoiceCell): boolean {
  return cell.validated === true
    || cell.status === "validated"
    || (cell.activeValidators?.length ?? 0) > 0
}

/**
 * The open file, split the way the draft modal offers it.
 *
 * Human-owned text is counted and then left alone: refreshing it would spend
 * a draft on words a person already wrote. Hidden cells are the same exclusion
 * `draftTargets` already makes, so a parked row cannot be drafted by ticking
 * a box.
 */
export function classifyBatchDraft<T extends DraftChoiceCell>(cells: readonly T[]): DraftFileGroups<T> {
  const empty: T[] = []
  const refreshable: T[] = []
  let humanOwned = 0
  let hidden = 0
  for (const cell of cells) {
    if (!isVisibleCell(cell)) {
      hidden++
      continue
    }
    if (!effectiveSourceText({
      medium: cell.medium,
      transcription: cell.transcription,
      original: cell.original ?? "",
    }).trim()) continue
    if (!cell.translated.trim()) {
      empty.push(cell)
      continue
    }
    if (cell.aiDrafted === true && !alreadyReviewed(cell)) {
      refreshable.push(cell)
      continue
    }
    humanOwned++
  }
  return { empty, refreshable, humanOwned, hidden }
}

/** The cells the draft modal's current ticks will actually send. */
export function selectBatchDraft<T>(
  groups: Pick<DraftFileGroups<T>, "empty" | "refreshable">,
  choices: DraftRunChoices,
): T[] {
  const chosen = [
    ...(choices.includeEmpty ? groups.empty : []),
    ...(choices.refreshAiDrafts ? groups.refreshable : []),
  ]
  if (choices.scope === "all") return chosen
  const size = choices.batchSize > 0 ? Math.floor(choices.batchSize) : chosen.length
  return chosen.slice(0, size)
}
