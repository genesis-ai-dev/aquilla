// EmitEvents prepare/commit engine (AQU-926, command registry §2).
//
// Prepare resolves live state — head pins for the head-referencing kinds
// (validate/unvalidate/backtranslation/repin, stored as standard
// CellPreconditions so the shared commit drift gate re-checks them), existence
// for everything the plan touches (cells, comments, files, assignments) — and
// stages a normalized plan with prepare-time event ids. Commit re-checks
// existence (first attempt only — a crash-retry re-posts the SAME ids and the
// /events idempotency layer absorbs them), compiles RawEvents with the pinned
// values, and routes them through the /events perimeter exactly like
// SetTranslation (the perimeter re-authorizes roles, membership, and scopes).

import { errorResponse, toErrorResponse } from './errors'
import {
  TERM_EMIT_KINDS,
  TESTIMONY_EMIT_KINDS,
  emitKindEffectLabel,
  type EmitEventInput,
  type EmitEventsCommand,
} from './commands-emit-events'
import { isBindingTermWrite, resolveTermbaseFloor } from '../events/termbase-authority'
import { laneCellKey } from './commands'
import { resolveCellStates, type CellPrecondition } from './preconditions'
import {
  buildProvenance,
  markChangesetStale,
  stampProvenance,
  writeCommittedReceipt,
  type EventsWriteResponse,
} from './commit-gates'
import { stageAndRespond } from './stage'
import { mintInternalSyncToken } from './token-bridge'
import { uuidv7 } from './uuid'
import { PROJECT_SENTINEL_FILE_ID as PROJECT_SENTINEL } from '../events/authorize'
import { handleEventsWriteRequest } from '../events/route'
import { ROLE, requiredRoleForForeignComment, roleLabel } from '../events/role-policy'
import { resolveCommentFloors } from '../events/comment-floors'
import type { CommentScope, EventKind, RawEvent } from '../events/types'
import type {
  ChangesetReceipt,
  ChangesetSummary,
  ChangesetWarning,
  EmitEventsSummaryEntry,
  ExternalEnv,
  PlannedEventIds,
  ProvenanceChannel,
  StoredChangeset,
  TestimonySummaryEntry,
} from './types'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'

/** Kinds whose payload pins the live target head (and source, for repin). */
const PIN_KINDS = new Set([
  'cell.validate',
  'cell.unvalidate',
  'cell.backtranslation.set',
  'target.cell.repin',
])

/** Statements per POST to the /events perimeter (mirrors PLAN_IMPORT_CHUNK). */
const EMIT_CHUNK = 100

/** Per-cell text budget in the testimony summary (AQU-1184). Long enough to
 *  recognise the sentence being endorsed, short enough that a 200-event batch
 *  stays a reasonable summary JSONB. */
const TESTIMONY_TEXT_MAX = 300

interface CommentRow {
  comment_id: string
  author_id: string
  file_id: string | null
  cell_id: string | null
  scope_kind: string
  parent_comment_id: string | null
  deleted_at: number | null
}

interface FileRow {
  id: string
  deleted_at: number | null
}

interface ConceptRow {
  concept_id: string
  status: string
  deleted_at: number | null
}

/** Batch-load referenced comments, keyed by comment_id. */
async function loadComments(
  db: AquillaDb,
  projectId: string,
  ids: readonly string[],
): Promise<Map<string, CommentRow>> {
  const map = new Map<string, CommentRow>()
  if (ids.length === 0) return map
  const placeholders = ids.map(() => '?').join(', ')
  const { results } = await db
    .prepare(
      `SELECT comment_id, author_id, file_id, cell_id, scope_kind, parent_comment_id, deleted_at
         FROM comments WHERE project_id = ? AND comment_id IN (${placeholders})`,
    )
    .bind(projectId, ...ids)
    .all<CommentRow>()
  for (const row of results) map.set(row.comment_id, row)
  return map
}

