/**
 * AQU-1503: one summary of what a batch text-validation will actually do.
 *
 * WHY THIS EXISTS. Both bulk-validate surfaces — the selection toolbar's
 * "Validate text" button and the workspace action "Batch validate text…",
 * whose confirm button carries the same label — decided what to emit with an
 * inline `filter` and then said nothing about the cells they dropped. The
 * workspace-action path said nothing at all: four bare `return`s, no toast on
 * any branch, so a confirmed dialog that found nothing eligible was a dead
 * click with no events, no error and no telemetry to prove it had happened.
 *
 * The count the confirmation dialog promises comes from file progress — every
 * cell without a validator — while the run filters with `isBulkValidatableByMe`,
 * which drops untouched AI drafts, out-of-scope cells and cells already signed
 * off by the caller. A file whose unvalidated cells are all AI drafts therefore
 * reads "12 cells currently unvalidated" and then validates zero. That gap is
 * not a bug to remove — AI drafts genuinely need individual review — it is a
 * gap to *report*, which is what this module makes possible.
 *
 * So the eligibility split and the reason each cell was skipped are computed
 * once, here, as plain data: both surfaces render the same words and emit the
 * same telemetry, and the guard branches are unit-testable without React.
 */
import { isBulkValidatableByMe } from "@/lib/review/bulk-validation"
import { isInMemberScope, type MemberScope } from "@/lib/sync/member-scopes"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { TVars } from "@/lib/i18n/translate"

export interface BatchValidateCandidate {
  id: string
  fileId: string
  translated: string
  targetEventId?: string | null
  aiDrafted?: boolean
  activeValidators?: string[]
}

/**
 * Why a candidate was not validated. Every skipped cell lands in exactly one
 * bucket, so the buckets sum to `candidates.length - validatable.length` and a
 * summary can never quietly lose a cell.
 */
export type BatchValidateSkipReason =
  | "needsTranslation"
  | "alreadyMine"
  | "aiDraft"
  | "outOfScope"
  | "notCommitted"

export const BATCH_VALIDATE_SKIP_REASONS: readonly BatchValidateSkipReason[] = [
  "needsTranslation",
  "aiDraft",
  "alreadyMine",
  "outOfScope",
  "notCommitted",
]

export type BatchValidateSkips = Record<BatchValidateSkipReason, number>

/**
 * The outcome class reported to PostHog. Coarse on purpose: this is a funnel
 * signal ("did the click do anything?"), and the per-reason counts ride
 * alongside it as properties.
 */
export type BatchValidateOutcome =
  | "validated"
  | "partial"
  | "nothing-eligible"
  | "no-candidates"
  | "no-permission"
  | "no-target"
  | "failed"

export interface BatchValidateSummary {
  /** Cells that will be (or were) emitted, in candidate order. */
  validatable: BatchValidateCandidate[]
  skips: BatchValidateSkips
  skippedTotal: number
  /**
   * Cells dropped purely by the per-run cap rather than by eligibility. Capped
   * cells are still validatable — the user just has to run again — so they are
   * deliberately NOT a skip reason.
   */
  cappedOut: number
  outcome: BatchValidateOutcome
}

function emptySkips(): BatchValidateSkips {
  return { needsTranslation: 0, alreadyMine: 0, aiDraft: 0, outOfScope: 0, notCommitted: 0 }
}

/**
 * Why this one cell cannot be bulk-validated by `username`, or `null` if it can.
 *
 * Order is by what the user can act on: "write a translation" before "this is
 * an AI draft, review it individually" before "you already signed this off".
 * Scope comes last of the real reasons because it is the only one the reader
 * cannot resolve themselves.
 */
export function batchValidateSkipReason(
  cell: BatchValidateCandidate,
  username: string,
  myScopes: MemberScope[],
  activeLane: string,
): BatchValidateSkipReason | null {
  if (isBulkValidatableByMe(cell, username, myScopes, activeLane)) return null
  if (!cell.translated.trim()) return "needsTranslation"
  if (cell.activeValidators?.includes(username)) return "alreadyMine"
  if (!cell.targetEventId) return "notCommitted"
  if (cell.aiDrafted) return "aiDraft"
  if (!isInMemberScope(myScopes, cell.fileId, activeLane)) return "outOfScope"
  // Unreachable while `isBulkValidatableByMe` asks exactly the questions above;
  // kept so a future guard added there degrades to an honest "not committed"
  // rather than to a cell that silently belongs to no bucket at all.
  return "notCommitted"
}

