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

/** Staged changesets live for one hour before they expire. Exported so the MCP
 *  adapter's get_capabilities can publish the real value (never invent limits). */
export const CHANGESET_TTL_MS = 60 * 60 * 1000

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
  const expiresAt = new Date(Date.now() + CHANGESET_TTL_MS).toISOString()

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
