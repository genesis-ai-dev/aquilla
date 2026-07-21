// POST /api/v1/external/projects/:projectId/changesets/:id/commit
//
// The one commit pipeline for both autonomy modes (AQU-533 §3):
//   staged? → expiry → (ask: consume one-time confirmation | act: proceed)
//   → re-check preconditions (plan_stale on drift) → compile commands into
//   target.cell.commit events → route through the /events perimeter via an
//   internal minted token → stamp provenance → write receipt → committed.
//
// Idempotent: a committed changeset returns its stored receipt without
// re-applying. Ask-mode confirmations are consumed exactly once.

import { errorResponse, toErrorResponse } from './errors'
import {
  cellKey,
  requiredRoleForCommand,
  type CreateProjectCommand,
  type LinkMediaCommand,
  type PlanImportCommand,
  type SetTranslationCommand,
  type UpdateProjectSettingsCommand,
} from './commands'
import { resolveCellStates } from './preconditions'
import { compilePlanImport } from './import-manifest'
import { loadChangeset } from './store'
import { assertCredentialScope, mintInternalSyncToken } from './token-bridge'
import { uuidv7 } from './uuid'
import { audioObjectKey } from '../audio'
import { handleEventsWriteRequest } from '../events/route'
import { ROLE } from '../events/role-policy'
import type { RawEvent } from '../events/types'
import type {
  ChangesetReceipt,
  ChangesetWarning,
  ExternalEnv,
  ReceiptOnlyReceipt,
  StoredChangeset,
} from './types'
import { validateApiCredential, type ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import {
  createProjectShared,
  updateProjectSettingsShared,
} from '../../../db/shared/projects'

/** Provenance channel for the commit request. MCP-originated commits arrive via
 *  a synthetic in-process Request carrying `x-aquilla-channel: mcp`
 *  (mcp-handlers.ts); everything else is a direct REST call. Only these two
 *  values are accepted — an unknown/absent header defaults to 'rest'. */
function readChannel(request: Request): 'mcp' | 'rest' {
  return request.headers.get('x-aquilla-channel') === 'mcp' ? 'mcp' : 'rest'
}

function bearer(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

interface EventsWriteResponse {
  accepted: { id: string }[]
  rejected: { id: string; status: number; reason: string }[]
  stale?: { id: string; fileId: string | null; cellId: string | null }[]
  staleSource?: { id: string; currentSourceEventId: string }[]
}

export async function handleCommit(
  request: Request,
  env: ExternalEnv,
  projectId: string,
  id: string,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  if (!env.AQUILLA_PG) return errorResponse('job_failed', 'AQUILLA_PG not configured')
  const db = env.AQUILLA_PG

  const cred = await validateApiCredential(db, bearer(request) ?? "")
  if (!cred) return errorResponse('permission_denied', 'invalid or missing API credential')

  const cs = await loadChangeset(db, projectId, id)
  if (!cs) return errorResponse('not_found', `changeset ${id} not found`)

  // A changeset is committed by the credential that staged it.
  if (cred.credentialId !== cs.credentialId) {
    return errorResponse('permission_denied', 'credential did not create this changeset')
  }

  // ── Status gate ──────────────────────────────────────────────────────────
  if (cs.status === 'committed') {
    // Idempotent: return the stored receipt, do NOT re-apply.
    return Response.json({ receipt: cs.receipt })
  }
  if (cs.status === 'discarded') {
    return errorResponse('validation_failed', 'changeset was discarded')
  }
  if (cs.status === 'expired') {
    return errorResponse('validation_failed', 'changeset has expired')
  }
  if (cs.status === 'stale') {
    return errorResponse('plan_stale', 'changeset is stale — prepare a new plan')
  }
  // status is 'staged' (first attempt) or 'committing' (crash-retry, W1-B §4)
  // from here.

  // ── W2-A: receipt-only project-lifecycle commands take their own path ──────
  // These apply a plain row write (not events), so the generic per-command
  // project-role precheck below (which resolves a role against cs.projectId)
  // does not fit: CreateProject's target project does not exist yet (its gate is
  // org-level), and UpdateProjectSettings needs the MAINTAINER floor. Each
  // handler runs its own live-role re-check + the shared staged→committing gates.
  const createProjectCmd = cs.commands.find(
    (c): c is CreateProjectCommand => c.kind === 'CreateProject',
  )
  if (createProjectCmd) {
    return commitCreateProject(request, env, db, cred, cs, createProjectCmd)
  }
  const updateSettingsCmd = cs.commands.find(
    (c): c is UpdateProjectSettingsCommand => c.kind === 'UpdateProjectSettings',
  )
  if (updateSettingsCmd) {
    return commitUpdateProjectSettings(request, env, db, cred, cs, updateSettingsCmd)
  }

  // ── Live role/membership precheck (§2) ────────────────────────────────────
  // Resolve the caller's CURRENT role and require the floor of the command kinds
  // being committed. The /events perimeter re-checks per-event roles as the
  // backstop, but resolving here first means a member removed after prepare is
  // denied cleanly (permission_denied) instead of half-applying at the perimeter.
  // Runs for a crash-retry too — a member removed mid-commit is still stopped.
  const requiredRole = Math.max(...cs.commands.map(requiredRoleForCommand))
  const resolvedRole = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!resolvedRole || resolvedRole.level < requiredRole) {
    return errorResponse('permission_denied', 'insufficient project role to commit this changeset')
  }

  // ── First-attempt gates (staged only) ─────────────────────────────────────
  // Expiry, one-time ask-mode approval, and precondition drift are checked ONCE,
  // on the first commit attempt. A crash-retry (status='committing') skips them:
  //   • expiry — the plan is already mid-apply; blocking would strand partially
  //     applied events;
  //   • confirmation — already consumed on the first attempt; re-consuming would
  //     wrongly demand a second approval (the id was persisted at the flip below);
  //   • drift — our OWN partial apply legitimately moved the head, so a re-check
  //     would false-positive; the stored ids + /events idempotency make the
  //     re-apply safe regardless.
  let confirmationId: string | null = cs.confirmationId ?? null
  if (cs.status === 'staged') {
    // Expiry.
    if (new Date(cs.expiresAt).getTime() < Date.now()) {
      await db
        .prepare(`UPDATE changesets SET status = 'expired' WHERE id = ? AND status IN ('staged','committing')`)
        .bind(id)
        .run()
      return errorResponse('validation_failed', 'changeset has expired')
    }

    // Autonomy: ask requires a consumed one-time confirmation.
    if (cs.autonomyMode === 'ask') {
      const consumed = await db
        .prepare(
          `UPDATE changeset_confirmations SET consumed_at = now()
             WHERE changeset_id = ? AND credential_id = ? AND digest = ?
               AND consumed_at IS NULL AND expires_at > now()
           RETURNING id`,
        )
        .bind(id, cs.credentialId, cs.digest)
        .first<{ id: string }>()
      if (!consumed) {
        return errorResponse(
          'confirmation_required',
          'ask-mode changeset requires a valid, unconsumed human approval',
        )
      }
      confirmationId = consumed.id
    }

    // Re-check preconditions against the live projection.
    const liveStates = await resolveCellStates(db, projectId, cs.preconditions)
    const drift: { fileId: string; cellId: string }[] = []
    for (const pre of cs.preconditions) {
      const s = liveStates.get(cellKey(pre.fileId, pre.cellId))
      const liveHead = s?.targetHeadEventId ?? null
      const liveSource = s?.sourceEventId ?? null
      if (liveHead !== pre.targetHeadEventId || liveSource !== pre.sourceEventId) {
        drift.push({ fileId: pre.fileId, cellId: pre.cellId })
      }
    }
    if (drift.length > 0) {
      await db
        .prepare(`UPDATE changesets SET status = 'stale' WHERE id = ? AND status IN ('staged','committing')`)
        .bind(id)
        .run()
      return errorResponse('plan_stale', 'project state changed since prepare', { drift })
    }

    // Flip to 'committing' before applying and persist the consumed confirmation
    // id, so a crash after this point re-enters as a retry (skipping the gates
    // above) and can rebuild provenance without a second approval. Guarded on
    // status='staged' so a concurrent double-commit can't both flip.
    const flip = await db
      .prepare(
        `UPDATE changesets SET status = 'committing', confirmation_id = ?
           WHERE id = ? AND status = 'staged'`,
      )
      .bind(confirmationId, id)
      .run()
    // Inspect the flip: a 0-row result means a CONCURRENT commit of this same
    // changeset already won the staged→committing race. Do NOT proceed to apply
    // (and, critically, do NOT fall through to a stale-write that could clobber
    // the winner's committed receipt). Re-load: if the winner already committed,
    // return its stored receipt (idempotent); otherwise it is still mid-apply —
    // refuse rather than double-apply.
    if ((flip.meta?.changes ?? 0) === 0) {
      const fresh = await loadChangeset(db, projectId, id)
      if (fresh?.status === 'committed') return Response.json({ receipt: fresh.receipt })
      return errorResponse('conflict', 'commit already in progress')
    }
  }

  // ── PlanImport takes its own compile/commit path ──────────────────────────
  const planImport = cs.commands.find(
    (c): c is PlanImportCommand => c.kind === 'PlanImport',
  )
  if (planImport) {
    return commitPlanImport(request, env, db, cred, cs, planImport, confirmationId, ctx)
  }

  // ── LinkMedia takes its own compile/commit path ───────────────────────────
  const linkMedia = cs.commands.filter(
    (c): c is LinkMediaCommand => c.kind === 'LinkMedia',
  )
  if (linkMedia.length > 0) {
    return commitLinkMedia(request, env, db, cred, cs, linkMedia, confirmationId, ctx)
  }

  // ── Compile commands → target.cell.commit events, grouped by file ─────────
  // Past the PlanImport branch every remaining command is a SetTranslation.
  const commandByCell = new Map<string, SetTranslationCommand>()
  for (const c of cs.commands) {
    if (c.kind !== 'SetTranslation') continue
    commandByCell.set(cellKey(c.fileId, c.cellId), c)
  }

  // W1-B: consume the event ids minted at prepare, so a crash-retry re-posts
  // identical ids (deduped by the /events layer). The ledger is a list; rebuild
  // the cellKey lookup in memory (its NUL separator is fine as a Map key, unlike
  // a jsonb object key). Fall back to minting for changesets staged before the
  // planned-id ledger existed (backward compat).
  const plannedSet = new Map(
    (cs.plannedIds?.setTranslation ?? []).map((p) => [cellKey(p.fileId, p.cellId), p.eventId]),
  )
  const eventsByFile = new Map<string, RawEvent<'target.cell.commit'>[]>()
  const allEventIds: string[] = []
  const clientTs = Date.now()
  for (const pre of cs.preconditions) {
    const cmd = commandByCell.get(cellKey(pre.fileId, pre.cellId))
    if (!cmd) continue
    const ev: RawEvent<'target.cell.commit'> = {
      id: plannedSet.get(cellKey(pre.fileId, pre.cellId)) ?? uuidv7(),
      schemaVersion: 1,
      kind: 'target.cell.commit',
      projectId,
      fileId: pre.fileId,
      cellId: pre.cellId,
      parentId: pre.targetHeadEventId,
      author: cred.username,
      payload: {
        value: cmd.value,
        ...(cmd.valueHtml !== undefined ? { valueHtml: cmd.valueHtml } : {}),
        sourceEventId: pre.sourceEventId,
      },
      clientTs,
    }
    allEventIds.push(ev.id)
    const list = eventsByFile.get(pre.fileId)
    if (list) list.push(ev)
    else eventsByFile.set(pre.fileId, [ev])
  }

  // ── Route each file's events through the /events perimeter ────────────────
  const acceptedIds = new Set<string>()
  const rejected: { id: string; status: number; reason: string }[] = []
  const staleFromPerimeter: string[] = []
  const staleSource: string[] = []

  for (const [fileId, events] of eventsByFile) {
    let token: string
    try {
      token = await mintInternalSyncToken(env, db, cred, projectId, fileId)
    } catch (err) {
      return toErrorResponse(err)
    }
    const req = new Request('https://internal/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    })
    const res = await handleEventsWriteRequest(req, env, ctx)
    if (!res) return errorResponse('job_failed', 'events perimeter did not respond')
    const out = (await res.json()) as EventsWriteResponse
    for (const a of out.accepted) acceptedIds.add(a.id)
    for (const r of out.rejected) rejected.push(r)
    for (const s of out.stale ?? []) staleFromPerimeter.push(s.id)
    for (const s of out.staleSource ?? []) staleSource.push(s.id)
  }

  // If nothing applied but the perimeter rejected events, surface the reason.
  if (acceptedIds.size === 0 && rejected.length > 0) {
    const anyForbidden = rejected.some((r) => r.status === 403)
    return errorResponse(
      anyForbidden ? 'permission_denied' : 'job_failed',
      'no events were applied',
      { rejected },
    )
  }

  // ── Stamp the server-verified provenance envelope on applied events ───────
  let agentMeta: unknown = null
  const agentHeader = request.headers.get('x-agent-meta')
  if (agentHeader) {
    try {
      agentMeta = JSON.parse(agentHeader)
    } catch {
      agentMeta = null // invalid caller metadata is recorded as absent, not fatal.
    }
  }
  const provenance = {
    origin: 'agent',
    human_authority: { user_id: cs.createdByUserId, credential_id: cs.credentialId },
    agent: agentMeta,
    channel: readChannel(request),
    autonomy_mode: cs.autonomyMode,
    changeset_id: cs.id,
    ...(confirmationId ? { confirmation_id: confirmationId } : {}),
  }
  const appliedIds = allEventIds.filter((eid) => acceptedIds.has(eid))
  if (appliedIds.length > 0) {
    const placeholders = appliedIds.map(() => '?').join(', ')
    await db
      .prepare(`UPDATE events SET provenance = ?::text::jsonb WHERE id IN (${placeholders})`)
      .bind(JSON.stringify(provenance), ...appliedIds)
      .run()
  }

  // ── Receipt ───────────────────────────────────────────────────────────────
  const warnings: ChangesetWarning[] = [...cs.summary.warnings]
  for (const r of rejected) {
    warnings.push({ code: 'rejected', fileId: '', cellId: '', message: `${r.id}: ${r.reason}` })
  }
  for (const eid of [...staleFromPerimeter, ...staleSource]) {
    warnings.push({ code: 'stale_pin', fileId: '', cellId: '', message: `event ${eid} landed stale` })
  }

  const committedAt = new Date().toISOString()
  const receipt: ChangesetReceipt = {
    eventIds: appliedIds,
    appliedCount: appliedIds.length,
    staleCount: staleFromPerimeter.length + staleSource.length,
    warnings,
    committedAt,
  }

  await db
    .prepare(
      `UPDATE changesets
          SET status = 'committed', receipt = ?::text::jsonb, confirmation_id = ?, committed_at = now()
        WHERE id = ?`,
    )
    .bind(JSON.stringify(receipt), confirmationId, id)
    .run()

  return Response.json({ receipt })
}

/** Parse the caller-declared agent metadata header (recorded, never verified). */
function readAgentMeta(request: Request): unknown {
  const header = request.headers.get('x-agent-meta')
  if (!header) return null
  try {
    return JSON.parse(header)
  } catch {
    return null
  }
}

/** Build the server-verified provenance envelope (§2). */
function buildProvenance(
  request: Request,
  cs: StoredChangeset,
  confirmationId: string | null,
): Record<string, unknown> {
  return {
    origin: 'agent',
    human_authority: { user_id: cs.createdByUserId, credential_id: cs.credentialId },
    agent: readAgentMeta(request),
    channel: readChannel(request),
    autonomy_mode: cs.autonomyMode,
    changeset_id: cs.id,
    ...(confirmationId ? { confirmation_id: confirmationId } : {}),
  }
}

/** Statements per POST to the /events perimeter — mirrors the perimeter's own
 *  BATCH_LIMIT (100). A PlanImport can seed thousands of source cells, so the
 *  compiled events are chunked. The new file remains soft-hidden until every
 *  chunk and artifact binding succeeds; an interrupted apply is retryable and
 *  never exposes a silently truncated file. */
const PLAN_IMPORT_CHUNK = 100

/**
 * Compile a PlanImport into one file.create + N genesis source.cell.create
 * events (chained by anchorCellId, mirroring the SPA import + bulk /import
 * semantics), route them through the SAME /events perimeter Wave 1 uses (source.*
 * requires PROJECT_LEAD (500) — a contributor credential is 403'd there), keep
 * the file soft-hidden while its chunks are being applied, and stamp
 * provenance on applied events, link the artifact, and write the receipt.
 */
async function commitPlanImport(
  request: Request,
  env: ExternalEnv,
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: PlanImportCommand,
  confirmationId: string | null,
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
): Promise<Response> {
  const projectId = cs.projectId
  const clientTs = Date.now()

  // W1-B (§4): consume the file id, file.create event id, and per-cell ids
  // minted at prepare. A crash-retry re-posts these IDENTICAL ids, so the
  // /events idempotency layer (INSERT OR IGNORE on event id) dedupes them — no
  // duplicate file, no duplicate source cells. Fall back to minting for
  // changesets staged before the planned-id ledger existed (backward compat).
  const plannedImport = cs.plannedIds?.planImport
  const fileId = plannedImport?.fileId ?? uuidv7()
  const compiled = compilePlanImport(cmd)

  const fileEvent: RawEvent<'file.create'> = {
    id: plannedImport?.fileEventId ?? uuidv7(),
    schemaVersion: 1,
    kind: 'file.create',
    projectId,
    fileId,
    parentId: null,
    author: cred.username,
    payload: {
      name: cmd.fileName,
      fileType: cmd.fileType,
      kind: cmd.fileType.toLowerCase() === 'tmx' ? 'translation-memory' : cmd.fileType,
      ...(cmd.sourceLanguage !== undefined ? { sourceLanguage: cmd.sourceLanguage } : {}),
      ...(cmd.targetLanguage !== undefined ? { targetLanguage: cmd.targetLanguage } : {}),
      importManifest: compiled.fileSummary,
    },
    clientTs,
  }

  // A staged import is soft-hidden from ordinary file listings until every
  // chunk and artifact binding succeeds. These ids are minted at prepare, so
  // a worker-eviction retry repeats the same state transitions idempotently.
  const hideEvent: RawEvent<'file.delete'> = {
    id: plannedImport?.hideEventId ?? `${fileEvent.id}:import-hide`,
    schemaVersion: 1,
    kind: 'file.delete',
    projectId,
    fileId,
    parentId: null,
    author: cred.username,
    payload: {},
    clientTs,
  }
  const revealEvent: RawEvent<'file.restore'> = {
    id: plannedImport?.revealEventId ?? `${fileEvent.id}:import-reveal`,
    schemaVersion: 1,
    kind: 'file.restore',
    projectId,
    fileId,
    parentId: null,
    author: cred.username,
    payload: {},
    clientTs,
  }

  // Genesis source cells, chained via anchorCellId (null for the first cell).
  const cellEvents: RawEvent<'source.cell.create'>[] = []
  let prevCellId: string | null = null
  compiled.units.forEach((unit, i) => {
    const cell = unit.cell
    const planned = plannedImport?.cells[i]
    const cellId = planned?.cellId ?? cell.id ?? uuidv7()
    cellEvents.push({
      id: planned?.eventId ?? uuidv7(),
      schemaVersion: 1,
      kind: 'source.cell.create',
      projectId,
      fileId,
      cellId,
      parentId: null,
      author: cred.username,
      payload: {
        cellId,
        anchorCellId: prevCellId,
        value: cell.content,
        ...(cell.contentHtml !== undefined ? { valueHtml: cell.contentHtml } : {}),
        ...(unit.canonicalRef !== undefined ? { canonicalRef: unit.canonicalRef } : {}),
        type: unit.type,
        sequenceIndex: unit.sequenceIndex,
        ...(unit.startMs !== undefined ? { startMs: unit.startMs } : {}),
        ...(unit.endMs !== undefined ? { endMs: unit.endMs } : {}),
        metadata: unit.metadata,
      },
      clientTs,
    })
    prevCellId = cellId
  })

  // Explicit target variants reuse the same source unit and name their lane.
  // The source event id is both the first target-chain parent and the staleness
  // pin, matching browser bilingual imports.
  const targetEvents: RawEvent<'target.cell.commit'>[] = []
  compiled.units.forEach((unit, cellIndex) => {
    const sourceEvent = cellEvents[cellIndex]
    const planned = plannedImport?.cells[cellIndex]
    for (const [variantIndex, variant] of (unit.cell.variants ?? []).entries()) {
      targetEvents.push({
        id: planned?.variantEventIds?.[variantIndex] ?? uuidv7(),
        schemaVersion: 1,
        kind: 'target.cell.commit',
        projectId,
        fileId,
        cellId: sourceEvent.cellId,
        parentId: sourceEvent.id,
        author: cred.username,
        payload: {
          value: variant.content,
          ...(variant.contentHtml !== undefined ? { valueHtml: variant.contentHtml } : {}),
          sourceEventId: sourceEvent.id,
          ...(variant.laneId ? { targetLang: variant.laneId } : {}),
        },
        clientTs,
      })
    }
  })

  // file.create + file.delete land in the first chunk. file.restore is sent
  // separately only after all content and provenance bindings succeed.
  const stagedEvents: RawEvent[] = [fileEvent, hideEvent, ...cellEvents, ...targetEvents]
  const allEvents: RawEvent[] = [...stagedEvents, revealEvent]
  const allEventIds = allEvents.map((e) => e.id)

  let token: string
  try {
    token = await mintInternalSyncToken(env, db, cred, projectId, fileId)
  } catch (err) {
    return toErrorResponse(err)
  }

  const acceptedIds = new Set<string>()
  const rejected: { id: string; status: number; reason: string }[] = []
  for (let i = 0; i < stagedEvents.length; i += PLAN_IMPORT_CHUNK) {
    const chunk = stagedEvents.slice(i, i + PLAN_IMPORT_CHUNK)
    const req = new Request('https://internal/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: chunk }),
    })
    const res = await handleEventsWriteRequest(req, env, ctx)
    if (!res) return errorResponse('job_failed', 'events perimeter did not respond')
    const out = (await res.json()) as EventsWriteResponse
    for (const a of out.accepted) acceptedIds.add(a.id)
    for (const r of out.rejected) rejected.push(r)

    // Defence in depth: if file.create projected but file.delete unexpectedly
    // rejected, keep the incomplete file out of normal listings. A successful
    // reveal event below is the sole transition back to deleted_at = NULL.
    if (i === 0 && acceptedIds.has(fileEvent.id)) {
      await db
        .prepare(`UPDATE files SET deleted_at = COALESCE(deleted_at, -1) WHERE id = ? AND project_id = ?`)
        .bind(fileId, projectId)
        .run()
    }
  }

  // Nothing applied but events were rejected — surface the reason (a contributor
  // credential is 403'd by the perimeter since source.* needs PROJECT_LEAD 500).
  if (acceptedIds.size === 0 && rejected.length > 0) {
    const anyForbidden = rejected.some((r) => r.status === 403)
    return errorResponse(
      anyForbidden ? 'permission_denied' : 'job_failed',
      'no events were applied',
      { rejected },
    )
  }

  // Link the uploaded artifact while the file is still hidden. A binding
  // failure therefore cannot publish a file whose provenance is incomplete.
  const fileApplied = acceptedIds.has(fileEvent.id)
  if (rejected.length === 0 && cmd.artifactId && fileApplied) {
    await db
      .prepare(`UPDATE artifacts SET file_id = ? WHERE id::text = ? AND project_id = ?`)
      .bind(fileId, cmd.artifactId, projectId)
      .run()
    await db
      .prepare(
        `INSERT INTO artifact_bindings (
           id, project_id, artifact_id, file_id, binding_role, target_lang,
           member_path, profile_id, profile_version, fidelity, manifest, recipe
         ) VALUES (?, ?, ?::uuid, ?, 'source', '', ?, ?, ?, ?, ?::text::jsonb, ?::text::jsonb)
         ON CONFLICT (artifact_id, file_id, binding_role, target_lang, member_path)
         DO UPDATE SET
           profile_id = excluded.profile_id,
           profile_version = excluded.profile_version,
           fidelity = excluded.fidelity,
           manifest = excluded.manifest,
           recipe = excluded.recipe,
           updated_at = now()`,
      )
      .bind(
        plannedImport?.artifactBindingId ?? uuidv7(),
        projectId,
        cmd.artifactId,
        fileId,
        cmd.manifest?.memberPath ?? '',
        cmd.manifest?.profileId ?? `agent:${cmd.fileType.toLowerCase()}`,
        cmd.manifest?.profileVersion ?? '1',
        cmd.manifest?.fidelity ?? compiled.fileSummary.fidelity,
        JSON.stringify(compiled.fileSummary),
        cmd.manifest?.recipe ? JSON.stringify(cmd.manifest.recipe) : null,
      )
      .run()
  }

  // Reveal only after every staged event and optional binding succeeded.
  if (rejected.length === 0) {
    const revealRequest = new Request('https://internal/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [revealEvent] }),
    })
    const revealResponse = await handleEventsWriteRequest(revealRequest, env, ctx)
    if (!revealResponse) return errorResponse('job_failed', 'events perimeter did not respond')
    const revealResult = (await revealResponse.json()) as EventsWriteResponse
    for (const accepted of revealResult.accepted) acceptedIds.add(accepted.id)
    for (const rejectedEvent of revealResult.rejected) rejected.push(rejectedEvent)
  }

  // Stamp server-verified provenance on everything that did land, including a
  // partial hidden import. This keeps crash investigation fully auditable.
  const provenance = buildProvenance(request, cs, confirmationId)
  const appliedIds = allEventIds.filter((eventId) => acceptedIds.has(eventId))
  if (appliedIds.length > 0) {
    const placeholders = appliedIds.map(() => '?').join(', ')
    await db
      .prepare(`UPDATE events SET provenance = ?::text::jsonb WHERE id IN (${placeholders})`)
      .bind(JSON.stringify(provenance), ...appliedIds)
      .run()
  }

  const warnings: ChangesetWarning[] = [...cs.summary.warnings]
  for (const r of rejected) {
    warnings.push({ code: 'rejected', fileId: '', cellId: '', message: `${r.id}: ${r.reason}` })
  }

  const receipt: ChangesetReceipt = {
    eventIds: appliedIds,
    appliedCount: appliedIds.length,
    staleCount: 0,
    warnings,
    committedAt: new Date().toISOString(),
    fileId,
  }

  // Only expose a terminal committed receipt after every event is accepted.
  // On a partial result the row stays `committing`; a retry re-posts the same
  // prepare-time ids and converges through event idempotency.
  if (rejected.length > 0) {
    await db
      .prepare(`UPDATE changesets SET receipt = ?::text::jsonb WHERE id = ? AND status = 'committing'`)
      .bind(JSON.stringify(receipt), cs.id)
      .run()
    return errorResponse('job_failed', 'import partially failed — retry will resume the same import', {
      receipt,
    })
  }

  await db
    .prepare(
      `UPDATE changesets
          SET status = 'committed', receipt = ?::text::jsonb, confirmation_id = ?, committed_at = now()
        WHERE id = ?`,
    )
    .bind(JSON.stringify(receipt), confirmationId, cs.id)
    .run()

  return Response.json({ receipt })
}

