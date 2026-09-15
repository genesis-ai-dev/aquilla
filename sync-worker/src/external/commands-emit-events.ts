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
 *
 * AQU-1179 added the `term.*` block — the whole of the "term, rule and memory"
 * widening the ticket asks for, because term.* is the only one of the three
 * that HAS event kinds: rules and Living Memory are not on the event log
 * (rules live in the settings blob behind PatchSettings; memory lives behind
 * auth-worker's agent-memory API), so there is nothing for an allowlist to
 * name. They join this list when — and only when — they are event-sourced.
 * No source-edit, cell-structure, membership or project-lifecycle kind was
 * added: those stay off the generic door until a human puts them on it.
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
  // Terminology concepts (AQU-1179). Project-scoped: no fileId/cellId on the
  // envelope — the engine routes them under the project sentinel.
  'term.create',
  'term.update',
  'term.delete',
  'term.approve',
  'term.reject',
] as const

const ALLOWED_SET = new Set(ALLOWED_EMIT_KINDS)

/** Testimony kinds (registry §2 †): stageable, but the summary marks them so
 *  review UIs render per-item confirmation; excluded from any bulk auto-apply. */
export const TESTIMONY_EMIT_KINDS: ReadonlySet<string> = new Set([
  'cell.validate',
  'cell.unvalidate',
])

/** Terminology kinds — project-scoped (no fileId/cellId on the envelope). */
export const TERM_EMIT_KINDS: ReadonlySet<string> = new Set([
  'term.create',
  'term.update',
  'term.delete',
  'term.approve',
  'term.reject',
])

/** Hard cap on events per EmitEvents changeset — one human-reviewable plan,
 *  well under the /events perimeter's own per-request ceiling. */
export const EMIT_EVENTS_MAX_EVENTS = 200

/**
 * Plain-language effect line for one staged kind (AQU-1179).
 *
 * The approval page renders THIS, not the raw event kind: the person clicking
 * "approve" is a translation manager, not a developer, and `cell.backtranslation.set × 12`
 * is not a sentence they can consent to. One phrasing per kind, count-aware,
 * written as the effect on the project ("Add 3 comments"), never as the
 * mechanism. Unknown kinds fall back to the raw kind so a newly allowlisted
 * kind that forgets its phrasing degrades to today's output rather than an
 * empty line.
 */
