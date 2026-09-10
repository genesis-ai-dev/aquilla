// EmitEvents — generalized event staging (AQU-926, command registry §2).
// One changeset command carrying a batch of role-allowed project events
// (comments, waives, validations, back-translations, repins, file lifecycle,
// assignments), compiled through the same precondition doctrine as
// SetTranslation and routed through the /events perimeter at commit.
//
// This module owns the STATIC layer: the allow-list, per-kind payload shape
// validation, and the role-floor arithmetic. Live-state resolution (pins,
// existence checks) and the compile/commit engine live in
// emit-events-engine.ts.

import { REQUIRED_ROLE, ROLE } from '../events/role-policy'

/**
 * Event kinds an EmitEvents changeset may stage (registry §2 v1). Everything
 * here is NON-chain-mutating (never in CHAIN_MUTATING_KINDS), so compiled
 * events carry parentId: null and never compete for a cell's chain slot; the
 * head-referencing kinds (validate/unvalidate/backtranslation/repin) pin the
 * live head into the changeset preconditions at prepare instead.
 *
 * Explicitly NOT here: target.cell.commit (use SetTranslation), source.cell.*,
 * cell.audio.* (use LinkMedia), reorders/retimes/mirrors, file.timing.set,
 * file.create (use PlanImport).
 */
export const ALLOWED_EMIT_KINDS: readonly string[] = [
  'comment.create',
  'comment.edit',
  'comment.delete',
  'comment.resolve',
  'cell.waive',
  'cell.unwaive',
  'cell.validate',
  'cell.unvalidate',
  'cell.backtranslation.set',
  'target.cell.repin',
  'file.rename',
  'file.delete',
  'file.restore',
  'assignment.create',
  'assignment.reassign',
  'assignment.unassign',
] as const

const ALLOWED_SET = new Set(ALLOWED_EMIT_KINDS)

/** Testimony kinds (registry §2 †): stageable, but the summary marks them so
 *  review UIs render per-item confirmation; excluded from any bulk auto-apply. */
export const TESTIMONY_EMIT_KINDS: ReadonlySet<string> = new Set([
  'cell.validate',
  'cell.unvalidate',
])

/** Hard cap on events per EmitEvents changeset — one human-reviewable plan,
 *  well under the /events perimeter's own per-request ceiling. */
export const EMIT_EVENTS_MAX_EVENTS = 200

/** One normalized plan event. `payload` holds only the caller-suppliable
 *  fields for its kind — server-resolved pins (editEventId, targetEventId,
 *  sourceEventId, expectedTargetEventId) are NEVER stored here; they are
 *  resolved into the changeset preconditions at prepare and filled at compile. */
export interface EmitEventInput {
  kind: string
  fileId?: string
  cellId?: string
  laneId?: string
  payload: Record<string, unknown>
}

export interface EmitEventsCommand {
  kind: 'EmitEvents'
  events: EmitEventInput[]
}

/** Changeset floor = max REQUIRED_ROLE over the batch's event kinds
 *  (role-policy is the single source of truth; dynamic bumps — foreign
 *  unvalidate → MAINTAINER, foreign comment mutation → FOREIGN_COMMENT_ROLE
 *  — are prepare-time checks). */
export function emitEventsFloor(cmd: EmitEventsCommand): number {
  let floor = 0
  for (const e of cmd.events) {
    // Sam, 2026-08-21: source.cell.create/delete/reorder dropped to
    // CONTRIBUTOR in the static table so the app's `allowLineCreation`
    // setting can admit contributors — with authorize.ts enforcing the
    // conditional part per event. THIS surface never runs those per-event
    // checks, so it keeps the old PROJECT_LEAD floor: an integration adding,
    // deleting or re-anchoring source rows is a re-import-shaped act, not
    // the timeline affordance.
    const kindFloor =
      e.kind === 'source.cell.create' || e.kind === 'source.cell.delete' || e.kind === 'source.cell.reorder'
        ? ROLE.PROJECT_LEAD
        : (REQUIRED_ROLE[e.kind as keyof typeof REQUIRED_ROLE] ?? 0)
    floor = Math.max(floor, kindFloor)
  }
  return floor
}