// ── W2-A: receipt-only project-lifecycle commits (spec §2, D8) ────────────────

/** Live org-member role level for (orgId, userId), or null. Mirrors
 *  prepare.ts's resolveOrgRoleLevel — the receipt-only CreateProject commit
 *  re-resolves org membership directly (no project row to hang a project role
 *  off), the live-role re-check pattern the event commits use. */
async function commitOrgRoleLevel(
  db: AquillaDb,
  orgId: number,
  userId: string,
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?`)
    .bind(orgId, userId)
    .first<{ role_level: number }>()
  return row?.role_level ?? null
}

/**
 * Shared staged→committing gate sequence for receipt-only commits. There are no
 * per-cell preconditions, so no drift re-check — the CreateProject id-collision
 * / UpdateProjectSettings version guard is enforced by the apply step itself.
 * On the first attempt (status==='staged') this checks expiry, consumes the
 * one-time ask-mode confirmation, and flips to 'committing'; a crash-retry
 * (status==='committing') re-uses the persisted confirmation id and skips the
 * gates (matching the SetTranslation / PlanImport path). Returns the (possibly
 * consumed) confirmation id, or an error Response to short-circuit.
 */
async function receiptOnlyGates(
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

/**
 * Commit a CreateProject (spec §2, receipt-only). Re-checks scope + org role
 * live, runs the shared gates, then applies the row write via
 * createProjectShared with writeCreatorMembership: true (the receipt-only apply
 * has no implicit creator-path resolver, so the owner-level 700 membership row
 * must be written explicitly). An id claimed by ANOTHER caller between prepare
 * and commit → `conflict`; the caller's OWN prior attempt (a crash-retry that
 * already inserted) is absorbed idempotently.
 */
async function commitCreateProject(
  request: Request,
  _env: ExternalEnv,
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: CreateProjectCommand,
): Promise<Response> {
  const wasStaged = cs.status === 'staged'
  const planned = cs.plannedIds?.createProject
  const projectId = planned?.projectId ?? cmd.projectId ?? cs.projectId
  const orgId =
    planned?.orgId ?? (cmd.orgId != null ? Number(cmd.orgId) : null)

  // Live scope + org-role re-check (D8 live-role pattern).
  if (cred.projectId != null) {
    return errorResponse('scope_denied', 'a project-scoped credential cannot create projects')
  }
  const targetOrgStr = orgId == null ? null : String(orgId)
  if (cred.orgId != null && cred.orgId !== targetOrgStr) {
    return errorResponse('scope_denied', 'credential org scope does not match the target org')
  }
  if (orgId != null) {
    const level = await commitOrgRoleLevel(db, orgId, cred.userId)
    if (level == null || level < ROLE.MAINTAINER) {
      return errorResponse('permission_denied', 'org role >= maintainer required to create a project')
    }
  }

  const gate = await receiptOnlyGates(db, cs)
  if (gate instanceof Response) return gate
  const confirmationId = gate.confirmationId

  // Apply — MANDATORY writeCreatorMembership: true (see JSDoc above).
  const { inserted } = await createProjectShared(db, {
    projectId,
    name: cmd.name,
    orgId,
    createdBy: cred.userId,
    writeCreatorMembership: true,
  })

  if (!inserted) {
    // The id already exists. Distinguish a genuine race (someone else claimed it
    // between prepare and commit → conflict) from this credential owner's own
    // prior crash-retry attempt (idempotent success). A first attempt that finds
    // the row taken is always a race; a retry that finds its own row is not.
    const existing = await db
      .prepare(`SELECT created_by FROM projects WHERE id = ?`)
      .bind(projectId)
      .first<{ created_by: number | string }>()
    const mineByRetry =
      !wasStaged && existing != null && String(existing.created_by) === String(cred.userId)
    if (!mineByRetry) {
      // Non-retryable: move off 'committing' so a later retry can't misread it as
      // its own prior attempt and falsely claim success.
      await db
        .prepare(`UPDATE changesets SET status = 'stale' WHERE id = ? AND status IN ('staged','committing')`)
        .bind(cs.id)
        .run()
      return errorResponse('conflict', `project ${projectId} was created by another caller since prepare`)
    }
  }

  const receipt: ReceiptOnlyReceipt = {
    credentialId: cred.credentialId,
    channel: readChannel(request),
    changesetId: cs.id,
    command: 'CreateProject',
    appliedAt: new Date().toISOString(),
    projectId,
  }
  await db
    .prepare(
      `UPDATE changesets
          SET status = 'committed', receipt = ?::text::jsonb, confirmation_id = ?, committed_at = now()
        WHERE id = ?`,
    )
    .bind(JSON.stringify(receipt), confirmationId, cs.id)
    .run()

  return Response.json({ receipt })
}

/**
 * Compile a LinkMedia changeset into cell.audio.attach + cell.audio.select
 * events (Agent API v1.1 §3), routed through the SAME /events perimeter as
 * SetTranslation (cell.audio.* requires CONTRIBUTOR — an observer credential is
 * 403'd there), then stamp provenance and write the receipt.
 *
 * The uploaded audio bytes were stored (at artifact upload) in the audio R2
 * layout keyed by the artifactId; here we copy them under the TARGET cell's
 * file, because the app's native /audio playback route derives the fetch key
 * from the cell's file. The attach/select event ids are the prepare-time ids
 * (§4), so a crash-retry (status='committing') re-posts identical ids the
 * /events idempotency layer dedupes — no double-attach — and re-copies the
 * same bytes to the same key (idempotent).
 */
async function commitLinkMedia(
  request: Request,
  env: ExternalEnv,
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmds: LinkMediaCommand[],
  confirmationId: string | null,
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
): Promise<Response> {
  if (!env.SNAPSHOTS) return errorResponse('job_failed', 'SNAPSHOTS bucket not configured')
  const projectId = cs.projectId
  const clientTs = Date.now()

  // Prepare-time attach/select ids (§4), keyed by (fileId, cellId, artifactId).
  // Fall back to minting for changesets staged before the linkMedia ledger.
  const plannedByKey = new Map(
    (cs.plannedIds?.linkMedia ?? []).map((p) => [
      `${cellKey(p.fileId, p.cellId)}\u0000${p.artifactId}`,
      p,
    ]),
  )

  const eventsByFile = new Map<string, RawEvent[]>()
  const allEventIds: string[] = []

  for (const cmd of cmds) {
    // Re-check the artifact: still present, still audio, same project.
    const artifact = await db
      .prepare(
        `SELECT id, kind, r2_key, audio_id, content_type
           FROM artifacts WHERE id::text = ? AND project_id = ?`,
      )
      .bind(cmd.artifactId, projectId)
      .first<{ id: string; kind: string; r2_key: string; audio_id: string | null; content_type: string | null }>()
    if (!artifact || artifact.kind !== 'audio' || !artifact.audio_id) {
      await db
        .prepare(`UPDATE changesets SET status = 'stale' WHERE id = ? AND status IN ('staged','committing')`)
        .bind(cs.id)
        .run()
      return errorResponse(
        'plan_stale',
        `artifact ${cmd.artifactId} is no longer an audio artifact in this project`,
      )
    }

    // Re-check the target cell still exists.
    const cellStates = await resolveCellStates(db, projectId, [cmd])
    const s = cellStates.get(cellKey(cmd.fileId, cmd.cellId))
    if (!s || (!s.sourceExists && !s.targetExists)) {
      await db
        .prepare(`UPDATE changesets SET status = 'stale' WHERE id = ? AND status IN ('staged','committing')`)
        .bind(cs.id)
        .run()
      return errorResponse(
        'plan_stale',
        `cell ${cmd.cellId} in file ${cmd.fileId} no longer exists`,
      )
    }

    // Copy the uploaded bytes under the target cell's file so the app's native
    // /audio route (keyed by the cell's file) serves them. Idempotent on retry.
    const src = await env.SNAPSHOTS.get(artifact.r2_key)
    if (!src) {
      await db
        .prepare(`UPDATE changesets SET status = 'stale' WHERE id = ? AND status IN ('staged','committing')`)
        .bind(cs.id)
        .run()
      return errorResponse('plan_stale', `artifact ${cmd.artifactId} bytes missing from storage`)
    }
    const destKey = audioObjectKey(env, projectId, cmd.fileId, artifact.audio_id)
    await env.SNAPSHOTS.put(destKey, await src.arrayBuffer(), {
      httpMetadata: artifact.content_type ? { contentType: artifact.content_type } : undefined,
    })

    const planned = plannedByKey.get(`${cellKey(cmd.fileId, cmd.cellId)}\u0000${cmd.artifactId}`)
    const attachId = planned?.attachEventId ?? uuidv7()
    const selectId = planned?.selectEventId ?? uuidv7()
    const url = `frontier-audio://${artifact.audio_id}`

    const attachEvent: RawEvent<'cell.audio.attach'> = {
      id: attachId,
      schemaVersion: 1,
      kind: 'cell.audio.attach',
      projectId,
      fileId: cmd.fileId,
      cellId: cmd.cellId,
      parentId: null,
      author: cred.username,
      payload: {
        audioId: artifact.audio_id,
        url,
        slot: 'recording',
        ...(artifact.content_type ? { mimeType: artifact.content_type } : {}),
      },
      clientTs,
    }
    const selectEvent: RawEvent<'cell.audio.select'> = {
      id: selectId,
      schemaVersion: 1,
      kind: 'cell.audio.select',
      projectId,
      fileId: cmd.fileId,
      cellId: cmd.cellId,
      parentId: null,
      author: cred.username,
      payload: { audioId: artifact.audio_id, slot: 'recording' },
      clientTs,
    }
    // attach must precede select in the batch so the projection sees the row
    // before the select re-affirms it.
    allEventIds.push(attachId, selectId)
    const list = eventsByFile.get(cmd.fileId)
    if (list) list.push(attachEvent, selectEvent)
    else eventsByFile.set(cmd.fileId, [attachEvent, selectEvent])
  }

  // Route each file's events through the /events perimeter.
  const acceptedIds = new Set<string>()
  const rejected: { id: string; status: number; reason: string }[] = []
  for (const [fileId, events] of eventsByFile) {
    let token: string
    try {
      token = await mintInternalSyncToken(env, db, cred, projectId, fileId)
    } catch (err) {
      return toErrorResponse(err)
    }
    const req = new Request('https://internal/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    })
    const res = await handleEventsWriteRequest(req, env, ctx)
    if (!res) return errorResponse('job_failed', 'events perimeter did not respond')
    const out = (await res.json()) as EventsWriteResponse
    for (const a of out.accepted) acceptedIds.add(a.id)
    for (const r of out.rejected) rejected.push(r)
  }

  // Nothing applied but events were rejected — surface the reason (an observer
  // credential is 403'd by the perimeter since cell.audio.* needs CONTRIBUTOR).
  if (acceptedIds.size === 0 && rejected.length > 0) {
    const anyForbidden = rejected.some((r) => r.status === 403)
    return errorResponse(
      anyForbidden ? 'permission_denied' : 'job_failed',
      'no events were applied',
      { rejected },
    )
  }

  // Stamp the server-verified provenance envelope on applied events.
  const provenance = buildProvenance(request, cs, confirmationId)
  const appliedIds = allEventIds.filter((eid) => acceptedIds.has(eid))
  if (appliedIds.length > 0) {
    const placeholders = appliedIds.map(() => '?').join(', ')
    await db
      .prepare(`UPDATE events SET provenance = ?::text::jsonb WHERE id IN (${placeholders})`)
      .bind(JSON.stringify(provenance), ...appliedIds)
      .run()
  }

  const warnings: ChangesetWarning[] = [...cs.summary.warnings]
  for (const r of rejected) {
    warnings.push({ code: 'rejected', fileId: '', cellId: '', message: `${r.id}: ${r.reason}` })
  }

  const receipt: ChangesetReceipt = {
    eventIds: appliedIds,
    appliedCount: appliedIds.length,
    staleCount: 0,
    warnings,
    committedAt: new Date().toISOString(),
  }

  await db
    .prepare(
      `UPDATE changesets
          SET status = 'committed', receipt = ?::text::jsonb, confirmation_id = ?, committed_at = now()
        WHERE id = ?`,
    )
    .bind(JSON.stringify(receipt), confirmationId, cs.id)
    .run()

  if (rejected.length > 0) {
    return errorResponse('job_failed', 'link-media partially failed — some events were rejected', {
      receipt,
    })
  }

  return Response.json({ receipt })
}