/** Batch-load referenced files, keyed by id. */
async function loadFiles(
  db: AquillaDb,
  projectId: string,
  ids: readonly string[],
): Promise<Map<string, FileRow>> {
  const map = new Map<string, FileRow>()
  if (ids.length === 0) return map
  const placeholders = ids.map(() => '?').join(', ')
  const { results } = await db
    .prepare(`SELECT id, deleted_at FROM files WHERE project_id = ? AND id IN (${placeholders})`)
    .bind(projectId, ...ids)
    .all<FileRow>()
  for (const row of results) map.set(row.id, row)
  return map
}

/** Batch-load referenced terminology concepts, keyed by concept_id. */
async function loadConcepts(
  db: AquillaDb,
  projectId: string,
  ids: readonly string[],
): Promise<Map<string, ConceptRow>> {
  const map = new Map<string, ConceptRow>()
  if (ids.length === 0) return map
  const placeholders = ids.map(() => '?').join(', ')
  const { results } = await db
    .prepare(
      `SELECT concept_id, status, deleted_at
         FROM concepts WHERE project_id = ? AND concept_id IN (${placeholders})`,
    )
    .bind(projectId, ...ids)
    .all<ConceptRow>()
  for (const row of results) map.set(row.concept_id, row)
  return map
}

/** Batch-load referenced assignments (existence only), keyed by assignment_id. */
async function loadAssignments(
  db: AquillaDb,
  projectId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const set = new Set<string>()
  if (ids.length === 0) return set
  const placeholders = ids.map(() => '?').join(', ')
  const { results } = await db
    .prepare(
      `SELECT assignment_id FROM assignments WHERE project_id = ? AND assignment_id IN (${placeholders})`,
    )
    .bind(projectId, ...ids)
    .all<{ assignment_id: string }>()
  for (const row of results) set.add(row.assignment_id)
  return set
}

/** Collect every reference class the batch touches, in one pass. */
function collectRefs(events: readonly EmitEventInput[]) {
  const cellRefs: { fileId: string; cellId: string; laneId?: string }[] = []
  const fileIds = new Set<string>()
  const commentIds = new Set<string>()
  const assignmentIds = new Set<string>()
  const conceptIds = new Set<string>()
  for (const e of events) {
    if (PIN_KINDS.has(e.kind) || e.kind === 'cell.waive' || e.kind === 'cell.unwaive') {
      cellRefs.push({ fileId: e.fileId!, cellId: e.cellId!, ...(e.laneId ? { laneId: e.laneId } : {}) })
    }
    if (e.kind === 'comment.create') {
      if (e.fileId && e.cellId) cellRefs.push({ fileId: e.fileId, cellId: e.cellId })
      else if (e.fileId) fileIds.add(e.fileId)
      const parent = e.payload.parentCommentId
      if (typeof parent === 'string') commentIds.add(parent)
    }
    if (e.kind === 'comment.edit' || e.kind === 'comment.delete' || e.kind === 'comment.resolve') {
      commentIds.add(e.payload.commentId as string)
    }
    if (e.kind === 'file.rename' || e.kind === 'file.delete' || e.kind === 'file.restore') {
      fileIds.add(e.fileId!)
    }
    if (e.kind === 'assignment.create') {
      for (const entry of e.payload.scope as { fileId: string }[]) fileIds.add(entry.fileId)
    }
    if (e.kind === 'assignment.reassign' || e.kind === 'assignment.unassign') {
      assignmentIds.add(e.payload.assignmentId as string)
    }
    // term.create names a concept that must NOT exist yet; the rest name one
    // that must. Both need the row loaded.
    if (TERM_EMIT_KINDS.has(e.kind) && typeof e.payload.conceptId === 'string') {
      conceptIds.add(e.payload.conceptId)
    }
  }
  return {
    cellRefs,
    fileIds: [...fileIds],
    commentIds: [...commentIds],
    assignmentIds: [...assignmentIds],
    conceptIds: [...conceptIds],
  }
}