export interface SummarizeOptions {
  username: string
  myScopes: MemberScope[]
  activeLane: string
  /**
   * AQU-586: the project's per-run cap on eligible cells. 0/undefined = no cap.
   */
  cap?: number | null
  /** False when the caller's role cannot validate at all. */
  canValidate?: boolean
  /** False when there is no project/file to validate against. */
  hasTarget?: boolean
}

export function summarizeBatchValidate(
  candidates: readonly BatchValidateCandidate[],
  options: SummarizeOptions,
): BatchValidateSummary {
  const { username, myScopes, activeLane, cap, canValidate = true, hasTarget = true } = options
  const skips = emptySkips()

  if (!hasTarget) {
    return { validatable: [], skips, skippedTotal: 0, cappedOut: 0, outcome: "no-target" }
  }
  if (!canValidate) {
    return { validatable: [], skips, skippedTotal: 0, cappedOut: 0, outcome: "no-permission" }
  }

  const eligible: BatchValidateCandidate[] = []
  for (const cell of candidates) {
    const reason = batchValidateSkipReason(cell, username, myScopes, activeLane)
    if (reason === null) eligible.push(cell)
    else skips[reason]++
  }

  const capped = typeof cap === "number" && cap > 0 ? eligible.slice(0, cap) : eligible
  const cappedOut = eligible.length - capped.length
  const skippedTotal = candidates.length - eligible.length

  let outcome: BatchValidateOutcome
  if (candidates.length === 0) outcome = "no-candidates"
  else if (capped.length === 0) outcome = "nothing-eligible"
  else if (skippedTotal > 0 || cappedOut > 0) outcome = "partial"
  else outcome = "validated"

  return { validatable: capped, skips, skippedTotal, cappedOut, outcome }
}

/**
 * The properties every batch-validate attempt reports, whatever its outcome.
 * A no-op attempt is exactly the case this surface could not previously prove,
 * so the event fires on the dead branches too.
 */
export function batchValidateTelemetry(
  summary: BatchValidateSummary,
  source: "selection" | "workspace-action",
): Record<string, string | number> {
  return {
    source,
    outcome: summary.outcome,
    validated_count: summary.validatable.length,
    skipped_count: summary.skippedTotal,
    capped_out_count: summary.cappedOut,
    skipped_needs_translation: summary.skips.needsTranslation,
    skipped_already_mine: summary.skips.alreadyMine,
    skipped_ai_draft: summary.skips.aiDraft,
    skipped_out_of_scope: summary.skips.outOfScope,
    skipped_not_committed: summary.skips.notCommitted,
  }
}

// ---------------------------------------------------------------------------
// Rendering — one wording for both surfaces
// ---------------------------------------------------------------------------

/**
 * The `t` of `useT()`. Typed against the real catalog key union so a renamed
 * or deleted message fails the build here rather than rendering a raw key in a
 * toast nobody reads.
 */
type Translate = (key: MessageKey, vars?: TVars) => string

/** `useFormat().list` — a locale-aware join, not `.join(", ")`. */
type JoinList = (items: readonly string[]) => string

const SKIP_MESSAGE_KEY: Record<BatchValidateSkipReason, MessageKey> = {
  needsTranslation: "editor.batchValidate.skip.needsTranslation",
  alreadyMine: "editor.batchValidate.skip.alreadyMine",
  aiDraft: "editor.batchValidate.skip.aiDraft",
  outOfScope: "editor.batchValidate.skip.outOfScope",
  notCommitted: "editor.batchValidate.skip.notCommitted",
}

/**
 * The skip clauses, in the order they are most useful to read: what the reader
 * can act on first, the rule they cannot change last. Empty when nothing was
 * skipped and the cap held nothing back.
 */
export function batchValidateSkipClauses(
  summary: BatchValidateSummary,
  t: Translate,
  clauseOrder: readonly BatchValidateSkipReason[] = BATCH_VALIDATE_SKIP_REASONS,
  /**
   * AQU-1507: false where the surface explains the per-run cap in its own
   * words. The confirmation dialog does — it carries the cap note, which says
   * the same thing and says why — and a clause repeating it there would read as
   * two different facts about the same cells.
   */
  includeCappedOut = true,
): string[] {
  const clauses: string[] = []
  for (const reason of clauseOrder) {
    const count = summary.skips[reason]
    if (count > 0) clauses.push(t(SKIP_MESSAGE_KEY[reason], { count }))
  }
  if (includeCappedOut && summary.cappedOut > 0) {
    clauses.push(t("editor.batchValidate.skip.cappedOut", { count: summary.cappedOut }))
  }
  return clauses
}

