// Project-lifecycle commands (AQU-1182, parity epic AQU-1181 item 21) —
// RenameProject / ArchiveProject / UnarchiveProject.
//
// These are RECEIPT-ONLY commands in the CreateProject / UpdateProjectSettings
// family (design §2, D8): the project row is not event-sourced, so they apply a
// plain guarded row write rather than compiling events, and the changeset's
// receipt is a provenance stamp instead of an event-id list. Everything else —
// the staged→committing state machine, the ask-mode human approval gate, the
// credential-scope ceiling, the live-role re-check at commit — is the shared
// pipeline every other command uses.
//
// The row writes MIRROR auth-worker's own project endpoints byte for byte
// (routes/projects.ts): PATCH /:projectId (rename, maintainer+),
// POST /:projectId/archive and DELETE /:projectId/archive (owner-only). Role
// resolution uses the archived-tolerant resolver those endpoints use — an owner
// still owns a trashed project, and the ordinary resolver denies every archived
// row, which would make unarchive unreachable by construction.
//
// Project DELETE is deliberately NOT here and stays UI-only: archive is
// recoverable, delete is not, and nothing on the agent surface should be able to
// destroy a project irreversibly.

import { errorResponse, toErrorResponse } from './errors'
import {
  markChangesetStale,
  markChangesetSuperseded,
  receiptOnlyGates,
  writeCommittedReceipt,
} from './commit-gates'
import { stageAndRespond } from './stage'
import { assertCredentialScope } from './token-bridge'
import type {
  ChangesetSummary,
  ExternalEnv,
  ProvenanceChannel,
  ReceiptOnlyReceipt,
  StoredChangeset,
} from './types'
import { notifyProjectDo } from '../archive-broadcast'
import { ROLE } from '../events/role-policy'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleIncludingArchivedShared } from '../../../db/shared/project-roles'

/** Rename a project. Applies `UPDATE projects SET name` — the single source of
 *  truth every surface reads, so there is no projection to notify. */
export interface RenameProjectCommand {
  kind: 'RenameProject'
  projectId: string
  /** New name. Trimmed; 1–256 chars, matching auth-worker's rename schema. */
  name: string
}

/** Move a project to Trash (`projects.archived_at`). Recoverable — see
 *  UnarchiveProject. Owner-only, mirroring the UI's archive affordance. */
export interface ArchiveProjectCommand {
  kind: 'ArchiveProject'
  projectId: string
}

/** Restore a project from Trash (clears `projects.archived_at`). Owner-only. */
export interface UnarchiveProjectCommand {
  kind: 'UnarchiveProject'
  projectId: string
}

export type ProjectLifecycleCommand =
  | RenameProjectCommand
  | ArchiveProjectCommand
  | UnarchiveProjectCommand

/** Longest project name auth-worker's rename endpoint accepts. */
export const MAX_PROJECT_NAME_LENGTH = 256

/** Command kinds this module owns — the discriminator prepare/commit route on. */
const LIFECYCLE_KINDS = new Set(['RenameProject', 'ArchiveProject', 'UnarchiveProject'])

export function isProjectLifecycleCommand(c: { kind: string }): c is ProjectLifecycleCommand {
  return LIFECYCLE_KINDS.has(c.kind)
}

