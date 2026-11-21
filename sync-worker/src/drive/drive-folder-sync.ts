// One pass of the Google Drive folder sync (AQU-2459 increment 5).
//
// For each Word file or Google Doc in a linked folder whose Drive `version`
// moved since the last pass: fetch it as .docx, hash it, and — when the bytes
// changed — parse it and write ONE file revision. A Drive file seen for the
// first time becomes a new Aquilla file. Translations stay on their paragraphs
// because the revisions route aligns by content, and open editors reload on
// the `file.progress.updated` frame that route already sends.
//
// The pass goes through the SAME routes as the browser importer (/import,
// PUT …/source, POST …/revisions), called in-process with a short-lived sync
// token minted for the user who made the link, at that user's LIVE project
// role — the pattern `external/token-bridge.ts` uses for the Agent API. So the
// sync can never do more than that user could do by uploading the file again.

import { sign } from 'hono/jwt'
import { uuidv7 } from '../external/uuid'
import type { SyncTokenClaims } from '../auth'
import { ROLE } from '../events/role-policy'
import { handleBulkImportRequest, type ImportRouteEnv } from '../events/import-route'
import { handleSourceUploadRequest } from '../events/source-upload-route'
import { handleRevisionsRequest, type RevisionsRouteEnv } from '../events/revisions-route'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import { loadProjectSettings } from '../../../db/shared/projects'
import type { CellUnit } from '../../../src/lib/parsers/core-types'
import { parseServiceAccountKey, serviceAccountAccessToken } from './google-auth'
import {
  aquillaFileName,
  downloadDriveFileAsDocx,
  getDriveFolder,
  GOOGLE_DOC_MIME,
  isSyncableDriveFile,
  listDriveFolder,
  mayLinkDriveFolder,
  type DriveFile,
} from './drive-api'
import { docxRevisionUnits } from './drive-units'

export type DriveSyncEnv = ImportRouteEnv & RevisionsRouteEnv & {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  GOOGLE_SERVICE_ACCOUNT_JSON?: string
  ENVIRONMENT?: string
}

export interface DriveLinkRow {
  id: string
  project_id: string
  folder_id: string
  user_id: number | string
  username: string
}

interface CursorRow {
  drive_file_id: string
  file_id: string
  drive_version: string
  artifact_sha256: string | null
}

export interface DriveSyncResult {
  /** False when the link row is gone (the poller stops). */
  linked: boolean
  created: string[]
  revised: string[]
  unchanged: number
  errors: string[]
}

export interface DriveSyncDeps {
  fetchFn?: typeof fetch
  now?: () => number
  ctx?: ExecutionContext
}

