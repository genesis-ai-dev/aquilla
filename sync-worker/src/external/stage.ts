// Shared changeset staging primitives (AQU-926). Every prepare path — the
// original SetTranslation/PlanImport/LinkMedia/receipt-only paths in prepare.ts
// and the new PatchSettings/EmitEvents command modules — stages through ONE
// insert + reload + response implementation, so the persisted row shape and the
// prepare response envelope can never fork per command kind.

import { errorResponse } from './errors'
import { computeDigest } from './canonical'
import { loadChangeset, changesetToResponse } from './store'
import type { Command } from './commands'
import type { CellPrecondition } from './preconditions'
import type { ChangesetSummary, ExternalEnv, PlannedEventIds } from './types'

/** Act-mode staged changesets live for one hour before they expire. The agent
 *  holds the whole loop, so an hour is generous. Exported so the MCP adapter's
 *  get_capabilities can publish the real value (never invent limits). */
export const CHANGESET_TTL_MS = 60 * 60 * 1000

/**
 * Ask-mode changesets live for 24 hours (AQU-1177 §3).
 *
 * An ask-mode plan is not waiting on the agent — it is waiting on a HUMAN, who
 * has to open the approval link, read the effect summary, and decide. One hour
 * is shorter than a lunch break, let alone an overnight or cross-timezone
 * hand-off: an approval at hour two hit an expired row, lost the staged work,
 * and forced a re-prepare that the human then had to review a second time.
 *
 * We raise the deadline rather than PAUSE the clock while awaiting approval,
 * because there is no "awaiting approval" state to pause on: an ask-mode
 * changeset sits in `staged` from prepare until commit, and a human approval
 * mints a `changeset_confirmations` row without moving the changeset's status
 * (see auth-worker `/changesets/:id/approve`). A paused clock would therefore
 * need a new status plus a migration, and would make the expiry the agent was
 * told at prepare a lie. A longer, fixed, honest deadline is the smaller and
 * more predictable change — `expiresAt` still means exactly what it says.
 *
 * The human's approval is separately short-lived: the confirmation it mints
 * carries its own 15-minute TTL (auth-worker CONFIRMATION_TTL_MS) and is
 * one-time. So widening this window gives the human longer to DECIDE; it does
 * not widen how long an approval stays spendable.
 */
export const CHANGESET_ASK_TTL_MS = 24 * 60 * 60 * 1000

/** Staged lifetime for one autonomy mode — the single place the two TTLs are
 *  chosen between, so no call site can pick the wrong one. */
export function changesetTtlMs(autonomyMode: 'ask' | 'act'): number {
  return autonomyMode === 'ask' ? CHANGESET_ASK_TTL_MS : CHANGESET_TTL_MS
}

/** Fallback SPA host for the ask-mode approval deep link. BASE_URL (wrangler
 *  vars) names the environment's app host; when it is unset or empty the
 *  production host keeps the link ABSOLUTE — an agent handed a relative
 *  "/approve/:id" cannot open it and (observed in the field) tells the human
 *  to reconstruct the host themselves. */
const DEFAULT_APP_BASE_URL = 'https://aquilla.app'

/** Absolute approval-page deep link for a changeset. */
export function approvalUrlFor(env: Pick<ExternalEnv, 'BASE_URL'>, changesetId: string): string {
  return `${env.BASE_URL || DEFAULT_APP_BASE_URL}/approve/${changesetId}`
}

export interface StageChangesetArgs {
  id: string
  projectId: string
  /** The credential owner's user id (stringified). */
  createdByUserId: string
  credentialId: string
  autonomyMode: 'ask' | 'act'
  commands: Command[]
  preconditions: CellPrecondition[]
  summary: ChangesetSummary
  plannedIds: PlannedEventIds
}

/**
 * Idempotent staged-changeset insert (ON CONFLICT (id) DO NOTHING) + canonical
 * re-load + the standard prepare response ({ changeset, summary, digest,
 * approvalUrl }). Digest = SHA-256 over canonical(commands + preconditions);
 * the planned-id ledger rides in the summary JSONB column (no new column —
 * split back out on load) and never perturbs the digest.
 */
export async function stageAndRespond(
  db: AquillaDb,
  env: ExternalEnv,
  args: StageChangesetArgs,
): Promise<Response> {
  const digest = await computeDigest(args.commands, args.preconditions)
  // Ask-mode plans wait on a human, so they get the longer deadline (AQU-1177).
  const expiresAt = new Date(Date.now() + changesetTtlMs(args.autonomyMode)).toISOString()

  await db
    .prepare(
      `INSERT INTO changesets (
         id, project_id, created_by_user_id, credential_id, autonomy_mode,
         status, commands, preconditions, summary, digest, expires_at
       ) VALUES (?, ?, ?, ?, ?, 'staged', ?::text::jsonb, ?::text::jsonb, ?::text::jsonb, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(
      args.id,
      args.projectId,
      args.createdByUserId,
      args.credentialId,
      args.autonomyMode,
      JSON.stringify(args.commands),
      JSON.stringify(args.preconditions),
      JSON.stringify({ ...args.summary, plannedIds: args.plannedIds }),
      digest,
      expiresAt,
    )
    .run()

  // Re-load to return the canonical persisted row (existing one on id-replay).
  const stored = await loadChangeset(db, args.projectId, args.id)
  if (!stored) return errorResponse('job_failed', 'changeset insert did not persist')

  return Response.json({
    changeset: changesetToResponse(stored),
    summary: stored.summary,
    digest: stored.digest,
    approvalUrl: approvalUrlFor(env, stored.id),
  })
}