export interface ProjectLifecycleValidationIssue {
  index: number
  message: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/**
 * Static role floor, mirroring the UI floor for the SAME action:
 *   RenameProject     → MAINTAINER (auth-worker PATCH /:projectId)
 *   Archive/Unarchive → OWNER      (auth-worker POST|DELETE /:projectId/archive)
 * Re-resolved live at both prepare and commit; this value is also what the
 * command catalog filters the agent's command index on.
 */
export function projectLifecycleFloor(c: ProjectLifecycleCommand): number {
  return c.kind === 'RenameProject' ? ROLE.MAINTAINER : ROLE.OWNER
}

/** Validate one raw project-lifecycle command (shape only — role floors and the
 *  live project state are prepare-time checks). */
export function validateProjectLifecycleCommand(
  c: Record<string, unknown>,
  index: number,
  issues: ProjectLifecycleValidationIssue[],
): ProjectLifecycleCommand | null {
  const kind = c.kind as ProjectLifecycleCommand['kind']
  if (!isNonEmptyString(c.projectId)) {
    issues.push({ index, message: `${kind}.projectId must be a non-empty string` })
    return null
  }
  if (kind !== 'RenameProject') {
    return { kind, projectId: c.projectId }
  }
  if (typeof c.name !== 'string') {
    issues.push({ index, message: 'RenameProject.name must be a string' })
    return null
  }
  // Trim before the length checks, so a whitespace-only name collapses to ""
  // and is rejected — the same rule auth-worker's zod schema applies.
  const name = c.name.trim()
  if (name.length === 0) {
    issues.push({ index, message: 'RenameProject.name must not be empty or whitespace-only' })
    return null
  }
  if (name.length > MAX_PROJECT_NAME_LENGTH) {
    issues.push({
      index,
      message: `RenameProject.name must be at most ${MAX_PROJECT_NAME_LENGTH} characters`,
    })
    return null
  }
  return { kind: 'RenameProject', projectId: c.projectId, name }
}

interface LiveProjectRow {
  name: string
  archived_at: string | null
}

async function loadLiveProject(db: AquillaDb, projectId: string): Promise<LiveProjectRow | null> {
  return db
    .prepare(`SELECT name, archived_at FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<LiveProjectRow>()
}

/**
 * Is the command's intended end-state ALREADY live? Deterministic and exact —
 * the same "no clean check ⇒ not satisfied" bias supersede.ts uses. At prepare
 * this is a validation_failed ("nothing to do"); at commit it is `superseded`,
 * the healthy terminal state for "a human did it by hand first".
 */
function alreadySatisfied(c: ProjectLifecycleCommand, live: LiveProjectRow): string | null {
  switch (c.kind) {
    case 'RenameProject':
      return live.name === c.name ? `project is already named "${c.name}"` : null
    case 'ArchiveProject':
      return live.archived_at != null ? 'project is already archived' : null
    case 'UnarchiveProject':
      return live.archived_at == null ? 'project is not archived' : null
  }
}

/** Human-facing effect summary the /approve/:id page renders. */
function lifecycleSummary(c: ProjectLifecycleCommand, live: LiveProjectRow): ChangesetSummary {
  return {
    command: c.kind,
    projectId: c.projectId,
    projectName: c.kind === 'RenameProject' ? c.name : live.name,
    ...(c.kind === 'RenameProject' ? { previousProjectName: live.name } : {}),
    warnings: [],
  }
}

/**
 * Prepare a project-lifecycle changeset (sole command in its changeset). Runs
 * the same guard sequence commit re-runs: the command's project must be the
 * changeset project, the caller's LIVE role must meet the UI floor for this
 * action, and the intended end-state must not already hold.
 */
export async function prepareProjectLifecycle(
  db: AquillaDb,
  cred: ApiCredentialContext,
  urlProjectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: ProjectLifecycleCommand,
  env: ExternalEnv,
): Promise<Response> {
  if (cmd.projectId !== urlProjectId) {
    return errorResponse(
      'validation_failed',
      `${cmd.kind}.projectId must match the changeset project`,
    )
  }

  const live = await loadLiveProject(db, urlProjectId)
  if (!live) return errorResponse('not_found', `project ${urlProjectId} not found`)

  const denied = await lifecycleRoleDenial(db, cred, urlProjectId, cmd)
  if (denied) return denied

  const blocked = alreadySatisfied(cmd, live)
  if (blocked) return errorResponse('validation_failed', blocked)

  // Human-approved by design, following CreateProject's precedent: FORCE ask
  // mode regardless of the credential's or request's mode, so every
  // agent-initiated project-lifecycle change passes through /approve/:id. These
  // three reshape or retire the whole project — the one class of write where an
  // act-mode credential running unattended is not a speed win but a hazard.
  // `autonomyMode` is intentionally ignored on this path.
  void autonomyMode

  return stageAndRespond(db, env, {
    id,
    projectId: urlProjectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode: 'ask',
    commands: [cmd],
    preconditions: [],
    summary: lifecycleSummary(cmd, live),
    plannedIds: {},
  })
}

/** The per-kind role gate, re-resolved live at prepare AND commit. Returns the
 *  denial response, or null when the caller clears the floor. */
async function lifecycleRoleDenial(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
  cmd: ProjectLifecycleCommand,
): Promise<Response | null> {
  // Archived-tolerant on purpose: an owner still owns a trashed project, and
  // the ordinary resolver returns null for every archived row.
  const role = await resolveProjectRoleIncludingArchivedShared(db, { id: cred.userId }, projectId)
  const required = projectLifecycleFloor(cmd)
  if (!role || role.level < required) {
    return errorResponse('permission_denied', `insufficient project role for ${cmd.kind}`, {
      requiredRole: required,
    })
  }
  return null
}

/**
 * Commit a project-lifecycle changeset (receipt-only). Re-asserts the scope
 * ceiling (this path mints no internal token, so nothing else would), re-checks
 * the live role, re-checks that the end-state has not already been reached by a
 * human, consumes the ask-mode confirmation through the shared gates, and then
 * applies the row write.
 *
 * A crash-retry (status !== 'staged') SKIPS the end-state re-check: our own
 * first attempt legitimately already archived/renamed the project, and reading
 * that back as "someone beat us to it" would misreport a completed apply as
 * superseded. The writes are idempotent, so re-running them converges.
 */
export async function commitProjectLifecycle(
  db: AquillaDb,
  env: ExternalEnv,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: ProjectLifecycleCommand,
  channel: ProvenanceChannel,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  const wasStaged = cs.status === 'staged'
  const projectId = cs.projectId

  // H1 parity with the other receipt-only commands: no internal token is minted
  // on this path, so the credential's scope ceiling is re-asserted here.
  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    return toErrorResponse(err)
  }

  // The project row disappearing between prepare and commit is real drift, not
  // a permission problem — mark the plan stale so it stops being retried.
  const live = await loadLiveProject(db, projectId)
  if (!live) {
    await markChangesetStale(db, cs.id)
    return errorResponse('plan_stale', `project ${projectId} no longer exists`, { status: 'stale' })
  }

  const denied = await lifecycleRoleDenial(db, cred, projectId, cmd)
  if (denied) return denied

  if (wasStaged) {
    const blocked = alreadySatisfied(cmd, live)
    if (blocked) {
      await markChangesetSuperseded(db, cs.id)
      return errorResponse(
        'plan_stale',
        `plan already satisfied — ${blocked}`,
        { status: 'superseded' },
      )
    }
  }

  const gate = await receiptOnlyGates(db, cs)
  if (gate instanceof Response) return gate
  const confirmationId = gate.confirmationId

  try {
    await applyLifecycle(db, cred, projectId, cmd)
  } catch (err) {
    // A failed row write leaves the changeset in 'committing'; a retry re-enters
    // and re-applies idempotently. Surface the reason rather than a bare 500.
    const message = err instanceof Error ? err.message : String(err)
    return errorResponse('job_failed', `${cmd.kind} failed: ${message}`)
  }

  if (cmd.kind !== 'RenameProject') {
    await broadcastArchiveState(env, projectId, cmd.kind === 'ArchiveProject' ? cred.username : null, db, ctx)
  }

  const receipt: ReceiptOnlyReceipt = {
    credentialId: cred.credentialId,
    channel,
    changesetId: cs.id,
    command: cmd.kind,
    appliedAt: new Date().toISOString(),
    projectId,
  }
  await writeCommittedReceipt(db, cs.id, receipt, confirmationId)
  return Response.json({ receipt })
}

/** The row write, mirroring auth-worker routes/projects.ts exactly. */
async function applyLifecycle(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
  cmd: ProjectLifecycleCommand,
): Promise<void> {
  if (cmd.kind === 'RenameProject') {
    await db.prepare(`UPDATE projects SET name = ? WHERE id = ?`).bind(cmd.name, projectId).run()
    return
  }
  if (cmd.kind === 'ArchiveProject') {
    // `AND archived_at IS NULL` keeps a crash-retry from re-stamping a newer
    // archived_at over the first attempt's — same guard auth-worker uses.
    await db
      .prepare(
        `UPDATE projects
            SET archived_at = CURRENT_TIMESTAMP, archived_by = ?
          WHERE id = ? AND archived_at IS NULL`,
      )
      .bind(cred.userId, projectId)
      .run()
    return
  }
  await db
    .prepare(`UPDATE projects SET archived_at = NULL, archived_by = NULL WHERE id = ?`)
    .bind(projectId)
    .run()
}

/**
 * Tell the live ProjectSync DO that the project's archive state changed, so
 * connected clients react the way they do for a UI archive. Best-effort by
 * design (auth-worker fires the same notification through waitUntil and logs
 * failures): the durable truth is the row we just wrote, and a missed broadcast
 * must never fail an applied commit.
 */
async function broadcastArchiveState(
  env: ExternalEnv,
  projectId: string,
  deletedBy: string | null,
  db: AquillaDb,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<void> {
  if (!env.ProjectSync) return
  const row = await loadLiveProject(db, projectId)
  const notify = notifyProjectDo(env, projectId, {
    archivedAt: row?.archived_at ?? null,
    deletedBy,
  }).catch((err: unknown) => {
    console.warn(`[project-lifecycle] ProjectSync notify failed for ${projectId}:`, err)
  })
  if (ctx) ctx.waitUntil(notify)
  else await notify
}