/**
 * Commit an UpdateProjectSettings (spec §2, receipt-only). Re-checks the project
 * role live (>= MAINTAINER), runs the shared gates, then applies the
 * version-guarded write via updateProjectSettingsShared — a conflict (the live
 * version drifted from the pinned `ifMatchVersion`) maps to plan_stale. When the
 * validation threshold changed, the shared module's re-projection statements run
 * locally here (sync-worker owns the projection).
 */
async function commitUpdateProjectSettings(
  request: Request,
  _env: ExternalEnv,
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: UpdateProjectSettingsCommand,
): Promise<Response> {
  const wasStaged = cs.status === 'staged'
  const projectId = cs.projectId

  // H1: re-assert the credential's scope ceiling at commit, matching the event
  // path (which re-checks via mintInternalSyncToken → assertCredentialScope).
  // The receipt-only path mints no internal token, so without this a credential
  // whose scope stopped covering the project between prepare and commit would
  // still apply the write. (The same-credential rule — cred.credentialId ===
  // cs.credentialId — is enforced once for every path at the top of handleCommit.)
  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    return toErrorResponse(err)
  }

  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!role || role.level < ROLE.MAINTAINER) {
    return errorResponse('permission_denied', 'project role >= maintainer required to update settings')
  }

  const gate = await receiptOnlyGates(db, cs)
  if (gate instanceof Response) return gate
  const confirmationId = gate.confirmationId

  const expectedVersion = cs.plannedIds?.updateProjectSettings?.version ?? cmd.ifMatchVersion
  const result = await updateProjectSettingsShared(db, {
    projectId,
    settings: cmd.settings,
    ifMatchVersion: expectedVersion,
    updatedBy: cred.userId,
  })

  if (result.status === 'conflict') {
    // A crash-retry whose OWN first attempt already applied the bump lands here:
    // the version-guarded UPDATE now misses because the live version is already
    // expected+1. But a CONCURRENT maintainer writing during the crash window
    // ALSO leaves the live version at expected+1 — treating that as our own apply
    // would silently drop the agent's settings and hand back a false-success
    // receipt. Disambiguate by author, mirroring commitCreateProject's created_by
    // check: absorb it as idempotent success ONLY when the stored updated_by is
    // this credential's user; otherwise it is a genuine concurrent write → stale.
    //
    // Residual ambiguity: if the SAME human wrote these settings via the web UI
    // inside the crash window, updated_by matches and we absorb it as success. We
    // accept that — it is the same human authority, and the version guard bounds
    // the agent's effect to a single bump either way.
    const bumpedByThisUser =
      result.current.version === expectedVersion + 1 &&
      result.current.updatedBy != null &&
      String(result.current.updatedBy) === String(cred.userId)
    if (!wasStaged && bumpedByThisUser) {
      return finishUpdateSettingsReceipt(request, db, cred, cs, projectId, result.current.version, confirmationId)
    }
    await db
      .prepare(`UPDATE changesets SET status = 'stale' WHERE id = ? AND status IN ('staged','committing')`)
      .bind(cs.id)
      .run()
    return errorResponse('plan_stale', 'settings version changed since prepare', {
      expected: expectedVersion,
      current: result.current.version,
    })
  }
  if (result.status === 'error') {
    return errorResponse('job_failed', result.message)
  }

  return finishUpdateSettingsReceipt(request, db, cred, cs, projectId, result.settings.version, confirmationId)
}

/** Write the committed receipt for an UpdateProjectSettings commit. */
async function finishUpdateSettingsReceipt(
  request: Request,
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  projectId: string,
  version: number,
  confirmationId: string | null,
): Promise<Response> {
  const receipt: ReceiptOnlyReceipt = {
    credentialId: cred.credentialId,
    channel: readChannel(request),
    changesetId: cs.id,
    command: 'UpdateProjectSettings',
    appliedAt: new Date().toISOString(),
    projectId,
    version,
  }
  await db
    .prepare(
      `UPDATE changesets
          SET status = 'committed', receipt = ?::text::jsonb, confirmation_id = ?, committed_at = now()
        WHERE id = ?`,
    )
    .bind(JSON.stringify(receipt), confirmationId, cs.id)
    .run()

  return Response.json({ receipt })
}
