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
 * which drops out-of-scope cells, cells already signed off by the caller and
 * (where the project forbids self-validation) the caller's own latest change.
 * A file whose unvalidated cells are all out of the caller's scope therefore
 * reads "12 cells currently unvalidated" and then validates zero. That gap is
 * a gap to *report*, which is what this module makes possible.
 *
 * AQU-1703: an explicit selection does not drop untouched AI drafts. The
 * selection toolbar calls this with the defaults below, so a reviewer who
 * picked a colleague's lines is not told to review them one at a time.
 *
 * AQU-983: a file-wide run may pass `includeUntouchedAiDrafts: false`. Those
 * lines then land in `aiDraft` and the modal says so, instead of the click
 * appearing to do nothing. A cell someone else has already validated is not
 * untouched, so a second pass includes it either way. `notChosen` is the
 * same kind of account for the "ready for your check" box left unticked.
 *
 * AQU-2507: `cap` is no longer a per-CLICK ceiling on the file-wide run. It is
 * the size of one chunk, and the run loops over `chunksOf(…)` until the file is
 * done, so a reviewer accepting five pretranslated books clicks once per file
 * rather than once per 500 cells. `cappedOut` therefore only ever fills for a
 * caller that still asks to stop at a cap; `workspaceBatchValidateOptions` no
 * longer does, and the confirmation dialog promises the whole eligible count.
 *
 * AQU-2507 also adds the `flagged` bucket: cells a check or rule has flagged
 * are left out by default and offered as an explicit opt-in, because
 * validation is human authority — a reviewer signing off text that was
 * approved outside Aquilla may overrule a mechanical flag — but it has to be a
 * choice they make, not one the batch makes for them.
 *
 * So the eligibility split and the reason each cell was skipped are computed
 * once, here, as plain data: both surfaces render the same words and emit the
 * same telemetry, and the guard branches are unit-testable without React.
 */
import { isBulkValidatableByMe, type BulkValidatePolicy } from "@/lib/review/bulk-validation"
import { isUntouchedAiDraft } from "@/lib/review/batch-file-options"
import { isOwnTextEdit, textValidationScope } from "@/lib/review/text-validation-policy"
import { isInMemberScope, type MemberScope } from "@/lib/sync/member-scopes"
import { canPerform } from "@/lib/sync/role-policy"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { TVars } from "@/lib/i18n/translate"

export interface BatchValidateCandidate {
  id: string
  fileId: string
  translated: string
  targetEventId?: string | null
  /** `cells.ai_drafted`. Carried, never an eligibility input (AQU-1703). */
  aiDrafted?: boolean
  activeValidators?: string[]
  /** AQU-1571: who wrote the current text in the active lane. */
  lastEditor?: string | null
}

/**
 * Why a candidate was not validated. Every skipped cell lands in exactly one
 * bucket, so the buckets sum to `candidates.length - validatable.length` and a
 * summary can never quietly lose a cell.
 */
export type BatchValidateSkipReason =
  | "needsTranslation"
  | "aiDraft"
  | "flagged"
  | "alreadyMine"
  | "ownEdit"
  | "outOfScope"
  | "notCommitted"
  | "notChosen"

export const BATCH_VALIDATE_SKIP_REASONS: readonly BatchValidateSkipReason[] = [
  "needsTranslation",
  "aiDraft",
  "flagged",
  "alreadyMine",
  "ownEdit",
  "outOfScope",
  "notCommitted",
  "notChosen",
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
   * Cells dropped purely by a caller-requested cap rather than by eligibility.
   * Capped cells are still validatable — the user just has to run again — so
   * they are deliberately NOT a skip reason.
   *
   * AQU-2507: the file-wide run no longer asks for a cap. It chunks instead
   * (`chunksOf`) and loops to completion, so this is 0 on that path and the
   * dialog can promise the number the whole run will deliver.
   */
  cappedOut: number
  outcome: BatchValidateOutcome
  /**
   * AQU-1571: on a "no-permission" outcome, which rule shut the reader out —
   * their role, or the project's named-validator list. Only the wording
   * differs; telemetry keeps the one outcome.
   */
  noPermissionReason?: BatchValidateNoPermissionReason
}