export interface EmitValidationIssue {
  index: number
  message: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Kinds that must name a real (fileId, cellId) on the envelope. */
const CELL_KINDS = new Set([
  'cell.waive',
  'cell.unwaive',
  'cell.validate',
  'cell.unvalidate',
  'cell.backtranslation.set',
  'target.cell.repin',
])

/** Kinds that must name a fileId (no cellId). */
const FILE_KINDS = new Set(['file.rename', 'file.delete', 'file.restore'])

/** Kinds whose envelope laneId is meaningful (head resolution and/or the
 *  compiled payload's targetLang). Everything else rejects a laneId. */
const LANE_KINDS = new Set([
  'cell.validate',
  'cell.unvalidate',
  'cell.backtranslation.set',
  'target.cell.repin',
  'assignment.create',
  'assignment.reassign',
])

/** Payload fields the server resolves from the live projection at prepare. A
 *  caller-supplied value would either be silently ignored or fork the plan
 *  from what commit re-checks — reject with a teaching message instead. */
const SERVER_RESOLVED_FIELDS: Record<string, string[]> = {
  // AQU-1233: viaAgent is stamped at compile — a caller supplying it (either to
  // forge the marker on a human's behalf or to suppress it on its own comment)
  // gets a validation error rather than a silent drop.
  'comment.create': ['viaAgent'],
  'cell.validate': ['editEventId'],
  'cell.unvalidate': ['editEventId'],
  'cell.backtranslation.set': ['targetEventId'],
  'target.cell.repin': ['sourceEventId', 'expectedTargetEventId'],
}

/**
 * Validate one raw EmitEvents command into its normalized form (shape only —
 * pins, existence, and dynamic role bumps are prepare-time). Unknown payload
 * fields are dropped by the per-kind whitelist copy, matching validateCommands'
 * style, EXCEPT the server-resolved pin fields which are rejected explicitly.
 */
export function validateEmitEventsCommand(
  c: Record<string, unknown>,
  index: number,
  issues: EmitValidationIssue[],
): EmitEventsCommand | null {
  if (!Array.isArray(c.events) || c.events.length === 0) {
    issues.push({ index, message: 'EmitEvents.events must be a non-empty array' })
    return null
  }
  if (c.events.length > EMIT_EVENTS_MAX_EVENTS) {
    issues.push({
      index,
      message: `EmitEvents.events exceeds the maximum of ${EMIT_EVENTS_MAX_EVENTS} events per changeset`,
    })
    return null
  }

  const events: EmitEventInput[] = []
  for (const [i, rawEvent] of c.events.entries()) {
    const where = `EmitEvents.events[${i}]`
    if (!isPlainObject(rawEvent)) {
      issues.push({ index, message: `${where} must be an object` })
      return null
    }
    const kind = rawEvent.kind
    if (!isNonEmptyString(kind) || !ALLOWED_SET.has(kind)) {
      issues.push({
        index,
        message: `${where}.kind ${JSON.stringify(kind ?? null)} is not an allowed EmitEvents kind (allowed: ${ALLOWED_EMIT_KINDS.join(', ')})`,
      })
      return null
    }
    for (const key of ['fileId', 'cellId', 'laneId'] as const) {
      if (rawEvent[key] !== undefined && !isNonEmptyString(rawEvent[key])) {
        issues.push({ index, message: `${where}.${key} must be a non-empty string when present` })
        return null
      }
    }
    if (rawEvent.laneId !== undefined && !LANE_KINDS.has(kind)) {
      issues.push({ index, message: `${where}.laneId is not applicable to ${kind}` })
      return null
    }
    if (CELL_KINDS.has(kind) && (!isNonEmptyString(rawEvent.fileId) || !isNonEmptyString(rawEvent.cellId))) {
      issues.push({ index, message: `${where}: ${kind} requires fileId and cellId` })
      return null
    }
    if (FILE_KINDS.has(kind) && !isNonEmptyString(rawEvent.fileId)) {
      issues.push({ index, message: `${where}: ${kind} requires fileId` })
      return null
    }
    // comment.create's scope derives from the envelope (cell / file / project);
    // a cellId without its fileId would silently demote to a project comment.
    if (kind === 'comment.create' && rawEvent.cellId !== undefined && rawEvent.fileId === undefined) {
      issues.push({ index, message: `${where}: comment.create with cellId requires fileId` })
      return null
    }
    const rawPayload = rawEvent.payload === undefined ? {} : rawEvent.payload
    if (!isPlainObject(rawPayload)) {
      issues.push({ index, message: `${where}.payload must be an object when present` })
      return null
    }
    for (const field of SERVER_RESOLVED_FIELDS[kind] ?? []) {
      if (rawPayload[field] !== undefined) {
        issues.push({
          index,
          message: `${where}.payload.${field} is server-resolved from the live projection at prepare — omit it`,
        })
        return null
      }
    }

    const payload = validatePayload(kind, rawPayload, where, index, issues)
    if (payload === null) return null

    events.push({
      kind,
      ...(rawEvent.fileId !== undefined ? { fileId: rawEvent.fileId as string } : {}),
      ...(rawEvent.cellId !== undefined ? { cellId: rawEvent.cellId as string } : {}),
      ...(rawEvent.laneId !== undefined ? { laneId: rawEvent.laneId as string } : {}),
      payload,
    })
  }
  return { kind: 'EmitEvents', events }
}

/** Per-kind payload whitelist + type checks. Returns the normalized payload or
 *  null after pushing an issue. */
function validatePayload(
  kind: string,
  p: Record<string, unknown>,
  where: string,
  index: number,
  issues: EmitValidationIssue[],
): Record<string, unknown> | null {
  const bad = (message: string): null => {
    issues.push({ index, message: `${where}.payload.${message}` })
    return null
  }
  switch (kind) {
    case 'comment.create': {
      if (typeof p.body !== 'string' || p.body.length === 0) return bad('body must be a non-empty string')
      if (p.commentId !== undefined && !isNonEmptyString(p.commentId)) return bad('commentId must be a non-empty string when present')
      if (p.parentCommentId !== undefined && p.parentCommentId !== null && !isNonEmptyString(p.parentCommentId)) {
        return bad('parentCommentId must be a non-empty string or null when present')
      }
      if (p.createdForTranslated !== undefined && p.createdForTranslated !== null && typeof p.createdForTranslated !== 'string') {
        return bad('createdForTranslated must be a string or null when present')
      }
      return {
        body: p.body,
        ...(p.commentId !== undefined ? { commentId: p.commentId } : {}),
        ...(p.parentCommentId !== undefined ? { parentCommentId: p.parentCommentId } : {}),
        ...(p.createdForTranslated !== undefined ? { createdForTranslated: p.createdForTranslated } : {}),
      }
    }
    case 'comment.edit': {
      if (!isNonEmptyString(p.commentId)) return bad('commentId must be a non-empty string')
      if (typeof p.body !== 'string' || p.body.length === 0) return bad('body must be a non-empty string')
      return { commentId: p.commentId, body: p.body }
    }
    case 'comment.delete': {
      if (!isNonEmptyString(p.commentId)) return bad('commentId must be a non-empty string')
      return { commentId: p.commentId }
    }
    case 'comment.resolve': {
      if (!isNonEmptyString(p.commentId)) return bad('commentId must be a non-empty string')
      if (typeof p.resolved !== 'boolean') return bad('resolved must be a boolean')
      return { commentId: p.commentId, resolved: p.resolved }
    }
    case 'cell.waive': {
      if (!isNonEmptyString(p.ruleId)) return bad('ruleId must be a non-empty string')
      if (p.reason !== undefined && typeof p.reason !== 'string') return bad('reason must be a string when present')
      return { ruleId: p.ruleId, ...(p.reason !== undefined ? { reason: p.reason } : {}) }
    }
    case 'cell.unwaive': {
      if (!isNonEmptyString(p.ruleId)) return bad('ruleId must be a non-empty string')
      return { ruleId: p.ruleId }
    }
    case 'cell.validate':
      return {}
    case 'cell.unvalidate': {
      if (p.targetUsername !== undefined && !isNonEmptyString(p.targetUsername)) {
        return bad('targetUsername must be a non-empty string when present')
      }
      return { ...(p.targetUsername !== undefined ? { targetUsername: p.targetUsername } : {}) }
    }
    case 'cell.backtranslation.set': {
      if (typeof p.btText !== 'string' || p.btText.length === 0) return bad('btText must be a non-empty string')
      if (p.btHtml !== undefined && typeof p.btHtml !== 'string') return bad('btHtml must be a string when present')
      if (p.polished !== undefined && typeof p.polished !== 'boolean') return bad('polished must be a boolean when present')
      return {
        btText: p.btText,
        ...(p.btHtml !== undefined ? { btHtml: p.btHtml } : {}),
        polished: p.polished ?? false,
      }
    }
    case 'target.cell.repin':
      return {}
    case 'file.rename': {
      if (!isNonEmptyString(p.name)) return bad('name must be a non-empty string')
      return { name: p.name }
    }
    case 'file.delete':
    case 'file.restore':
      return {}
    case 'assignment.create': {
      if (p.assignmentId !== undefined && !isNonEmptyString(p.assignmentId)) {
        return bad('assignmentId must be a non-empty string when present')
      }
      if (p.scopeKind !== 'books' && p.scopeKind !== 'chapters') return bad("scopeKind must be 'books' or 'chapters'")
      if (!Array.isArray(p.scope) || p.scope.length === 0) return bad('scope must be a non-empty array')
      const scope: { fileId: string; chapter?: string }[] = []
      for (const [entryIndex, rawEntry] of p.scope.entries()) {
        if (!isPlainObject(rawEntry) || !isNonEmptyString(rawEntry.fileId)) {
          return bad(`scope[${entryIndex}].fileId must be a non-empty string`)
        }
        if (rawEntry.chapter !== undefined && !isNonEmptyString(rawEntry.chapter)) {
          return bad(`scope[${entryIndex}].chapter must be a non-empty string when present`)
        }
        scope.push({
          fileId: rawEntry.fileId,
          ...(rawEntry.chapter !== undefined ? { chapter: rawEntry.chapter as string } : {}),
        })
      }
      if (!isNonEmptyString(p.scopeLabel)) return bad('scopeLabel must be a non-empty string')
      if (typeof p.assigneeUserId !== 'number' || !Number.isInteger(p.assigneeUserId)) {
        return bad('assigneeUserId must be an integer user id')
      }
      if (p.deadline !== undefined && p.deadline !== null && typeof p.deadline !== 'string') {
        return bad('deadline must be a string or null when present')
      }
      if (p.note !== undefined && p.note !== null && typeof p.note !== 'string') {
        return bad('note must be a string or null when present')
      }
      return {
        ...(p.assignmentId !== undefined ? { assignmentId: p.assignmentId } : {}),
        scopeKind: p.scopeKind,
        scope,
        scopeLabel: p.scopeLabel,
        assigneeUserId: p.assigneeUserId,
        ...(p.deadline !== undefined ? { deadline: p.deadline } : {}),
        ...(p.note !== undefined ? { note: p.note } : {}),
      }
    }
    case 'assignment.reassign': {
      if (!isNonEmptyString(p.assignmentId)) return bad('assignmentId must be a non-empty string')
      if (typeof p.assigneeUserId !== 'number' || !Number.isInteger(p.assigneeUserId)) {
        return bad('assigneeUserId must be an integer user id')
      }
      return { assignmentId: p.assignmentId, assigneeUserId: p.assigneeUserId }
    }
    case 'assignment.unassign': {
      if (!isNonEmptyString(p.assignmentId)) return bad('assignmentId must be a non-empty string')
      return { assignmentId: p.assignmentId }
    }
    default:
      // Unreachable — kind was checked against ALLOWED_SET.
      issues.push({ index, message: `${where}.kind ${kind} has no payload validator` })
      return null
  }
}