export function emitKindEffectLabel(kind: string, count: number): string {
  const n = count
  const s = (one: string, many: string) => (n === 1 ? `${one}` : `${n} ${many}`)
  switch (kind) {
    case 'comment.create': return `Add ${s('a comment', 'comments')}`
    case 'comment.edit': return `Edit ${s('a comment', 'comments')}`
    case 'comment.delete': return `Delete ${s('a comment', 'comments')}`
    case 'comment.resolve': return `Resolve or reopen ${s('a comment thread', 'comment threads')}`
    case 'cell.waive': return `Waive a quality rule on ${s('a line', 'lines')}`
    case 'cell.unwaive': return `Restore a waived quality rule on ${s('a line', 'lines')}`
    case 'cell.validate': return `Mark ${s('a translation', 'translations')} as validated — recorded under your name`
    case 'cell.unvalidate': return `Remove validation from ${s('a translation', 'translations')}`
    case 'cell.backtranslation.set': return `Save a back-translation for ${s('a line', 'lines')}`
    case 'target.cell.repin': return `Clear the "source changed" flag on ${s('a line', 'lines')}`
    case 'file.rename': return `Rename ${s('a file', 'files')}`
    case 'file.delete': return `Move ${s('a file', 'files')} to the trash`
    case 'file.restore': return `Restore ${s('a file', 'files')} from the trash`
    case 'assignment.create': return `Assign work to ${s('a team member', 'team members')}`
    case 'assignment.reassign': return `Reassign ${s('an assignment', 'assignments')} to someone else`
    case 'assignment.unassign': return `Remove ${s('an assignment', 'assignments')}`
    case 'term.create': return `Add ${s('a glossary term', 'glossary terms')}`
    case 'term.update': return `Edit ${s('a glossary term', 'glossary terms')}`
    case 'term.delete': return `Delete ${s('a glossary term', 'glossary terms')}`
    case 'term.approve': return `Approve ${s('a glossary term', 'glossary terms')} — enforced for everyone on the project`
    case 'term.reject': return `Reject ${s('a suggested glossary term', 'suggested glossary terms')}`
    default: return `${kind} × ${n}`
  }
}

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
    // AQU-1068: source.cell.create/delete/reorder sit at COMMENTER in the
    // static table, and PROJECT_LEAD is put back here because an integration
    // adding, deleting or re-anchoring source rows is a re-import-shaped act.
    //
    // THIS LINE IS LOAD-BEARING, not a fail-fast convenience. It used to be one
    // of two floors: the project's `cellEditingFloor` was also checked per
    // event in authorize.ts. Since 2026-09-09 that tier is a product rule
    // enforced at the button and NOT at the perimeter, and the external surface
    // never consulted it anyway (it is exempt by `src === 'external'`). So this
    // hard-coded PROJECT_LEAD is now the ONLY thing holding an integration
    // above COMMENTER for these three kinds. A test pins it. Do not soften it
    // to REQUIRED_ROLE without replacing it with something else.
    //
    // What still applies at commit is the maintainer requirement on removing an
    // IMPORTED cell — except that the external exemption skips that too, which
    // is a documented gap rather than an accident: it is the behaviour this
    // surface had before AQU-1068. See authorize.ts.
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
    // Terminology is project-level: a fileId/cellId on the envelope would be
    // silently discarded when the engine routes the event under the project
    // sentinel, so reject it rather than accept a plan that reads as scoped.
    if (TERM_EMIT_KINDS.has(kind) && (rawEvent.fileId !== undefined || rawEvent.cellId !== undefined)) {
      issues.push({
        index,
        message: `${where}: ${kind} is project-level — omit fileId and cellId (the concept id rides the payload)`,
      })
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

/** Mirrors TermRenderingPayload in events/types.ts (redeclared locally so this
 *  static module keeps its dependency-light shape). */
interface TermRendering {
  rendering: string
  status: 'preferred' | 'admitted' | 'forbidden'
}

const RENDERING_STATUSES: ReadonlySet<string> = new Set(['preferred', 'admitted', 'forbidden'])

/** A concept's rendering list — replaced wholesale by create/update, so it must
 *  be fully valid or the whole event is rejected. */
function validateRenderings(
  value: unknown,
  bad: (message: string) => null,
): TermRendering[] | null {
  if (!Array.isArray(value)) {
    bad('renderings must be an array')
    return null
  }
  const out: TermRendering[] = []
  for (const [i, raw] of value.entries()) {
    if (!isPlainObject(raw) || !isNonEmptyString(raw.rendering)) {
      bad(`renderings[${i}].rendering must be a non-empty string`)
      return null
    }
    if (typeof raw.status !== 'string' || !RENDERING_STATUSES.has(raw.status)) {
      bad(`renderings[${i}].status must be 'preferred', 'admitted' or 'forbidden'`)
      return null
    }
    out.push({ rendering: raw.rendering, status: raw.status as TermRendering['status'] })
  }
  return out
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
    case 'term.create': {
      if (p.conceptId !== undefined && !isNonEmptyString(p.conceptId)) {
        return bad('conceptId must be a non-empty string when present')
      }
      if (!isNonEmptyString(p.sourceTerm)) return bad('sourceTerm must be a non-empty string')
      const renderings = validateRenderings(p.renderings, bad)
      if (renderings === null) return null
      // Status is REQUIRED on create (unlike the app's own default) so an
      // integration can never fall into 'active' by omission: proposing a term
      // and enforcing one for every translator are different acts and the
      // caller has to say which it meant. 'deprecated' is a review outcome,
      // not a birth state — term.reject produces it.
      if (p.status !== 'draft' && p.status !== 'active') return bad("status must be 'draft' or 'active'")
      if (p.notes !== undefined && typeof p.notes !== 'string') return bad('notes must be a string when present')
      if (p.caseSensitive !== undefined && typeof p.caseSensitive !== 'boolean') {
        return bad('caseSensitive must be a boolean when present')
      }
      return {
        ...(p.conceptId !== undefined ? { conceptId: p.conceptId } : {}),
        sourceTerm: p.sourceTerm,
        renderings,
        status: p.status,
        ...(p.notes !== undefined ? { notes: p.notes } : {}),
        ...(p.caseSensitive !== undefined ? { caseSensitive: p.caseSensitive } : {}),
      }
    }
    case 'term.update': {
      if (!isNonEmptyString(p.conceptId)) return bad('conceptId must be a non-empty string')
      if (p.sourceTerm !== undefined && !isNonEmptyString(p.sourceTerm)) {
        return bad('sourceTerm must be a non-empty string when present')
      }
      let renderings: TermRendering[] | undefined
      if (p.renderings !== undefined) {
        const parsed = validateRenderings(p.renderings, bad)
        if (parsed === null) return null
        renderings = parsed
      }
      if (p.notes !== undefined && typeof p.notes !== 'string') return bad('notes must be a string when present')
      if (p.caseSensitive !== undefined && typeof p.caseSensitive !== 'boolean') {
        return bad('caseSensitive must be a boolean when present')
      }
      // `status` is deliberately absent: the review transitions are their own
      // kinds (term.approve / term.reject) so the audit trail distinguishes
      // "edited" from "approved". A status here would launder one into the other.
      if (p.status !== undefined) {
        return bad('status is not patchable — use term.approve or term.reject')
      }
      const patch: Record<string, unknown> = { conceptId: p.conceptId }
      if (p.sourceTerm !== undefined) patch.sourceTerm = p.sourceTerm
      if (renderings !== undefined) patch.renderings = renderings
      if (p.notes !== undefined) patch.notes = p.notes
      if (p.caseSensitive !== undefined) patch.caseSensitive = p.caseSensitive
      if (Object.keys(patch).length === 1) return bad('must patch at least one field')
      return patch
    }
    case 'term.delete':
    case 'term.approve': {
      if (!isNonEmptyString(p.conceptId)) return bad('conceptId must be a non-empty string')
      return { conceptId: p.conceptId }
    }
    case 'term.reject': {
      if (!isNonEmptyString(p.conceptId)) return bad('conceptId must be a non-empty string')
      if (p.mode !== 'delete' && p.mode !== 'deprecate') return bad("mode must be 'delete' or 'deprecate'")
      return { conceptId: p.conceptId, mode: p.mode }
    }
    default:
      // Unreachable — kind was checked against ALLOWED_SET.
      issues.push({ index, message: `${where}.kind ${kind} has no payload validator` })
      return null
  }
}