/** Why a reader may validate no text at all on this project. */
export type BatchValidateNoPermissionReason = "role" | "allowlist"

function emptySkips(): BatchValidateSkips {
  return {
    needsTranslation: 0,
    aiDraft: 0,
    flagged: 0,
    alreadyMine: 0,
    ownEdit: 0,
    outOfScope: 0,
    notCommitted: 0,
    notChosen: 0,
  }
}

/**
 * Why this one cell cannot be bulk-validated by `username`, or `null` if it can.
 *
 * Order is by what the user can act on: "write a translation" before "you
 * already signed this off". Scope comes last of the real reasons because it is
 * the only one the reader cannot resolve themselves.
 */
export function batchValidateSkipReason(
  cell: BatchValidateCandidate,
  username: string,
  myScopes: MemberScope[],
  activeLane: string,
  policy: BulkValidatePolicy = {},
): BatchValidateSkipReason | null {
  if (isBulkValidatableByMe(cell, username, myScopes, activeLane, policy)) return null
  if (!cell.translated.trim()) return "needsTranslation"
  if (cell.activeValidators?.includes(username)) return "alreadyMine"
  if (!cell.targetEventId) return "notCommitted"
  if (isOwnTextEdit(cell, username, policy.allowSelfValidation)) return "ownEdit"
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
   * AQU-586: a hard ceiling on how many eligible cells this summary returns.
   * 0/undefined = no cap. AQU-2507: the file-wide run stopped asking for one —
   * it chunks and loops instead — so this is only for a caller that genuinely
   * wants one summary to stop short.
   */
  cap?: number | null
  /** False when the caller cannot validate text at all: their role, or the
   *  project's minimum role / named-validator list (`textValidationScope`). */
  canValidate?: boolean
  /** With `canValidate: false`: which of those rules it was. Absent reads as
   *  "role", the wording every caller used before AQU-1571. */
  noPermissionReason?: BatchValidateNoPermissionReason
  /** False when there is no project/file to validate against. */
  hasTarget?: boolean
  /**
   * AQU-1571: the project's "Allow self-validation". When false, a line whose
   * latest change is the caller's is skipped as "ownEdit" — the server would
   * refuse its vote.
   */
  allowSelfValidation?: boolean
  /**
   * AQU-983: file-wide batch validate leaves untouched AI drafts out unless
   * the modal opts in. Absent means include them — the selection toolbar.
   */
  includeUntouchedAiDrafts?: boolean
  /**
   * AQU-983: the "ready for your check" box. Absent means include them.
   * Unticked cells are `notChosen`, not a refusal.
   */
  includeReadyCells?: boolean
  /**
   * AQU-2507: does this cell carry an open (non-waived) check or rule flag?
   * Absent means "ask nothing" — the selection toolbar does not, so a reviewer
   * who picked flagged lines by hand still signs them off.
   */
  hasOpenFlags?: (cellId: string) => boolean
  /**
   * AQU-2507: the "Also validate N cells with open check flags" opt-in.
   * Default (absent/false) leaves them out and REPORTS them, because
   * overruling a check is a decision a reviewer makes deliberately.
   */
  includeFlaggedCells?: boolean
}

