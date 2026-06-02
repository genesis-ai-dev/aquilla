// POST /migrate/project — trusted project + team-grant upsert for migration.
//
// The sweep used to create the project row and its group_project_grants via
// `wrangler d1 execute --remote` (a multi-second subprocess spawn per project).
// Under cross-project concurrency that meant N simultaneous wrangler procs all
// hammering the D1 HTTP API. This endpoint does the same two writes as a single
// parameterized d1.batch (no inline-SQL size concern, no subprocess), gated on
// SYNC_SECRET_KEY — same trust tier as /migrate/ingest.
//
// Idempotent: both INSERTs are ON CONFLICT DO NOTHING, keyed on the project's
// deterministic id and (group_id, project_id).

const PATH = '/migrate/project'

export interface MigrateProjectEnv {
  AQUILLA_DB?: D1Database
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
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
  if (!env.SYNC_SECRET_KEY) return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  if ((request.headers.get('Authorization') ?? '') !== `Bearer ${env.SYNC_SECRET_KEY}`) {
    return new Response('unauthorized', { status: 401 })
  }
  if (!env.AQUILLA_DB) return new Response('AQUILLA_DB binding not configured', { status: 500 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }
  if (!isBody(body)) {
    return new Response('body must be { projectId, name, orgId, ownerUserId, teamId? }', { status: 400 })
  }

  const db = env.AQUILLA_DB
  const stmts: D1PreparedStatement[] = [
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

  try {
    await db.batch(stmts)
  } catch (err) {
    return Response.json({ error: `project upsert failed: ${String(err)}` }, { status: 500 })
  }
  return Response.json({ ok: true })
}