/**
 * Prepare an EmitEvents changeset (sole command). Every reference is resolved
 * against the live projection and a failure REJECTS the whole plan
 * (validation_failed naming the event index) — a mixed-kind batch with
 * silently-skipped items is not an approvable plan. Head pins land in the
 * standard preconditions list so the shared commit gate re-checks drift.
 * `callerRoleLevel` is the live-resolved role (the static floor was already
 * enforced by the generic prepare gate); this adds the dynamic foreign-row
 * bumps — foreign comment mutation (FOREIGN_COMMENT_ROLE) and foreign
 * unvalidate (MAINTAINER) — mirroring the /events perimeter's own checks so a
 * plan the caller could never commit is denied here rather than staged.
 */
export async function prepareEmitEvents(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: EmitEventsCommand,
  env: ExternalEnv,
  callerRoleLevel: number,
): Promise<Response> {
  const refs = collectRefs(cmd.events)
  const hasTerms = cmd.events.some((e) => TERM_EMIT_KINDS.has(e.kind))
  const [states, files, comments, assignments, concepts, termbaseFloor, commentFloors] = await Promise.all([
    resolveCellStates(db, projectId, refs.cellRefs),
    loadFiles(db, projectId, refs.fileIds),
    loadComments(db, projectId, refs.commentIds),
    loadAssignments(db, projectId, refs.assignmentIds),
    loadConcepts(db, projectId, refs.conceptIds),
    // Only pay for the org lookup when the batch actually touches terminology.
    hasTerms ? resolveTermbaseFloor(db, projectId) : Promise.resolve(0),
    // AQU-1002: the org's configurable comment floors. Resolved once for the
    // whole plan alongside the other reference loads — the plan is
    // single-project, so there is nothing to key a cache on.
    resolveCommentFloors(db, projectId),
  ])

  const failed = (i: number, message: string, details?: unknown): Response =>
    errorResponse('validation_failed', `events[${i}]: ${message}`, details)

  const preconditionByKey = new Map<string, CellPrecondition>()
  const plannedEmit: NonNullable<PlannedEventIds['emitEvents']> = []
  const normalized: EmitEventInput[] = []

  for (const [i, e] of cmd.events.entries()) {
    const planned: NonNullable<PlannedEventIds['emitEvents']>[number] = { eventId: uuidv7() }
    let fileId = e.fileId

    if (PIN_KINDS.has(e.kind) || e.kind === 'cell.waive' || e.kind === 'cell.unwaive') {
      const s = states.get(laneCellKey(e.fileId!, e.cellId!, e.laneId))
      if (!s || (!s.sourceExists && !s.targetExists)) {
        return failed(i, `cell ${e.cellId} in file ${e.fileId} does not exist`)
      }
      if (PIN_KINDS.has(e.kind)) {
        if (s.targetHeadEventId == null) {
          return failed(
            i,
            `no target translation exists for cell ${e.cellId} in ${e.laneId ? `lane "${e.laneId}"` : 'the default lane'}`,
          )
        }
        if (e.kind === 'target.cell.repin' && s.sourceEventId == null) {
          return failed(i, `cell ${e.cellId} has no source to repin against`)
        }
        // AQU-1184 guardrail 1 — no validation-laundering of AI content.
        // The in-app policy (AQU-983) deliberately skips ai_drafted cells in
        // bulk validate so a reviewer must open each one; this surface must
        // not become the way around it. There is NO flag to bypass this: an
        // agent validating text an agent drafted is not review. A human
        // target commit or an individual in-app validation clears
        // cells.ai_drafted (AQU-292), after which the cell validates through
        // here like any other. Drift the other way (the cell becomes an AI
        // draft between prepare and commit) necessarily moves the target
        // head, which the stored pin catches as plan_stale.
        if (e.kind === 'cell.validate' && s.targetAiDrafted === true) {
          return failed(
            i,
            `cell ${e.cellId} in file ${e.fileId} is an unreviewed AI draft — AI-drafted text must be reviewed by a human in the app before it can be validated; no API flag bypasses this`,
          )
        }
        preconditionByKey.set(laneCellKey(e.fileId!, e.cellId!, e.laneId), {
          fileId: e.fileId!,
          cellId: e.cellId!,
          ...(e.laneId ? { laneId: e.laneId } : {}),
          targetHeadEventId: s.targetHeadEventId,
          sourceEventId: s.sourceEventId,
        })
      }
      // Foreign unvalidate (removing another user's validation) is a
      // maintainer-level act — same bump the /events perimeter enforces.
      if (e.kind === 'cell.unvalidate') {
        const target = e.payload.targetUsername
        if (typeof target === 'string' && target !== cred.username && callerRoleLevel < ROLE.MAINTAINER) {
          return errorResponse(
            'permission_denied',
            `events[${i}]: removing another user's validation requires maintainer (600)`,
          )
        }
      }
    }

    if (e.kind === 'comment.create') {
      const parent = e.payload.parentCommentId
      if (typeof parent === 'string') {
        const row = comments.get(parent)
        if (!row || row.deleted_at != null) return failed(i, `parent comment ${parent} does not exist`)
      }
      if (e.fileId && e.cellId) {
        const s = states.get(laneCellKey(e.fileId, e.cellId, e.laneId))
        if (!s || (!s.sourceExists && !s.targetExists)) {
          return failed(i, `cell ${e.cellId} in file ${e.fileId} does not exist`)
        }
      }
      if (e.fileId && !e.cellId) {
        const f = files.get(e.fileId)
        if (!f || f.deleted_at != null) return failed(i, `file ${e.fileId} does not exist`)
      }
      // AQU-1002: org-configurable floor to open a thread or post a reply.
      // Only ever raises the static COMMENTER floor the generic prepare gate
      // already applied; mirrors the /events perimeter's own check.
      if (callerRoleLevel < commentFloors.createMinRole) {
        return errorResponse(
          'permission_denied',
          `events[${i}]: creating a comment requires ${roleLabel(commentFloors.createMinRole)} (${commentFloors.createMinRole})`,
        )
      }
      if (!e.payload.commentId) planned.commentId = uuidv7()
    }

    if (e.kind === 'comment.edit' || e.kind === 'comment.delete' || e.kind === 'comment.resolve') {
      const commentId = e.payload.commentId as string
      const row = comments.get(commentId)
      if (!row || row.deleted_at != null) return failed(i, `comment ${commentId} does not exist`)
      if (e.kind === 'comment.resolve' && row.parent_comment_id != null) {
        return failed(i, `comment ${commentId} is a reply — only top-level threads can be resolved`)
      }
      // AQU-999: edit/delete read FOREIGN_COMMENT_ROLE, the same table the
      // /events perimeter reads — maintainer (600) for both.
      // AQU-1002: resolve/reopen instead reads the org's configurable floor,
      // defaulting to AQU-999's contributor (400). Both perimeters resolve it
      // the same way, so the policy cannot drift between them.
      const foreignFloor =
        e.kind === 'comment.resolve'
          ? commentFloors.resolveMinRole
          : requiredRoleForForeignComment(e.kind)
      if (row.author_id !== cred.username && callerRoleLevel < foreignFloor) {
        const verb = e.kind === 'comment.resolve' ? 'resolving' : 'mutating'
        return errorResponse(
          'permission_denied',
          `events[${i}]: ${verb} another user's comment requires ${roleLabel(foreignFloor)} (${foreignFloor})`,
        )
      }
      // Pin the routing fileId now (a comment's scope never moves): the
      // comment's own file, or the project sentinel for project-scoped threads.
      fileId = row.file_id ?? PROJECT_SENTINEL
    }

    if (e.kind === 'file.rename' || e.kind === 'file.delete' || e.kind === 'file.restore') {
      const f = files.get(e.fileId!)
      if (!f) return failed(i, `file ${e.fileId} does not exist`)
      if (e.kind !== 'file.restore' && f.deleted_at != null) {
        return failed(i, `file ${e.fileId} is deleted`)
      }
      if (e.kind === 'file.restore' && f.deleted_at == null) {
        return failed(i, `file ${e.fileId} is not deleted`)
      }
    }

    if (e.kind === 'assignment.create') {
      for (const entry of e.payload.scope as { fileId: string }[]) {
        const f = files.get(entry.fileId)
        if (!f || f.deleted_at != null) return failed(i, `scope file ${entry.fileId} does not exist`)
      }
      if (!e.payload.assignmentId) planned.assignmentId = uuidv7()
      // Envelope routing file defaults to the first scope file.
      fileId = fileId ?? (e.payload.scope as { fileId: string }[])[0].fileId
    }

    if (e.kind === 'assignment.reassign' || e.kind === 'assignment.unassign') {
      const assignmentId = e.payload.assignmentId as string
      if (!assignments.has(assignmentId)) return failed(i, `assignment ${assignmentId} does not exist`)
      if (!fileId) {
        // Route under one of the assignment's own files (any is fine — the
        // token is per-file for auth only; assignments are project-level).
        const row = await db
          .prepare(`SELECT file_id FROM assignment_cells WHERE assignment_id = ? LIMIT 1`)
          .bind(assignmentId)
          .first<{ file_id: string }>()
        if (!row) {
          return failed(i, `assignment ${assignmentId} has no resolvable file — provide fileId on the event`)
        }
        fileId = row.file_id
      }
    }

    if (TERM_EMIT_KINDS.has(e.kind)) {
      const conceptId = e.payload.conceptId as string | undefined
      if (e.kind === 'term.create') {
        // A create naming an existing concept would project as an idempotent
        // upsert — silently OVERWRITING someone's term. Reject it: the caller
        // meant term.update, or meant a new concept and reused an id.
        if (conceptId && concepts.has(conceptId)) {
          return failed(i, `concept ${conceptId} already exists — use term.update to change it`)
        }
        if (!conceptId) planned.conceptId = uuidv7()
      } else {
        const row = concepts.get(conceptId!)
        if (!row || row.deleted_at != null) return failed(i, `concept ${conceptId} does not exist`)
        // Only a draft is promotable — the projection guards on that, so an
        // approve of an active or deprecated concept would apply as a silent
        // no-op and report success. Say no here instead.
        if (e.kind === 'term.approve' && row.status !== 'draft') {
          return failed(i, `concept ${conceptId} is ${row.status}, not a draft awaiting approval`)
        }
      }
      // The org's termbase floor gates BINDING writes (anything but suggesting
      // a draft) — the same raise termbase-authority.ts applies at the /events
      // perimeter. Mirrored here so a plan the caller could never commit is
      // denied now rather than staged for a human to approve into a 403.
      if (isBindingTermWrite(e.kind, e.payload) && callerRoleLevel < termbaseFloor) {
        return errorResponse(
          'permission_denied',
          `events[${i}]: ${e.kind === 'term.create' ? 'creating an active term' : e.kind} requires role ${termbaseFloor} on this project's org (suggest instead with term.create status "draft")`,
        )
      }
      // Terminology is project-level: route under the sentinel, like a
      // project-scoped comment.
      fileId = PROJECT_SENTINEL
    }

    plannedEmit.push(planned)
    normalized.push({ ...e, ...(fileId !== undefined ? { fileId } : {}) })
  }

  // Per-kind effect lines, first-seen order; testimony kinds flagged (†). The
  // `label` is what the approval page shows a non-developer reviewer — see
  // emitKindEffectLabel. It is computed here rather than in the client so every
  // reviewing surface (page, chat card, receipt) says the same sentence.
  const byKind = new Map<string, EmitEventsSummaryEntry>()
  for (const e of normalized) {
    const entry = byKind.get(e.kind)
    if (entry) entry.count++
    else
      byKind.set(e.kind, {
        kind: e.kind,
        count: 1,
        testimony: TESTIMONY_EMIT_KINDS.has(e.kind),
        label: '',
      })
  }
  for (const entry of byKind.values()) entry.label = emitKindEffectLabel(entry.kind, entry.count)
  // AQU-1184 guardrail 2: name every staged validation cell-by-cell, with the
  // text as the server currently reads it, so the approver endorses specific
  // sentences rather than a count. Batches are capped at
  // EMIT_EVENTS_MAX_EVENTS, so this list is bounded by construction.
  const testimony: TestimonySummaryEntry[] = []
  for (const e of normalized) {
    if (e.kind !== 'cell.validate' && e.kind !== 'cell.unvalidate') continue
    const value = states.get(laneCellKey(e.fileId!, e.cellId!, e.laneId))?.targetValue ?? ''
    testimony.push({
      kind: e.kind,
      fileId: e.fileId!,
      cellId: e.cellId!,
      ...(e.laneId ? { laneId: e.laneId } : {}),
      text: value.slice(0, TESTIMONY_TEXT_MAX),
      truncated: value.length > TESTIMONY_TEXT_MAX,
    })
  }
  const summary: ChangesetSummary = {
    events: [...byKind.values()],
    ...(testimony.length > 0 ? { testimony } : {}),
    warnings: [],
  }

  const command: EmitEventsCommand = { kind: 'EmitEvents', events: normalized }
  return stageAndRespond(db, env, {
    id,
    projectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode,
    commands: [command],
    preconditions: [...preconditionByKey.values()],
    summary,
    plannedIds: { emitEvents: plannedEmit },
  })
}

