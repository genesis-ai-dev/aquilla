// /api/v1/projects/:projectId/drive-links — link a Google Drive folder.
//
//   GET                       the project's links + the service-account email
//                             a folder must be shared with (any member)
//   POST   {folder}           link a folder (URL or id) and start its poller
//   DELETE /:linkId           unlink; the poller stops on its next pass
//   POST   /:linkId/sync      run one pass now and return what it did
//
// Writes need PROJECT_LEAD: a linked folder writes source revisions as the
// lead who linked it (see drive-folder-sync.ts).

import { withCors } from '../cors'
import { verifyTokenForProject } from '../auth'
import { ROLE } from '../events/role-policy'
import { uuidv7 } from '../external/uuid'
import { parseServiceAccountKey, serviceAccountAccessToken } from './google-auth'
import { driveFolderIdFromInput, getDriveFolder, mayLinkDriveFolder, type DriveFolder } from './drive-api'

const LIST_RE = /^\/api\/v1\/projects\/([^/]+)\/drive-links$/
const ONE_RE = /^\/api\/v1\/projects\/([^/]+)\/drive-links\/([^/]+)$/
const SYNC_RE = /^\/api\/v1\/projects\/([^/]+)\/drive-links\/([^/]+)\/sync$/

export interface DriveLinksEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  GOOGLE_SERVICE_ACCOUNT_JSON?: string
  DriveFolderPoller?: DurableObjectNamespace
  ENVIRONMENT?: string
}

interface LinkRow {
  id: string
  folder_id: string
  folder_name: string | null
  username: string
  last_synced_at: number | string | null
  last_error: string | null
  created_at: number | string
  file_count: number | string
}

function serviceAccountEmail(env: DriveLinksEnv): string | null {
  try {
    return parseServiceAccountKey(env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email
  } catch {
    return null
  }
}

function pollerStub(env: DriveLinksEnv, linkId: string): DurableObjectStub {
  if (!env.DriveFolderPoller) throw new Error('DriveFolderPoller not bound')
  return env.DriveFolderPoller.get(env.DriveFolderPoller.idFromName(linkId))
}

async function pollerCall(env: DriveLinksEnv, linkId: string, path: string, body?: unknown): Promise<Response> {
  return pollerStub(env, linkId).fetch(`http://drive-poller.internal${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SYNC_SECRET_KEY}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

export async function handleDriveLinksRequest(request: Request, env: DriveLinksEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname
  const sync = SYNC_RE.exec(path)
  const one = sync ? null : ONE_RE.exec(path)
  const list = sync || one ? null : LIST_RE.exec(path)
  const match = sync ?? one ?? list
  if (!match) return null
  if (request.method === 'OPTIONS') return null
  const reply = (body: BodyInit | null, status = 200) => withCors(new Response(body, { status }), request)
  const json = (body: unknown, status = 200) => withCors(Response.json(body, { status }), request)
  if (!env.AQUILLA_PG) return reply('AQUILLA_PG binding not configured', 500)
  const db = env.AQUILLA_PG
  const projectId = decodeURIComponent(match[1])

  const header = request.headers.get('Authorization') ?? ''
  const auth = await verifyTokenForProject(header.startsWith('Bearer ') ? header.slice(7) : null, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return reply(auth.reason, auth.status)
  const isLead = auth.claims.role >= ROLE.PROJECT_LEAD

  if (list && request.method === 'GET') {
    const rows = await db
      .prepare(
        `SELECT l.id, l.folder_id, l.folder_name, l.username, l.last_synced_at, l.last_error, l.created_at,
                (SELECT COUNT(*) FROM drive_folder_files f WHERE f.link_id = l.id) AS file_count
         FROM drive_folder_links l WHERE l.project_id = ? ORDER BY l.created_at`,
      )
      .bind(projectId)
      .all<LinkRow>()
    return json({
      serviceAccountEmail: serviceAccountEmail(env),
      links: (rows.results ?? []).map((row) => ({
        id: row.id,
        folderId: row.folder_id,
        folderName: row.folder_name,
        linkedBy: row.username,
        lastSyncedAt: row.last_synced_at == null ? null : Number(row.last_synced_at),
        lastError: row.last_error,
        fileCount: Number(row.file_count),
      })),
    })
  }

  if (!isLead) return reply('only a project lead can change Drive links', 403)

  if (list && request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { folder?: unknown } | null
    const folderId = typeof body?.folder === 'string' ? driveFolderIdFromInput(body.folder) : null
    if (!folderId) return reply('folder must be a Google Drive folder link or id', 400)
    const email = serviceAccountEmail(env)
    if (!email) return reply('Drive sync is not configured on this server (GOOGLE_SERVICE_ACCOUNT_JSON)', 503)
    let folder: DriveFolder
    try {
      const token = await serviceAccountAccessToken(parseServiceAccountKey(env.GOOGLE_SERVICE_ACCOUNT_JSON))
      folder = await getDriveFolder(token, folderId)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return json({ error: `Cannot open that folder. Share it with ${email} (Viewer is enough). ${detail}` }, 422)
    }
    const user = await db.prepare('SELECT email FROM users WHERE id = ?').bind(auth.claims.userId).first<{ email: string | null }>()
    if (!mayLinkDriveFolder(folder, user?.email, env.ENVIRONMENT)) {
      return json({ error: 'Only an owner or editor of this folder in Google Drive can link it. Sign in to Aquilla with the same email you use in Drive.' }, 403)
    }
    const existing = await db
      .prepare('SELECT id FROM drive_folder_links WHERE project_id = ? AND folder_id = ?')
      .bind(projectId, folder.id)
      .first<{ id: string }>()
    const linkId = existing?.id ?? uuidv7()
    if (!existing) {
      await db
        .prepare(
          `INSERT INTO drive_folder_links (id, project_id, folder_id, folder_name, user_id, username, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(linkId, projectId, folder.id, folder.name, auth.claims.userId, auth.claims.username ?? `user:${auth.claims.userId}`, Date.now())
        .run()
    }
    const started = await pollerCall(env, linkId, '/start', { linkId })
    if (!started.ok) return reply(`link saved but the poller did not start (HTTP ${started.status})`, 502)
    return json({ id: linkId, folderId: folder.id, folderName: folder.name }, existing ? 200 : 201)
  }

  const linkId = decodeURIComponent((sync ?? one)?.[2] ?? '')
  const link = linkId
    ? await db.prepare('SELECT id FROM drive_folder_links WHERE id = ? AND project_id = ?').bind(linkId, projectId).first<{ id: string }>()
    : null

  if (one && request.method === 'DELETE') {
    if (!link) return reply('link not found', 404)
    await db.prepare('DELETE FROM drive_folder_links WHERE id = ? AND project_id = ?').bind(linkId, projectId).run()
    return reply(null, 204)
  }

  if (sync && request.method === 'POST') {
    if (!link) return reply('link not found', 404)
    const response = await pollerCall(env, linkId, '/sync-now')
    return withCors(new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json' } }), request)
  }

  return reply('method not allowed', 405)
}
