// POST /migrate/settings — trusted project_settings UPSERT for migration.
//
// The migration's cast (one Voice per character + a cellId→voiceId map for
// every line) produces a large settings JSON — hundreds of KB for a full
// episode set. That exceeds a conservative ~100 KB statement-size cap, so the
// operator CLI can't write it with `wrangler d1 execute --command/--file`
// (SQLITE_TOOBIG). This endpoint binds the JSON as a *parameter* (no inline
// size limit) and UPSERTs it server-side, gated on SYNC_SECRET_KEY — same trust
// tier + shape as /migrate/ingest.
//
// Idempotent: re-running overwrites the settings row (and bumps version). The
// CLI reads the current settings first, merges cast additions by name, and
// posts the merged result, so a re-run converges.

import { secureCompare } from '../lib/secure-compare'

const PATH = '/migrate/settings'

export interface MigrateSettingsEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

interface Body {
  projectId: string
  settings: Record<string, unknown>
}

function isBody(x: unknown): x is Body {
  if (typeof x !== 'object' || x === null) return false
  const b = x as Record<string, unknown>
  return typeof b.projectId === 'string' && typeof b.settings === 'object' && b.settings !== null
}

export async function handleMigrateSettingsRequest(
  request: Request,
  env: MigrateSettingsEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== PATH) return null
  if (request.method !== 'POST' && request.method !== 'GET') {
    return new Response('method not allowed', { status: 405 })
  }
  if (!env.SYNC_SECRET_KEY) return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  if (!secureCompare(request.headers.get('Authorization') ?? '', `Bearer ${env.SYNC_SECRET_KEY}`)) {
    return new Response('unauthorized', { status: 401 })
  }
  if (!env.AQUILLA_PG) return new Response('AQUILLA_PG binding not configured', { status: 500 })

  // GET /migrate/settings?projectId=… → { settings } (current row, or {} if none).
  // Lets the sweep read-merge cast over HTTP instead of a `wrangler d1` subprocess.
  if (request.method === 'GET') {
    const projectId = url.searchParams.get('projectId')
    if (!projectId) return new Response('projectId query param required', { status: 400 })
    const row = await env.AQUILLA_PG.prepare(
      `SELECT settings FROM project_settings WHERE project_id = ?`,
    )
      .bind(projectId)
      .first<{ settings: string }>()
    let settings: Record<string, unknown> = {}
    try {
      if (row?.settings) settings = JSON.parse(row.settings)
    } catch {
      /* corrupt row → treat as empty */
    }
    return Response.json({ settings })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }
  if (!isBody(body)) return new Response('body must be { projectId, settings }', { status: 400 })

  const json = JSON.stringify(body.settings)
  try {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_at)
       VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(project_id) DO UPDATE SET
         settings = excluded.settings,
         version = project_settings.version + 1,
         updated_at = CURRENT_TIMESTAMP`,
    )
      .bind(body.projectId, json)
      .run()
  } catch (err) {
    return Response.json({ error: `settings upsert failed: ${String(err)}` }, { status: 500 })
  }
  return Response.json({ ok: true, bytes: json.length })
}