/** Build the compiled payload for one plan event, filling server-resolved pins
 *  from the stored precondition and minted ids from the planned ledger. */
function compilePayload(
  e: EmitEventInput,
  pin: CellPrecondition | undefined,
  planned: { commentId?: string; assignmentId?: string; conceptId?: string } | undefined,
): Record<string, unknown> | null {
  switch (e.kind) {
    case 'cell.validate':
      if (!pin?.targetHeadEventId) return null
      return { editEventId: pin.targetHeadEventId, ...(e.laneId ? { targetLang: e.laneId } : {}) }
    case 'cell.unvalidate':
      if (!pin?.targetHeadEventId) return null
      return {
        editEventId: pin.targetHeadEventId,
        ...(e.payload.targetUsername !== undefined ? { targetUsername: e.payload.targetUsername } : {}),
        ...(e.laneId ? { targetLang: e.laneId } : {}),
      }
    case 'cell.backtranslation.set':
      if (!pin?.targetHeadEventId) return null
      return { ...e.payload, targetEventId: pin.targetHeadEventId }
    case 'target.cell.repin':
      if (!pin?.targetHeadEventId || !pin.sourceEventId) return null
      return { sourceEventId: pin.sourceEventId, expectedTargetEventId: pin.targetHeadEventId }
    case 'comment.create': {
      const scope: CommentScope =
        e.fileId && e.cellId
          ? { kind: 'cell', fileId: e.fileId, cellId: e.cellId }
          : e.fileId
            ? { kind: 'file', fileId: e.fileId }
            : { kind: 'project' }
      return {
        commentId: (e.payload.commentId as string | undefined) ?? planned?.commentId ?? uuidv7(),
        scope,
        body: e.payload.body,
        parentCommentId: (e.payload.parentCommentId as string | null | undefined) ?? null,
        ...(e.payload.createdForTranslated !== undefined
          ? { createdForTranslated: e.payload.createdForTranslated }
          : {}),
        // AQU-1233: every comment staged through the Agent API is agent-posted,
        // so the marker is set here rather than taken from the caller — the
        // payload validator already drops a supplied `viaAgent`, which means a
        // credential can neither forge nor suppress it.
        viaAgent: true,
      }
    }
    case 'assignment.create':
      return {
        ...e.payload,
        assignmentId: (e.payload.assignmentId as string | undefined) ?? planned?.assignmentId ?? uuidv7(),
        ...(e.laneId ? { targetLang: e.laneId } : {}),
      }
    case 'assignment.reassign':
      return { ...e.payload, ...(e.laneId !== undefined ? { targetLang: e.laneId } : {}) }
    case 'term.create':
      return {
        ...e.payload,
        conceptId: (e.payload.conceptId as string | undefined) ?? planned?.conceptId ?? uuidv7(),
      }
    default:
      // comment.edit/delete/resolve, cell.waive/unwaive, file.*,
      // assignment.unassign: the normalized payload IS the wire payload.
      return { ...e.payload }
  }
}

