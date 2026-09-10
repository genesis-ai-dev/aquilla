// Living Memory write commands (AQU-1228, command registry §2): AddExample,
// AddDecision, AddNote, RetireExample.
//
// These do NOT ride EmitEvents. Living Memory is not event-sourced — it lives
// in the `agent_memories` table (db/shared/agent-memory.ts), keyed by a
// markdown `path` per project, with its own proposed→approved lifecycle. So
// these are RECEIPT-ONLY commands, exactly like PatchSettings: no compiled
// events, no cell preconditions, a plain row write guarded by the changeset
// state machine.
//
// The two gates, and why they don't stack into a double approval:
//   • the changeset gate (ask-mode human confirmation on /approve/:id), and
//   • the memory gate (a PROJECT_LEAD approving a proposal in the Memory tab).
// A commit lands the memory `approved` ONLY when the changeset carried a real
// human confirmation AND the confirming user holds the memory-review floor
// (PROJECT_LEAD) — i.e. exactly the authority that same human would have
// exercised in the Memory tab. Otherwise (act mode, or a contributor-level
// approver) the memory lands `proposed` and still needs the in-app review.
// The receipt says which happened, so the caller never has to guess.
//
// Retrieval follows for free: buildMemoryContext selects approved memories
// only, so approving puts an entry into the next copilot prompt and retiring
// takes it out — no retrieval code changes here.

import { errorResponse, toErrorResponse } from './errors'
import { receiptOnlyGates, writeCommittedReceipt } from './commit-gates'
import { stageAndRespond } from './stage'
import { assertCredentialScope } from './token-bridge'
import type {
  ChangesetSummary,
  ExternalEnv,
  MemoryWriteReceipt,
  PlannedEventIds,
  ProvenanceChannel,
  StoredChangeset,
} from './types'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import {
  createProposal,
  getApprovedMemoryByPath,
  getMemory,
  retireMemory,
  reviewMemory,
  validateMemoryContent,
} from '../../../db/shared/agent-memory'
import { ROLE } from '../events/role-policy'

// ──────────────────────────────────────────────────────────────────────────
// Command shapes
// ──────────────────────────────────────────────────────────────────────────

export interface AddExampleCommand {
  kind: 'AddExample'
  /** Path slug — the memory lands at `examples/<slug>.md`. */
  slug: string
  source: string
  target: string
  note?: string
  rationale?: string
}

export interface AddDecisionCommand {
  kind: 'AddDecision'
  /** Path slug — the memory lands at `decisions/<slug>.md`. */
  slug: string
  /** The standing rule, stated so it reads as an instruction to the copilot. */
  decision: string
  rationale?: string
}

export interface RetireExampleCommand {
  kind: 'RetireExample'
  /** Slug of the example to retire — `examples/<slug>.md`. */
  slug: string
  rationale?: string
}

export interface AddNoteCommand {
  kind: 'AddNote'
  fileId: string
  cellId: string
  note: string
  rationale?: string
}

export type MemoryCommand =
  | AddExampleCommand
  | AddDecisionCommand
  | RetireExampleCommand
  | AddNoteCommand

export const MEMORY_COMMAND_KINDS = ['AddExample', 'AddDecision', 'RetireExample', 'AddNote'] as const

export function isMemoryCommand(c: { kind: string }): c is MemoryCommand {
  return (MEMORY_COMMAND_KINDS as readonly string[]).includes(c.kind)
}

/** Longest accepted free-text field. Well under the memory content ceiling
 *  (10KB) so the assembled markdown can never overflow it on its own. */
const MEMORY_TEXT_MAX = 2000
/** Slug ceiling — keeps the assembled path short and human-scannable. */
const SLUG_MAX = 64
/** Caller-supplied slugs: lowercase words joined by single dashes. Deliberately
 *  narrower than MEMORY_PATH_RE (no slashes, no trailing dash) so the assembled
 *  `examples/<slug>.md` is always a legal memory path AND stays one flat
 *  namespace per kind. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Staging floors. Adding is the propose-tier act (CONTRIBUTOR — the floor
 * auth-worker's POST /agent-memory enforces). Retiring un-publishes memory the
 * whole project's copilot is already reading, so it sits at the review tier
 * (PROJECT_LEAD — the floor that route's review endpoint enforces). Landing a
 * memory `approved` needs MEMORY_REVIEW_ROLE at commit regardless of kind.
 */
export const MEMORY_REVIEW_ROLE = ROLE.PROJECT_LEAD

export function memoryCommandFloor(c: MemoryCommand): number {
  return c.kind === 'RetireExample' ? MEMORY_REVIEW_ROLE : ROLE.CONTRIBUTOR
}

// ──────────────────────────────────────────────────────────────────────────
// Paths + rendered content
// ──────────────────────────────────────────────────────────────────────────