export interface BatchValidateToast {
  type: "success" | "info" | "error"
  title: string
  description?: string
}

/**
 * The toast an attempt produces — for EVERY outcome, including the ones that
 * emit nothing. A bulk validate that does nothing and says nothing is the bug
 * this issue is about, so there is no branch here that returns `null`.
 */
export function batchValidateToast(
  summary: BatchValidateSummary,
  t: Translate,
  joinList: JoinList,
): BatchValidateToast {
  switch (summary.outcome) {
    case "no-target":
      return { type: "info", title: t("editor.batchValidate.noTarget") }
    case "no-permission":
      return { type: "error", title: t("editor.batchValidate.noPermission") }
    case "no-candidates":
      return { type: "info", title: t("editor.batchValidate.noCandidates") }
    case "failed":
      return {
        type: "error",
        title: t("editor.batchValidate.failedTitle"),
        description: t("editor.batchValidate.failedBody"),
      }
    case "nothing-eligible": {
      const clauses = batchValidateSkipClauses(summary, t)
      return {
        type: "info",
        title: t("editor.batchValidate.nothingEligibleTitle"),
        description:
          clauses.length > 0
            ? joinList(clauses)
            : t("editor.batchValidate.nothingEligibleNoReason"),
      }
    }
    case "partial": {
      const clauses = batchValidateSkipClauses(summary, t)
      return {
        type: "success",
        title: t("editor.selection.validatedToast", { count: summary.validatable.length }),
        description: t("editor.batchValidate.skippedSummary", {
          count: summary.skippedTotal + summary.cappedOut,
          reasons: joinList(clauses),
        }),
      }
    }
    case "validated":
    default:
      return {
        type: "success",
        title: t("editor.selection.validatedToast", { count: summary.validatable.length }),
      }
  }
}

/**
 * AQU-1507: the confirmation body for the "Batch validate text…" workspace
 * action, built from the SAME summary the run consumes.
 *
 * The dialog used to promise the file's unvalidated count (`total - validated`,
 * straight off file progress) while the run filtered with
 * `isBulkValidatableByMe`. On the reported file that read "83 cells are
 * currently unvalidated" and then validated zero, because 79 cells were
 * untranslated and the remaining 4 were untouched AI drafts. Both numbers were
 * honest about different questions; only one of them is the question a
 * confirmation dialog is asking.
 *
 * So the dialog now states what THIS run will do and names everything it will
 * leave alone, using the same clauses as the toast. The invariant that makes
 * the two numbers checkable:
 *
 *     validatable.length + skippedTotal + cappedOut === candidates.length
 *
 * `cap` is passed separately from the summary because the cap NOTE has to
 * appear whenever the project configures a cap — explaining why a second run
 * may be needed — even on a run the cap happens not to trim.
 */
export function batchValidateConfirmDescription(
  summary: BatchValidateSummary,
  t: Translate,
  joinList: JoinList,
  cap?: number | null,
): string {
  // The dead-end outcomes borrow the toast's wording rather than mint a second
  // phrasing for "your role cannot do this" in the nav namespace.
  switch (summary.outcome) {
    case "no-target":
      return t("editor.batchValidate.noTarget")
    case "no-permission":
      return t("editor.batchValidate.noPermission")
    case "no-candidates":
      return t("editor.batchValidate.noCandidates")
    default:
      break
  }

  // Cells the CAP held back are left out of this clause and accounted for by
  // the cap note below instead — they are deferred, not skipped, and the note
  // is where the dialog explains that running again picks them up.
  const clauses = batchValidateSkipClauses(summary, t, BATCH_VALIDATE_SKIP_REASONS, false)
  const skippedClause =
    clauses.length > 0
      // `skippedSummary` is a toast description and ends without punctuation;
      // here it is a sentence in the middle of a paragraph, so it is terminated
      // on composition rather than by duplicating the string with a period.
      ? " " + t("editor.batchValidate.skippedSummary", {
        count: summary.skippedTotal,
        reasons: joinList(clauses),
      }) + "."
      : ""

  if (summary.outcome === "nothing-eligible") {
    // No cap note here: a cap that trims nothing from an empty eligible set is
    // not why this run will do nothing, and saying so would read as the reason.
    return t("nav.workspaceActions.batchValidate.nothingToValidate") + skippedClause
  }

  const capNote =
    typeof cap === "number" && cap > 0
      ? t("nav.workspaceActions.batchValidate.capNote", { cap })
      : ""
  return (
    t("nav.workspaceActions.batchValidate.willValidate", { count: summary.validatable.length })
    + skippedClause
    + capNote
  )
}
