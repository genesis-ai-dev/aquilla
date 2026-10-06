// POST /migrate/project — trusted project + team-grant upsert for migration.
//
// The sweep used to create the project row and its group_project_grants via
// `wrangler d1 execute --remote` (a multi-second subprocess spawn per project).
// Under cross-project concurrency that meant N simultaneous wrangler procs all
// hammering the database over HTTP per write. This endpoint does the same two writes as a single
// parameterized d1.batch (no inline-SQL size concern, no subprocess), gated on
// SYNC_SECRET_KEY — same trust tier as /migrate/ingest.
//
// Idempotent: both INSERTs are ON CONFLICT DO NOTHING, keyed on the project's
// deterministic id and (group_id, project_id).

import { isAuthorizedAdminBearer } from '../lib/admin-auth'
import { ensureProjectLaneStmts, retryingLaneIdCollision } from '../../../db/shared/lanes'
import { projectIdFor } from '../../../src/lib/migrate/ids'

const PATH = '/migrate/project'

export interface MigrateProjectEnv {
  AQUILLA_PG?: AquillaDb
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
}

interface Body {
  projectId: string
  name: string
  orgId: number
  ownerUserId: number
  teamId?: number | null
  roleLevel?: number
}

function isBody(x: unknown): x is Body {
  if (typeof x !== 'object' || x === null) return false
  const b = x as Record<string, unknown>
  return (
    typeof b.projectId === 'string' &&
    typeof b.name === 'string' &&
    typeof b.orgId === 'number' &&
    typeof b.ownerUserId === 'number'
  )
}

export async function handleMigrateProjectRequest(
  request: Request,
  env: MigrateProjectEnv,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== PATH) return null
  if (request.method !== 'POST' && request.method !== 'GET') return new Response('method not allowed', { status: 405 })
  if (!env.SYNC_SECRET_KEY) return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  if (!isAuthorizedAdminBearer(request.headers.get('Authorization') ?? '', env)) {
    return new Response('unauthorized', { status: 401 })
  }
  if (!env.AQUILLA_PG) return new Response('AQUILLA_PG binding not configured', { status: 500 })

  // Identity comes from the immutable GitLab project ID, never a mutable title.
  // This preflight is deliberately read-only; POST remains compatible with the
  // currently running migration daemon, including project lane initialization.
  if (request.method === 'GET') {
    const params = new URL(request.url).searchParams
    const gitlabId = params.get('gitlabId') ?? ''
    const projectId = params.get('projectId') ?? ''
    const orgId = Number(params.get('orgId'))
    const teamId = params.has('teamId') ? Number(params.get('teamId')) : null
    const mustExist = params.get('mustExist')
    if (!/^[1-9][0-9]*$/.test(gitlabId)
      || projectId !== projectIdFor(gitlabId, 'gitlab')
      || !Number.isSafeInteger(orgId) || orgId < 1
      || (teamId !== null && (!Number.isSafeInteger(teamId) || teamId < 1))
      || (mustExist !== 'true' && mustExist !== 'false')) {
      return Response.json({ error: 'Invalid stable project identity or placement' }, { status: 400 })
    }
    const db = env.AQUILLA_PG
    const project = await db.prepare('SELECT id, name, org_id, archived_at FROM projects WHERE id = ?')
      .bind(projectId).first<{ id: string; name: string; org_id: number; archived_at: string | null }>()
    if (project && (Number(project.org_id) !== orgId || project.archived_at !== null)) {
      return Response.json({ error: 'Target project belongs to another org or is archived' }, { status: 409 })
    }
    if (!project && mustExist === 'true') {
      return Response.json({ error: 'Previously migrated project is missing' }, { status: 409 })
    }
    const org = await db.prepare('SELECT id FROM organizations WHERE id = ?').bind(orgId).first()
    if (!org) return Response.json({ error: 'Target organization missing' }, { status: 409 })
    if (teamId !== null) {
      const team = await db.prepare('SELECT org_id FROM groups WHERE id = ?')
        .bind(teamId).first<{ org_id: number }>()
      if (!team || Number(team.org_id) !== orgId) {
        return Response.json({ error: 'Target team missing or belongs to another org' }, { status: 409 })
      }
      if (project) {
        const grant = await db.prepare('SELECT group_id FROM group_project_grants WHERE project_id = ? AND group_id = ?')
          .bind(projectId, teamId).first()
        if (!grant) return Response.json({ error: 'Existing project lacks expected team grant; reconcile placement explicitly' }, { status: 409 })
      }
    }
    return Response.json({ safetyVersion: 1, projectId, exists: !!project, name: project?.name ?? null })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }
  if (!isBody(body)) {
    return new Response('body must be { projectId, name, orgId, ownerUserId, teamId? }', { status: 400 })
  }

  const db = env.AQUILLA_PG
  try {
    await retryingLaneIdCollision(async () => {
      const stmts: AquillaStatement[] = [
        db
          .prepare(
            `INSERT INTO projects (id, name, org_id, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO NOTHING`,
          )
          .bind(body.projectId, body.name, body.orgId, body.ownerUserId),
      ]
      if (typeof body.teamId === 'number') {
        stmts.push(
          db
            .prepare(
              `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by, granted_at)
               VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(group_id, project_id) DO NOTHING`,
            )
            .bind(body.teamId, body.projectId, body.roleLevel ?? 400, body.ownerUserId),
        )
      }
      stmts.push(...ensureProjectLaneStmts(db, body.projectId))
      await db.batch(stmts)
    })
  } catch (err) {
    console.error("[migrate-project] upsert failed:", err)
    return Response.json({ error: "project upsert failed" }, { status: 500 })
  }
  return Response.json({ ok: true })
}