export function examplePath(slug: string): string {
  return `examples/${slug}.md`
}

export function decisionPath(slug: string): string {
  return `decisions/${slug}.md`
}

/** Lowercase a caller id into one legal path segment. Lossy by construction
 *  ("GEN 1:1" and "GEN.1.1" both slug to "gen-1-1"), which is why notePath
 *  disambiguates with a digest of the exact ids rather than trusting this. */
function slugifySegment(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Short, stable digest of the EXACT (fileId, cellId) pair. Two cells whose
 *  ids slugify identically must not share a note path — one would silently
 *  supersede the other's rationale. */
async function pairDigest(fileId: string, cellId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${fileId}\u0000${cellId}`)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash).slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * `notes/<file>/<cell>-<digest8>.md`. Deterministic, so re-noting the same cell
 * supersedes the same path (latest rationale wins, prior versions archived) —
 * and never collides with a different cell that happens to slugify the same.
 */
export async function notePath(fileId: string, cellId: string): Promise<string> {
  const file = slugifySegment(fileId) || 'file'
  const cell = slugifySegment(cellId) || 'cell'
  return `notes/${file}/${cell}-${await pairDigest(fileId, cellId)}.md`
}

/** Rendered memory body. The FIRST line is what buildMemoryContext puts in the
 *  prompt's memory index, so it has to stand alone as a one-line summary. */
export function renderMemoryContent(cmd: MemoryCommand): string {
  switch (cmd.kind) {
    case 'AddExample':
      return [
        `Example — render "${cmd.source}" as "${cmd.target}".`,
        '',
        `- Source: ${cmd.source}`,
        `- Target: ${cmd.target}`,
        ...(cmd.note ? [`- Note: ${cmd.note}`] : []),
      ].join('\n')
    case 'AddDecision':
      return [`Decision — ${cmd.decision}`, '', cmd.decision].join('\n')
    case 'AddNote':
      return [
        `Note on ${cmd.fileId} / ${cmd.cellId} — ${cmd.note}`,
        '',
        `- Cell: ${cmd.fileId} / ${cmd.cellId}`,
        `- Rationale: ${cmd.note}`,
      ].join('\n')
    case 'RetireExample':
      // Retirement writes no content — it archives an existing row.
      return ''
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Validation (shape only — existence and floors are prepare-time)
// ──────────────────────────────────────────────────────────────────────────

export interface MemoryValidationIssue {
  index: number
  message: string
}

function text(
  v: unknown,
  field: string,
  index: number,
  issues: MemoryValidationIssue[],
): string | null {
  if (typeof v !== 'string' || v.trim().length === 0) {
    issues.push({ index, message: `${field} must be a non-empty string` })
    return null
  }
  if (v.length > MEMORY_TEXT_MAX) {
    issues.push({ index, message: `${field} exceeds the ${MEMORY_TEXT_MAX} character maximum` })
    return null
  }
  return v.trim()
}

function optionalText(
  v: unknown,
  field: string,
  index: number,
  issues: MemoryValidationIssue[],
): { ok: true; value?: string } | { ok: false } {
  if (v === undefined) return { ok: true }
  const t = text(v, field, index, issues)
  return t === null ? { ok: false } : { ok: true, value: t }
}

function slug(
  v: unknown,
  field: string,
  index: number,
  issues: MemoryValidationIssue[],
): string | null {
  if (typeof v !== 'string' || !SLUG_RE.test(v) || v.length > SLUG_MAX) {
    issues.push({
      index,
      message: `${field} must be a lowercase dash-separated slug matching ${SLUG_RE.source} (max ${SLUG_MAX} chars)`,
    })
    return null
  }
  return v
}

/** Validate one raw memory command into its normalized form. */
export function validateMemoryCommand(
  c: Record<string, unknown>,
  index: number,
  issues: MemoryValidationIssue[],
): MemoryCommand | null {
  const kind = c.kind as MemoryCommand['kind']
  const rationale = optionalText(c.rationale, `${kind}.rationale`, index, issues)
  if (!rationale.ok) return null
  const withRationale = rationale.value !== undefined ? { rationale: rationale.value } : {}

  if (kind === 'AddExample') {
    const s = slug(c.slug, 'AddExample.slug', index, issues)
    const source = text(c.source, 'AddExample.source', index, issues)
    const target = text(c.target, 'AddExample.target', index, issues)
    const note = optionalText(c.note, 'AddExample.note', index, issues)
    if (s === null || source === null || target === null || !note.ok) return null
    return {
      kind,
      slug: s,
      source,
      target,
      ...(note.value !== undefined ? { note: note.value } : {}),
      ...withRationale,
    }
  }
  if (kind === 'AddDecision') {
    const s = slug(c.slug, 'AddDecision.slug', index, issues)
    const decision = text(c.decision, 'AddDecision.decision', index, issues)
    if (s === null || decision === null) return null
    return { kind, slug: s, decision, ...withRationale }
  }
  if (kind === 'RetireExample') {
    const s = slug(c.slug, 'RetireExample.slug', index, issues)
    if (s === null) return null
    return { kind, slug: s, ...withRationale }
  }
  const fileId = text(c.fileId, 'AddNote.fileId', index, issues)
  const cellId = text(c.cellId, 'AddNote.cellId', index, issues)
  const note = text(c.note, 'AddNote.note', index, issues)
  if (fileId === null || cellId === null || note === null) return null
  return { kind: 'AddNote', fileId, cellId, note, ...withRationale }
}

// ──────────────────────────────────────────────────────────────────────────
// Prepare
// ──────────────────────────────────────────────────────────────────────────

/** The memory path a command reads or writes. */
export async function memoryPathFor(cmd: MemoryCommand): Promise<string> {
  if (cmd.kind === 'AddNote') return notePath(cmd.fileId, cmd.cellId)
  if (cmd.kind === 'AddDecision') return decisionPath(cmd.slug)
  return examplePath(cmd.slug)
}

/** One-line effect preview for the approval page. */
function previewFor(cmd: MemoryCommand): string {
  switch (cmd.kind) {
    case 'AddExample':
      return `add example: "${cmd.source}" → "${cmd.target}"`
    case 'AddDecision':
      return `add decision: ${cmd.decision}`
    case 'AddNote':
      return `add note on ${cmd.fileId} / ${cmd.cellId}`
    case 'RetireExample':
      return `retire example ${cmd.slug}`
  }
}

/**
 * Prepare a memory changeset (sole command): role floor, live existence checks
 * (the cell for AddNote, the approved row for RetireExample), the shared
 * content validation (size ceiling + secret patterns), and the human-edited
 * guard — the same guard sequence its commit re-runs.
 */
export async function prepareMemoryCommand(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: MemoryCommand,
  env: ExternalEnv,
): Promise<Response> {
  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  const requiredRole = memoryCommandFloor(cmd)
  if (!role || role.level < requiredRole) {
    return errorResponse('permission_denied', `insufficient project role for ${cmd.kind}`, {
      requiredRole,
    })
  }

  const path = await memoryPathFor(cmd)

  if (cmd.kind === 'AddNote') {
    const cell = await db
      .prepare(`SELECT cell_id FROM cells WHERE project_id = ? AND file_id = ? AND cell_id = ? LIMIT 1`)
      .bind(projectId, cmd.fileId, cmd.cellId)
      .first<{ cell_id: string }>()
    if (!cell) {
      return errorResponse('not_found', 'AddNote names a cell that does not exist in this project', {
        fileId: cmd.fileId,
        cellId: cmd.cellId,
      })
    }
  }

  const guard = await guardMemoryTarget(db, projectId, cmd, path)
  if (guard) return guard

  const plannedIds: PlannedEventIds = {
    memory: { path, ...(cmd.kind === 'RetireExample' ? {} : { memoryId: crypto.randomUUID() }) },
  }

  const summary: ChangesetSummary = {
    command: cmd.kind,
    projectId,
    memoryWrites: [{ path, action: cmd.kind === 'RetireExample' ? 'retire' : 'add', preview: previewFor(cmd) }],
    warnings: [],
  }

  return stageAndRespond(db, env, {
    id,
    projectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode,
    commands: [cmd],
    preconditions: [],
    summary,
    plannedIds,
  })
}

/**
 * Guards shared by prepare and commit: the rendered content must pass the
 * memory content rules, and neither an add nor a retire may run over a
 * human-edited row through an agent surface (adversarial-panel B1/B2 — the
 * agent channel never overwrites or un-publishes human-owned memory; a human
 * does that in the Memory tab).
 */
async function guardMemoryTarget(
  db: AquillaDb,
  projectId: string,
  cmd: MemoryCommand,
  path: string,
): Promise<Response | null> {
  if (cmd.kind === 'RetireExample') {
    const existing = await getApprovedMemoryByPath(db, projectId, path)
    if (!existing) {
      return errorResponse('not_found', `no approved example at ${path} to retire`, { path })
    }
    if (existing.humanEdited) {
      return errorResponse(
        'permission_denied',
        `${path} was edited by a human — retire it from the in-app Memory surface instead`,
        { path },
      )
    }
    return null
  }

  const contentErr = validateMemoryContent(renderMemoryContent(cmd))
  if (contentErr) return errorResponse('validation_failed', contentErr.message, { path })

  const holder = await getApprovedMemoryByPath(db, projectId, path)
  if (holder?.humanEdited) {
    return errorResponse(
      'permission_denied',
      `${path} is held by a human-edited memory — edit it in the in-app Memory surface instead`,
      { path },
    )
  }
  return null
}

// ──────────────────────────────────────────────────────────────────────────
// Commit
// ──────────────────────────────────────────────────────────────────────────

/**
 * Commit a memory changeset (receipt-only). Re-runs the prepare guards live,
 * consumes the ask-mode confirmation, then writes the row. `status` on the
 * receipt is the honest outcome: `approved` when a confirming human held the
 * review floor, `proposed` when the write still needs in-app review.
 */
export async function commitMemoryCommand(
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: MemoryCommand,
  channel: ProvenanceChannel,
): Promise<Response> {
  const projectId = cs.projectId
  const wasStaged = cs.status === 'staged'

  // Receipt-only paths mint no internal token, so re-assert the scope ceiling.
  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    return toErrorResponse(err)
  }

  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  const requiredRole = memoryCommandFloor(cmd)
  if (!role || role.level < requiredRole) {
    return errorResponse('permission_denied', `insufficient project role for ${cmd.kind}`, {
      requiredRole,
    })
  }

  const path = cs.plannedIds?.memory?.path ?? (await memoryPathFor(cmd))

  // A retry re-enters after its own partial apply, so the "already retired" /
  // "already superseded" states it created must not read as a fresh failure.
  if (wasStaged) {
    const guard = await guardMemoryTarget(db, projectId, cmd, path)
    if (guard) return guard
  }

  const gate = await receiptOnlyGates(db, cs)
  if (gate instanceof Response) return gate
  const { confirmationId } = gate

  if (cmd.kind === 'RetireExample') {
    const retired = await retireMemory(db, { projectId, path, reviewedBy: String(cred.userId) })
    if (retired.status === 'human_edited') {
      return errorResponse(
        'permission_denied',
        `${path} was edited by a human — retire it from the in-app Memory surface instead`,
        { path },
      )
    }
    // not_found on a retry = our own earlier attempt already archived it.
    if (retired.status === 'not_found' && wasStaged) {
      return errorResponse('not_found', `no approved example at ${path} to retire`, { path })
    }
    return finishMemoryReceipt(db, cred, cs, projectId, path, 'archived', confirmationId, channel)
  }

  // The changeset's human confirmation stands in for the Memory-tab review —
  // but only at the authority that review actually requires.
  const approve = confirmationId !== null && role.level >= MEMORY_REVIEW_ROLE

  const memoryId = cs.plannedIds?.memory?.memoryId ?? crypto.randomUUID()
  // Pinned at prepare, so a crash-retry finds ITS OWN row instead of inserting
  // a duplicate proposal.
  const existing = await getMemory(db, memoryId)
  if (!existing) {
    const created = await createProposal(db, {
      id: memoryId,
      projectId,
      path,
      content: renderMemoryContent(cmd),
      rationale: cmd.rationale ?? null,
      provenance: { credentialId: cred.credentialId },
      createdBy: String(cred.userId),
    })
    if (created.status === 'validation_failed') {
      return errorResponse('validation_failed', created.message, { path })
    }
  }

  if (!approve) {
    return finishMemoryReceipt(db, cred, cs, projectId, path, 'proposed', confirmationId, channel)
  }

  const reviewed = await reviewMemory(db, {
    id: memoryId,
    action: 'approve',
    reviewedBy: String(cred.userId),
  })
  if (reviewed.status === 'supersedes_human_edited') {
    return errorResponse(
      'permission_denied',
      `${path} is held by a human-edited memory — edit it in the in-app Memory surface instead`,
      { path },
    )
  }
  // invalid_state on a retry = our own earlier attempt already approved it.
  // reviewMemory('approve') only ever yields 'approved' on the ok path; the
  // widen-to-MemoryStatus is a type artifact, so re-narrow rather than
  // reporting a status this branch cannot produce.
  const status = reviewed.status === 'ok' && reviewed.memory.status === 'proposed' ? 'proposed' : 'approved'
  return finishMemoryReceipt(db, cred, cs, projectId, path, status, confirmationId, channel)
}

async function finishMemoryReceipt(
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  projectId: string,
  path: string,
  status: 'proposed' | 'approved' | 'archived',
  confirmationId: string | null,
  channel: ProvenanceChannel,
): Promise<Response> {
  const receipt: MemoryWriteReceipt = {
    credentialId: cred.credentialId,
    channel,
    changesetId: cs.id,
    command: cs.commands[0].kind as MemoryCommand['kind'],
    appliedAt: new Date().toISOString(),
    projectId,
    memoryPath: path,
    memoryStatus: status,
    ...(status === 'proposed'
      ? { note: 'landed as a proposal — a project lead must approve it in the in-app Memory surface before the copilot reads it' }
      : {}),
  }
  await writeCommittedReceipt(db, cs.id, receipt, confirmationId)
  return Response.json({ receipt })
}
