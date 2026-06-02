// POST /migrate/settings — trusted project_settings UPSERT for migration.
//
// The migration's cast (one Voice per character + a cellId→voiceId map for
// every line) produces a large settings JSON — hundreds of KB for a full
// episode set. That exceeds D1's ~100 KB inline-SQL-statement limit, so the
// operator CLI can't write it with `wrangler d1 execute --command/--file`
// (SQLITE_TOOBIG). This endpoint binds the JSON as a *parameter* (no inline
// size limit) and UPSERTs it server-side, gated on SYNC_SECRET_KEY — same trust
// tier + shape as /migrate/ingest.
//
// Idempotent: re-running overwrites the settings row (and bumps version). The
// CLI reads the current settings first, merges cast additions by name, and
// posts the merged result, so a re-run converges.

const PATH = '/migrate/settings'

export interface MigrateSettingsEnv {
  AQUILLA_DB?: D1Database
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
  if (!isBody(body)) return new Response('body must be { projectId, settings }', { status: 400 })

  const json = JSON.stringify(body.settings)
  try {
    await env.AQUILLA_DB.prepare(
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
