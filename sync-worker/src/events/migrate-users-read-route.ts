// GET /migrate/users — minimal user directory (id, username, email) read from
// Neon for the migration's GitLab-member → aquilla-user resolution. Replaces the
// old `wrangler d1 execute aquilla-db` users read (stale post-cutover). Gated on
// SYNC_SECRET_KEY.

import { isAuthorizedAdminBearer } from '../lib/admin-auth'

const PATH = '/migrate/users'

export interface MigrateUsersReadEnv {
  AQUILLA_PG?: AquillaDb
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
}

export async function handleMigrateUsersReadRequest(
  request: Request,
  env: MigrateUsersReadEnv,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== PATH) return null
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })
  if (!env.SYNC_SECRET_KEY) return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  if (!isAuthorizedAdminBearer(request.headers.get('Authorization') ?? '', env)) {
    return new Response('unauthorized', { status: 401 })
  }
  if (!env.AQUILLA_PG) return new Response('AQUILLA_PG binding not configured', { status: 500 })

  const rows = (
    await env.AQUILLA_PG.prepare('SELECT id, username, email FROM users').all<{
      id: number
      username: string | null
      email: string | null
    }>()
  ).results
  return Response.json({
    users: rows.map((r) => ({ id: Number(r.id), username: r.username, email: r.email })),
  })
}