const TOKEN_TTL_SECONDS = 300

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function callRoute(
  label: string,
  handler: () => Promise<Response | null>,
): Promise<Response> {
  const response = await handler()
  if (!response) throw new Error(`${label}: route did not match`)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`${label} failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  return response
}

export async function syncDriveFolderLink(env: DriveSyncEnv, linkId: string, deps: DriveSyncDeps = {}): Promise<DriveSyncResult> {
  const db = env.AQUILLA_PG
  if (!db) throw new Error('AQUILLA_PG binding not configured')
  if (!env.SYNC_SECRET_KEY) throw new Error('SYNC_SECRET_KEY not configured')
  const fetchFn = deps.fetchFn ?? fetch
  const now = deps.now ?? Date.now
  const result: DriveSyncResult = { linked: true, created: [], revised: [], unchanged: 0, errors: [] }

  const link = await db
    .prepare('SELECT id, project_id, folder_id, user_id, username FROM drive_folder_links WHERE id = ?')
    .bind(linkId)
    .first<DriveLinkRow>()
  if (!link) return { ...result, linked: false }

  try {
    // The link writes as its creator, at their role NOW: a lead who was
    // removed or demoted stops the sync instead of keeping a write path.
    const role = await resolveProjectRoleShared(db, { id: String(link.user_id) }, link.project_id)
    if (!role || role.level < ROLE.PROJECT_LEAD) {
      throw new Error(`${link.username} is no longer a project lead on this project`)
    }
    const mintToken = (fileId: string): Promise<string> => {
      const iat = Math.floor(now() / 1000)
      const claims: SyncTokenClaims = {
        userId: Number(link.user_id),
        username: link.username,
        projectId: link.project_id,
        fileId,
        role: role.level,
        src: role.source,
        aud: 'sync',
        iat,
        exp: iat + TOKEN_TTL_SECONDS,
      }
      return sign(claims as unknown as Record<string, unknown>, env.SYNC_SECRET_KEY as string, 'HS256')
    }

    const accessToken = await serviceAccountAccessToken(parseServiceAccountKey(env.GOOGLE_SERVICE_ACCOUNT_JSON), fetchFn, now)
    // Re-checked every pass: someone who loses edit access to the folder in
    // Drive stops feeding it into this project.
    const user = await db.prepare('SELECT email FROM users WHERE id = ?').bind(link.user_id).first<{ email: string | null }>()
    if (!mayLinkDriveFolder(await getDriveFolder(accessToken, link.folder_id, fetchFn), user?.email, env.ENVIRONMENT)) {
      throw new Error(`${link.username} is no longer an owner or editor of this folder in Google Drive`)
    }
    const driveFiles = (await listDriveFolder(accessToken, link.folder_id, fetchFn)).filter(isSyncableDriveFile)
    const cursorRows = await db
      .prepare('SELECT drive_file_id, file_id, drive_version, artifact_sha256 FROM drive_folder_files WHERE link_id = ?')
      .bind(link.id)
      .all<CursorRow>()
    const cursor = new Map((cursorRows.results ?? []).map((row) => [row.drive_file_id, row]))
    const { settings } = await loadProjectSettings(db, link.project_id)
    const cellUnit = settings.importCellUnit === 'paragraph' || settings.importCellUnit === 'sentence'
      ? (settings.importCellUnit as CellUnit)
      : undefined

    for (const driveFile of driveFiles) {
      const prev = cursor.get(driveFile.id)
      if (prev && prev.drive_version === driveFile.version) {
        result.unchanged++
        continue
      }
      try {
        const outcome = await syncOneFile(env, db, link, driveFile, prev ?? null, { accessToken, mintToken, fetchFn, now, cellUnit, ctx: deps.ctx })
        if (outcome === 'created') result.created.push(driveFile.name)
        else if (outcome === 'revised') result.revised.push(driveFile.name)
        else result.unchanged++
      } catch (err) {
        result.errors.push(`${driveFile.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err))
  }

  await db
    .prepare('UPDATE drive_folder_links SET last_synced_at = ?, last_error = ? WHERE id = ?')
    .bind(now(), result.errors.length > 0 ? result.errors.join('\n').slice(0, 2000) : null, link.id)
    .run()
  return result
}

interface SyncOneDeps {
  accessToken: string
  mintToken: (fileId: string) => Promise<string>
  fetchFn: typeof fetch
  now: () => number
  cellUnit: CellUnit | undefined
  ctx?: ExecutionContext
}

