// Shared commit primitives (AQU-926). commit.ts and the new command modules
// (commands-patch-settings.ts, emit-events-engine.ts) share the receipt-only
// gate sequence, the provenance envelope builder, and the committed-receipt
// write, so the state machine and provenance shape can never fork per command.

import { errorResponse } from './errors'
import { loadChangeset } from './store'
import type {
  ChangesetReceipt,
  MemoryWriteReceipt,
  ProvenanceChannel,
  ReceiptOnlyReceipt,
  StoredChangeset,
} from './types'

/** Response shape of the internal /events perimeter POST. */
export interface EventsWriteResponse {
  accepted: { id: string }[]
  rejected: { id: string; status: number; reason: string }[]
  stale?: { id: string; fileId: string | null; cellId: string | null }[]
  staleSource?: { id: string; currentSourceEventId: string }[]
}

/** Parse the caller-declared agent metadata header (recorded, never verified). */
export function readAgentMeta(request: Request): unknown {
  const header = request.headers.get('x-agent-meta')
  if (!header) return null
  try {
    return JSON.parse(header)
  } catch {
    return null
  }
}

/** Build the server-verified provenance envelope (§2). `channel` is decided by
 *  the entrypoint (PAT REST/MCP header sniff, or 'app' for session routes) —
 *  never trusted from external headers beyond the internal MCP marker. */
export function buildProvenance(
  request: Request,
  cs: StoredChangeset,
  confirmationId: string | null,
  channel: ProvenanceChannel,
): Record<string, unknown> {
  return {
    origin: 'agent',
    human_authority: { user_id: cs.createdByUserId, credential_id: cs.credentialId },
    agent: readAgentMeta(request),
    channel,
    autonomy_mode: cs.autonomyMode,
    changeset_id: cs.id,
    ...(confirmationId ? { confirmation_id: confirmationId } : {}),
  }
}

/** Stamp the provenance envelope onto the applied events rows. */
export async function stampProvenance(
  db: AquillaDb,
  provenance: Record<string, unknown>,
  appliedIds: readonly string[],
): Promise<void> {
  if (appliedIds.length === 0) return
  const placeholders = appliedIds.map(() => '?').join(', ')
  await db
    .prepare(`UPDATE events SET provenance = ?::text::jsonb WHERE id IN (${placeholders})`)
    .bind(JSON.stringify(provenance), ...appliedIds)
    .run()
}

/** Terminal committed write: receipt + consumed confirmation + committed_at. */
export async function writeCommittedReceipt(
  db: AquillaDb,
  changesetId: string,
  receipt: ChangesetReceipt | ReceiptOnlyReceipt | MemoryWriteReceipt,
  confirmationId: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE changesets
          SET status = 'committed', receipt = ?::text::jsonb, confirmation_id = ?, committed_at = now()
        WHERE id = ?`,
    )
    .bind(JSON.stringify(receipt), confirmationId, changesetId)
    .run()
}

/** Mark a changeset stale (guarded on the in-flight statuses). */
export async function markChangesetStale(db: AquillaDb, changesetId: string): Promise<void> {
  await db
    .prepare(`UPDATE changesets SET status = 'stale' WHERE id = ? AND status IN ('staged','committing')`)
    .bind(changesetId)
    .run()
}

/** Mark a changeset superseded (P1 §3.2) — the drift that stopped this commit
 *  is the plan's own end-state, already applied by hand. Same guard as
 *  markChangesetStale so a concurrent committer's terminal write always wins. */
export async function markChangesetSuperseded(db: AquillaDb, changesetId: string): Promise<void> {
  await db
    .prepare(`UPDATE changesets SET status = 'superseded' WHERE id = ? AND status IN ('staged','committing')`)
    .bind(changesetId)
    .run()
}

/**
 * Shared staged→committing gate sequence for receipt-only commits. There are no
 * per-cell preconditions, so no drift re-check — the CreateProject id-collision
 * / UpdateProjectSettings / PatchSettings version guard is enforced by the
 * apply step itself. On the first attempt (status==='staged') this checks
 * expiry, consumes the one-time ask-mode confirmation, and flips to
 * 'committing'; a crash-retry (status==='committing') re-uses the persisted
 * confirmation id and skips the gates (matching the SetTranslation / PlanImport
 * path). Returns the (possibly consumed) confirmation id, or an error Response
 * to short-circuit.
 */
export async function receiptOnlyGates(
  db: AquillaDb,
  cs: StoredChangeset,
): Promise<{ confirmationId: string | null } | Response> {
  if (cs.status !== 'staged') return { confirmationId: cs.confirmationId ?? null }

  if (new Date(cs.expiresAt).getTime() < Date.now()) {
    await db
      .prepare(`UPDATE changesets SET status = 'expired' WHERE id = ? AND status IN ('staged','committing')`)
      .bind(cs.id)
      .run()
    return errorResponse('validation_failed', 'changeset has expired')
  }

  let confirmationId: string | null = cs.confirmationId ?? null
  if (cs.autonomyMode === 'ask') {
    const consumed = await db
      .prepare(
        `UPDATE changeset_confirmations SET consumed_at = now()
           WHERE changeset_id = ? AND credential_id = ? AND digest = ?
             AND consumed_at IS NULL AND expires_at > now()
         RETURNING id`,
      )
      .bind(cs.id, cs.credentialId, cs.digest)
      .first<{ id: string }>()
    if (!consumed) {
      return errorResponse(
        'confirmation_required',
        'ask-mode changeset requires a valid, unconsumed human approval',
      )
    }
    confirmationId = consumed.id
  }

  const flip = await db
    .prepare(
      `UPDATE changesets SET status = 'committing', confirmation_id = ?
         WHERE id = ? AND status = 'staged'`,
    )
    .bind(confirmationId, cs.id)
    .run()
  // A 0-row flip means a concurrent commit of this same changeset won the
  // staged→committing race. Return the winner's stored receipt if it already
  // committed (idempotent), else refuse — never fall through to the apply +
  // stale-write, which could clobber the winner's committed row.
  if ((flip.meta?.changes ?? 0) === 0) {
    const fresh = await loadChangeset(db, cs.projectId, cs.id)
    if (fresh?.status === 'committed') return Response.json({ receipt: fresh.receipt })
    return errorResponse('conflict', 'commit already in progress')
  }
  return { confirmationId }
}