export function summarizeBatchValidate(
  candidates: readonly BatchValidateCandidate[],
  options: SummarizeOptions,
): BatchValidateSummary {
  const {
    username, myScopes, activeLane, cap, canValidate = true, hasTarget = true, allowSelfValidation,
    noPermissionReason = "role",
    includeUntouchedAiDrafts = true,
    includeReadyCells = true,
    hasOpenFlags,
    includeFlaggedCells = false,
  } = options
  const skips = emptySkips()

  if (!hasTarget) {
    return { validatable: [], skips, skippedTotal: 0, cappedOut: 0, outcome: "no-target" }
  }
  if (!canValidate) {
    return { validatable: [], skips, skippedTotal: 0, cappedOut: 0, outcome: "no-permission", noPermissionReason }
  }

  const eligible: BatchValidateCandidate[] = []
  for (const cell of candidates) {
    const reason = batchValidateSkipReason(cell, username, myScopes, activeLane, { allowSelfValidation })
    if (reason !== null) {
      skips[reason]++
      continue
    }
    const untouched = isUntouchedAiDraft(cell)
    if (untouched && !includeUntouchedAiDrafts) {
      skips.aiDraft++
      continue
    }
    if (!untouched && !includeReadyCells) {
      skips.notChosen++
      continue
    }
    // AQU-2507: asked last of the choices, so a cell that is both an untouched
    // AI draft and flagged is reported under the box the reader can see rather
    // than under a second one explaining the same cell twice.
    if (!includeFlaggedCells && hasOpenFlags?.(cell.id)) {
      skips.flagged++
      continue
    }
    eligible.push(cell)
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
 * AQU-1571: the options the "Batch validate text…" workspace action summarizes
 * with, built from the open project. Pulled out of ProjectWorkspace so the
 * project's rules (role, minimum role, named validators, "Allow
 * self-validation") are pinned by a unit test: dropping one of them sent the
 * run straight back to queuing votes the server refuses, with every test green.
 */
export function workspaceBatchValidateOptions(args: {
  project:
    | Pick<
        ProjectRecord,
        "id" | "syncRole" | "completionSettings" | "allowSelfValidation" | "validationRoleFloor" | "validationNamedUsers"
      >
    | null
    | undefined
  activeFileId: string | null | undefined
  username: string
  myScopes: MemberScope[]
  activeLane: string
}): SummarizeOptions {
  const { project, activeFileId, username, myScopes, activeLane } = args
  const roleLevel = project?.syncRole?.level ?? null
  const roleCanValidate = canPerform("cell.validate", roleLevel)
  const scope = project ? textValidationScope(project, { roleLevel, username }) : null
  return {
    username,
    myScopes,
    activeLane,
    // AQU-2507: no `cap`. The project's `validationBatchSize` is the run's
    // CHUNK size now (`batchValidateChunkSize`), not a ceiling that strands the
    // rest of the file for another click, so the summary this builds describes
    // every eligible cell in the file.
    // The server enforces the project's minimum role and named-validator list
    // on every vote; a reader they exclude gets the no-permission outcome
    // instead of a batch of refusals.
    canValidate: roleCanValidate && (scope?.canValidate ?? true),
    noPermissionReason: roleCanValidate && scope?.reason === "allowlist" ? "allowlist" : "role",
    hasTarget: Boolean(project?.id && activeFileId),
    allowSelfValidation: project?.allowSelfValidation,
  }
}

// ---------------------------------------------------------------------------
// Chunking — one user action, as many writes as the file needs (AQU-2507)
// ---------------------------------------------------------------------------

/**
 * The chunk size a run falls back to when the project configures none.
 *
 * The reported ceiling was ~500 and the event pipeline handled it, so 500 is
 * kept as the batch the run writes and flushes at a time. The difference is
 * that reaching it is no longer the end of the run.
 */
export const BATCH_VALIDATE_CHUNK_FALLBACK = 500

/** The project's batch size as a CHUNK size: a positive integer, always. */
export function batchValidateChunkSize(size: number | null | undefined): number {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return BATCH_VALIDATE_CHUNK_FALLBACK
  }
  return Math.max(1, Math.floor(size))
}

/**
 * The run's writes, split into chunks of `size` in candidate order.
 *
 * Every cell appears in exactly one chunk, so looping over the result does the
 * whole of `cells` — the property the old per-click cap broke. An empty input
 * yields no chunks, so a caller's `for` loop body never runs on nothing.
 */
export function chunksOf<T>(cells: readonly T[], size: number): T[][] {
  const step = batchValidateChunkSize(size)
  const chunks: T[][] = []
  for (let at = 0; at < cells.length; at += step) chunks.push(cells.slice(at, at + step))
  return chunks
}

/**
 * The properties every batch-validate attempt reports, whatever its outcome.
 * A no-op attempt is exactly the case this surface could not previously prove,
 * so the event fires on the dead branches too.
 */
export function batchValidateTelemetry(
  summary: BatchValidateSummary,
  source: "selection" | "workspace-action",
  /**
   * AQU-2507: how the run actually went — the eligible total it set out to do,
   * the chunk size it wrote in, how many chunks that took, and whether the
   * reader opted flagged cells in. Absent on a surface that does not chunk.
   */
  run?: { chunks: number; chunkSize: number; includedFlagged: boolean },
): Record<string, string | number> {
  return {
    source,
    outcome: summary.outcome,
    validated_count: summary.validatable.length,
    skipped_count: summary.skippedTotal,
    capped_out_count: summary.cappedOut,
    skipped_flagged: summary.skips.flagged,
    ...(run
      ? {
        eligible_total: summary.validatable.length,
        chunk_count: run.chunks,
        chunk_size: run.chunkSize,
        included_flagged: run.includedFlagged ? 1 : 0,
      }
      : {}),
    skipped_needs_translation: summary.skips.needsTranslation,
    skipped_already_mine: summary.skips.alreadyMine,
    skipped_own_edit: summary.skips.ownEdit,
    skipped_out_of_scope: summary.skips.outOfScope,
    skipped_not_committed: summary.skips.notCommitted,
    skipped_ai_draft: summary.skips.aiDraft,
    skipped_not_chosen: summary.skips.notChosen,
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

/**
 * AQU-1571: "your role cannot validate" is wrong for a reader the project's
 * named-validator list leaves out: their role is fine, and a role change
 * would not help. Shared by the selection bar's disabled reason, the toast
 * and the "Batch validate text…" confirmation.
 */
export function noPermissionMessage(
  summary: Pick<BatchValidateSummary, "noPermissionReason">,
  t: Translate,
): string {
  return summary.noPermissionReason === "allowlist"
    ? t("editor.batchValidate.notNamedValidator")
    : t("editor.batchValidate.noPermission")
}

/** `useFormat().list` — a locale-aware join, not `.join(", ")`. */
type JoinList = (items: readonly string[]) => string

const SKIP_MESSAGE_KEY: Record<BatchValidateSkipReason, MessageKey> = {
  needsTranslation: "editor.batchValidate.skip.needsTranslation",
  aiDraft: "editor.batchValidate.skip.aiDraft",
  flagged: "editor.batchValidate.skip.flagged",
  alreadyMine: "editor.batchValidate.skip.alreadyMine",
  ownEdit: "editor.batchValidate.skip.ownEdit",
  outOfScope: "editor.batchValidate.skip.outOfScope",
  notCommitted: "editor.batchValidate.skip.notCommitted",
  notChosen: "editor.batchValidate.skip.notChosen",
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
      return { type: "error", title: noPermissionMessage(summary, t) }
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
 * AQU-2507: the trailing note used to say "at most {cap} per run; run again to
 * continue", which is the behavior this ticket removes. `chunkSize` is passed
 * separately from the summary so the note can say the opposite — that the run
 * saves in batches of that size and keeps going — on exactly the runs big
 * enough for the reader to wonder.
 */
export function batchValidateConfirmDescription(
  summary: BatchValidateSummary,
  t: Translate,
  joinList: JoinList,
  chunkSize?: number | null,
): string {
  // The dead-end outcomes borrow the toast's wording rather than mint a second
  // phrasing for "your role cannot do this" in the nav namespace.
  switch (summary.outcome) {
    case "no-target":
      return t("editor.batchValidate.noTarget")
    case "no-permission":
      return noPermissionMessage(summary, t)
    case "no-candidates":
      return t("editor.batchValidate.noCandidates")
    default:
      break
  }

  // `includeCappedOut: false` because a cap the file-wide run no longer asks
  // for cannot hold anything back here; a caller that does ask for one explains
  // it in its own words.
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
    // No chunk note here: how a run would be written is not why it will do
    // nothing, and saying so would read as the reason.
    return t("nav.workspaceActions.batchValidate.nothingToValidate") + skippedClause
  }

  // AQU-2507: only on a run that will take more than one chunk. On a 40-cell
  // file the sentence would raise a question the reader did not have.
  const chunk = batchValidateChunkSize(chunkSize)
  const chunkNote = summary.validatable.length > chunk
    ? t("nav.workspaceActions.batchValidate.runsToCompletion", { cap: chunk })
    : ""
  return (
    t("nav.workspaceActions.batchValidate.willValidate", { count: summary.validatable.length })
    + skippedClause
    + chunkNote
  )
}