async function syncOneFile(
  env: DriveSyncEnv,
  db: AquillaDb,
  link: DriveLinkRow,
  driveFile: DriveFile,
  prev: CursorRow | null,
  deps: SyncOneDeps,
): Promise<'created' | 'revised' | 'unchanged'> {
  const projectId = link.project_id
  const bytes = await downloadDriveFileAsDocx(deps.accessToken, driveFile, deps.fetchFn)
  const sha = await sha256Hex(bytes)

  // A file someone deleted in Aquilla stays deleted: the sync does not bring
  // it back on the next Drive edit. Unlink the folder to stop syncing it.
  if (prev) {
    const target = await db
      .prepare('SELECT deleted_at FROM files WHERE id = ? AND project_id = ?')
      .bind(prev.file_id, projectId)
      .first<{ deleted_at: number | null }>()
    if (!target || target.deleted_at != null) {
      await saveCursor(db, link.id, driveFile, prev.file_id, prev.artifact_sha256, deps.now())
      return 'unchanged'
    }
    if (prev.artifact_sha256 === sha) {
      await saveCursor(db, link.id, driveFile, prev.file_id, sha, deps.now())
      return 'unchanged'
    }
  }

  const name = aquillaFileName(driveFile)
  const revision = await docxRevisionUnits(bytes, { fileName: name, cellUnit: deps.cellUnit })
  const fileId = prev?.file_id ?? uuidv7()
  const token = await deps.mintToken(fileId)
  const origin = {
    provider: 'google-drive',
    driveFileId: driveFile.id,
    mimeType: driveFile.mimeType,
    ...(driveFile.mimeType === GOOGLE_DOC_MIME ? { exportedAs: 'docx' } : {}),
    folderLinkId: link.id,
  }
  const fileMeta = {
    id: uuidv7(),
    name,
    fileType: 'docx',
    role: 'source',
    kind: 'docx',
    importFormat: 'docx',
    parserVersion: revision.stamp,
    importManifest: { ...revision.importManifest, origin },
    orderedBy: 'sequence',
  }
  const auth = { Authorization: `Bearer ${token}` }
  const origin_ = 'https://drive-sync.internal'
  const stageEventId = uuidv7()
  const publishEventId = uuidv7()

  if (!prev) {
    // 1. The file row alone, staged hidden (as the browser's revision import).
    await callRoute('create file', () => handleBulkImportRequest(
      new Request(`${origin_}/import`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, fileId, cells: [], clientTs: deps.now(), file: fileMeta, stageEventId }),
      }),
      env,
      deps.ctx,
    ))
  }

  // 2. The original bytes, checksum-verified into R2.
  const artifactId = uuidv7()
  await callRoute('store original', () => handleSourceUploadRequest(
    new Request(`${origin_}/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/source`, {
      method: 'PUT',
      headers: {
        ...auth,
        'Content-Type': 'application/octet-stream',
        'X-Source-Format': 'docx',
        'X-Source-Size': String(bytes.byteLength),
        'X-Source-Sha256': sha,
        'X-Artifact-Id': artifactId,
        'X-Artifact-Name': encodeURIComponent(name),
        'X-Artifact-Binding-Role': 'source',
        'X-Artifact-Profile-Id': 'builtin:docx',
        'X-Artifact-Profile-Version': '1',
        'X-Artifact-Fidelity': revision.importManifest.fidelity,
        // A revision moves the source pointer itself, in its own batch.
        ...(prev ? { 'X-Update-Source-Sidecar': 'false' } : {}),
      },
      body: bytes,
    }),
    env,
  ))

  // 3. The units, as one revision naming that artifact.
  await callRoute('write revision', () => handleRevisionsRequest(
    new Request(`${origin_}/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/revisions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        artifactSha256: sha,
        stamp: revision.stamp,
        origin: prev ? 'drive' : 'import',
        units: revision.units,
        ...(prev
          ? { file: fileMeta, artifactId, rawSourceFormat: 'docx' }
          : { finalizeFollows: true }),
      }),
    }),
    env,
    deps.ctx,
  ))

  if (!prev) {
    // 4. Finalize: counters, progress, and the reveal that shows the file.
    await callRoute('publish file', () => handleBulkImportRequest(
      new Request(`${origin_}/import`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, fileId, cells: [], complete: true, publishEventId, clientTs: deps.now() }),
      }),
      env,
      deps.ctx,
    ))
  }

  await saveCursor(db, link.id, driveFile, fileId, sha, deps.now())
  return prev ? 'revised' : 'created'
}

async function saveCursor(db: AquillaDb, linkId: string, driveFile: DriveFile, fileId: string, sha: string | null, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drive_folder_files (link_id, drive_file_id, file_id, drive_version, artifact_sha256, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (link_id, drive_file_id) DO UPDATE SET
         file_id = EXCLUDED.file_id, drive_version = EXCLUDED.drive_version,
         artifact_sha256 = EXCLUDED.artifact_sha256, updated_at = EXCLUDED.updated_at`,
    )
    .bind(linkId, driveFile.id, fileId, driveFile.version, sha, now)
    .run()
}
