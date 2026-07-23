// GET /migrate/org-team-maps — org + team placement maps for the content
// migration, read from NEON (the live datastore).
//
// The sweep used to read these via `wrangler d1 execute aquilla-db` (loadOrgMap /
// loadTeamMap). After the D1→Neon cutover that D1 is a frozen pre-cutover
// snapshot, so the content pass would resolve placement against stale data and
// skip anything created since. This endpoint reads the same two maps from Neon
// (env.AQUILLA_PG), keyed by legacy_uuid, gated on SYNC_SECRET_KEY — same trust
// tier as the other /migrate routes.

import { secureCompare } from '../lib/secure-compare'

const PATH = '/migrate/org-team-maps'

export interface MigrateOrgTeamMapsEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

interface OrgRow {
  legacy_uuid: string
  id: number
  owner_user_id: number
}
interface GroupRow {
  legacy_uuid: string
  id: number
}

export async function handleMigrateOrgTeamMapsRequest(
  request: Request,
  env: MigrateOrgTeamMapsEnv,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== PATH) return null
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })
  if (!env.SYNC_SECRET_KEY) return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  if (!secureCompare(request.headers.get('Authorization') ?? '', `Bearer ${env.SYNC_SECRET_KEY}`)) {
    return new Response('unauthorized', { status: 401 })
  }
  if (!env.AQUILLA_PG) return new Response('AQUILLA_PG binding not configured', { status: 500 })
  const db = env.AQUILLA_PG

  const orgs = (
    await db
      .prepare('SELECT legacy_uuid, id, owner_user_id FROM organizations WHERE legacy_uuid IS NOT NULL')
      .all<OrgRow>()
  ).results
  const groups = (
    await db.prepare('SELECT legacy_uuid, id FROM groups WHERE legacy_uuid IS NOT NULL').all<GroupRow>()
  ).results

  return Response.json({
    orgs: orgs.map((r) => ({ legacyUuid: r.legacy_uuid, id: Number(r.id), ownerUserId: Number(r.owner_user_id) })),
    groups: groups.map((r) => ({ legacyUuid: r.legacy_uuid, id: Number(r.id) })),
  })
}