/**
 * Commit an EmitEvents changeset. The shared first-attempt gates (expiry,
 * ask-mode confirmation, precondition drift over the stored pins) already ran
 * in the commit core; this re-checks plan existence (first attempt only — a
 * crash-retry's own partial apply legitimately changed that state, and the
 * re-posted prepare-time ids converge through /events idempotency), compiles,
 * routes through the perimeter, stamps provenance, and writes the receipt.
 * Per-event perimeter rejections surface as receipt warnings (SetTranslation
 * parity) — an all-rejected batch fails with the perimeter's reason.
 */
export async function commitEmitEvents(
  request: Request,
  env: ExternalEnv,
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: EmitEventsCommand,
  confirmationId: string | null,
  channel: ProvenanceChannel,
  wasStaged: boolean,
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
): Promise<Response> {
  const projectId = cs.projectId

  if (wasStaged) {
    const refs = collectRefs(cmd.events)
    const [states, files, comments, assignments, concepts] = await Promise.all([
      resolveCellStates(db, projectId, refs.cellRefs),
      loadFiles(db, projectId, refs.fileIds),
      loadComments(db, projectId, refs.commentIds),
      loadAssignments(db, projectId, refs.assignmentIds),
      loadConcepts(db, projectId, refs.conceptIds),
    ])
    const stale = async (message: string): Promise<Response> => {
      await markChangesetStale(db, cs.id)
      return errorResponse('plan_stale', message)
    }
    for (const [i, e] of cmd.events.entries()) {
      if (e.kind === 'cell.waive' || e.kind === 'cell.unwaive' || (e.kind === 'comment.create' && e.cellId)) {
        const s = states.get(laneCellKey(e.fileId!, e.cellId!, e.kind === 'comment.create' ? undefined : e.laneId))
        if (!s || (!s.sourceExists && !s.targetExists)) {
          return stale(`events[${i}]: cell ${e.cellId} no longer exists`)
        }
      }
      if (e.kind === 'comment.edit' || e.kind === 'comment.delete' || e.kind === 'comment.resolve') {
        const row = comments.get(e.payload.commentId as string)
        if (!row || row.deleted_at != null) {
          return stale(`events[${i}]: comment ${e.payload.commentId} no longer exists`)
        }
      }
      if (e.kind === 'comment.create' && typeof e.payload.parentCommentId === 'string') {
        const row = comments.get(e.payload.parentCommentId)
        if (!row || row.deleted_at != null) {
          return stale(`events[${i}]: parent comment ${e.payload.parentCommentId} no longer exists`)
        }
      }
      if (e.kind === 'file.rename' || e.kind === 'file.delete' || e.kind === 'file.restore') {
        const f = files.get(e.fileId!)
        if (!f) return stale(`events[${i}]: file ${e.fileId} no longer exists`)
        if (e.kind !== 'file.restore' && f.deleted_at != null) {
          return stale(`events[${i}]: file ${e.fileId} was deleted since prepare`)
        }
        if (e.kind === 'file.restore' && f.deleted_at == null) {
          return stale(`events[${i}]: file ${e.fileId} was restored since prepare`)
        }
      }
      if (e.kind === 'assignment.reassign' || e.kind === 'assignment.unassign') {
        if (!assignments.has(e.payload.assignmentId as string)) {
          return stale(`events[${i}]: assignment ${e.payload.assignmentId} no longer exists`)
        }
      }
      if (TERM_EMIT_KINDS.has(e.kind)) {
        const conceptId = e.payload.conceptId as string | undefined
        const row = conceptId ? concepts.get(conceptId) : undefined
        if (e.kind === 'term.create') {
          // Someone created this concept between prepare and approval — landing
          // the plan now would overwrite their entry, which is exactly the
          // lost-update the term.* events exist to prevent.
          if (row && row.deleted_at == null) {
            return stale(`events[${i}]: concept ${conceptId} was created since prepare`)
          }
        } else if (!row || row.deleted_at != null) {
          return stale(`events[${i}]: concept ${conceptId} no longer exists`)
        }
      }
    }
  }

  // ── Compile with prepare-time ids + pinned values ─────────────────────────
  const pins = new Map(cs.preconditions.map((p) => [laneCellKey(p.fileId, p.cellId, p.laneId), p]))
  const clientTs = Date.now()
  const eventsByFile = new Map<string, RawEvent[]>()
  const allEventIds: string[] = []

  for (const [i, e] of cmd.events.entries()) {
    const planned = cs.plannedIds?.emitEvents?.[i]
    const pin = e.cellId ? pins.get(laneCellKey(e.fileId!, e.cellId, e.laneId)) : undefined
    const payload = compilePayload(e, pin, planned)
    if (payload === null) {
      return errorResponse('job_failed', `events[${i}]: stored plan is missing its precondition pin`)
    }
    const fileId =
      e.fileId ??
      (e.kind.startsWith('comment.') || TERM_EMIT_KINDS.has(e.kind) ? PROJECT_SENTINEL : undefined)
    if (!fileId) return errorResponse('job_failed', `events[${i}]: stored plan is missing its fileId`)
    // Generic compile: the per-kind payload shape was enforced by the
    // validator + compilePayload, so one unknown-cast at the envelope seam
    // beats a 16-arm typed constructor duplicating EventPayloads.
    const raw = {
      id: planned?.eventId ?? uuidv7(),
      schemaVersion: 1,
      kind: e.kind as EventKind,
      projectId,
      fileId,
      ...(e.cellId ? { cellId: e.cellId } : {}),
      parentId: null,
      author: cred.username,
      payload,
      clientTs,
    } as unknown as RawEvent
    allEventIds.push(raw.id)
    const list = eventsByFile.get(fileId)
    if (list) list.push(raw)
    else eventsByFile.set(fileId, [raw])
  }

  // ── Route through the /events perimeter, one token per file ──────────────
  const acceptedIds = new Set<string>()
  const rejected: { id: string; status: number; reason: string }[] = []
  for (const [fileId, events] of eventsByFile) {
    let token: string
    try {
      token = await mintInternalSyncToken(env, db, cred, projectId, fileId)
    } catch (err) {
      return toErrorResponse(err)
    }
    for (let i = 0; i < events.length; i += EMIT_CHUNK) {
      const chunk = events.slice(i, i + EMIT_CHUNK)
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
    }
  }

  if (acceptedIds.size === 0 && rejected.length > 0) {
    const anyForbidden = rejected.some((r) => r.status === 403)
    return errorResponse(
      anyForbidden ? 'permission_denied' : 'job_failed',
      'no events were applied',
      { rejected },
    )
  }

  const provenance = buildProvenance(request, cs, confirmationId, channel)
  const appliedIds = allEventIds.filter((eid) => acceptedIds.has(eid))
  await stampProvenance(db, provenance, appliedIds)

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
  await writeCommittedReceipt(db, cs.id, receipt, confirmationId)
  return Response.json({ receipt })
}
