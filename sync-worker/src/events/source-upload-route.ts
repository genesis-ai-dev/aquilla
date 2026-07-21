// PUT /api/v1/projects/:projectId/files/:fileId/source
//
// Accepts immutable original bytes from the client during import and
// stores them in the SNAPSHOTS R2 bucket. Writes a file_source_blobs pointer
// row so downstream export/diff tooling can retrieve the original without the
// client re-uploading it.
//
// Auth: mirrors import-route.ts — valid aud=sync JWT scoped to (projectId,
// fileId), role >= PROJECT_LEAD (500).  Source writes are importer/lead-only.
//
// Returns null when the path/method doesn't match (router fall-through).

import { withCors } from "../cors"
import { r2KeyPrefix, type AudioEnv } from "../audio"
import { verifyTokenForDoc } from "../auth"
import { ROLE } from "./role-policy"

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/source$/
const BINDING_PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/source-bindings$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// No documented product limit on original-source size; 50 MB comfortably
// covers real DOCX/PPTX imports while capping unbounded R2 writes / memory use.
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024

export interface SourceUploadEnv extends Pick<AudioEnv, "R2_KEY_PREFIX"> {
  SNAPSHOTS: R2Bucket
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

export function sourceObjectKey(
  env: Pick<AudioEnv, "R2_KEY_PREFIX">,
  projectId: string,
  fileId: string,
  format: string,
  artifactId?: string,
): string {
  const knownExtensions: Record<string, string> = {
    docx: "docx",
    pptx: "pptx",
    usfm: "usfm",
    usx: "usx",
    md: "md",
    txt: "txt",
    html: "html",
    json: "json",
    po: "po",
    properties: "properties",
    vtt: "vtt",
    srt: "srt",
    sbv: "sbv",
    xliff: "xlf",
    tmx: "tmx",
    csv: "csv",
    tsv: "tsv",
    "paratext-project": "zip",
    "custom-original": "bin",
  }
  const ext = knownExtensions[format] ?? "bin"
  if (artifactId) {
    return `${r2KeyPrefix(env)}artifacts/${projectId}/${artifactId}/original.${ext}`
  }
  return `${r2KeyPrefix(env)}projects/${projectId}/files/${fileId}/source/original.${ext}`
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    } catch {
      return {}
    }
  }
  return {}
}

function decodedHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim()
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function hasInvalidEncodedHeader(request: Request, name: string): boolean {
  return Boolean(request.headers.get(name)?.trim()) && decodedHeader(request, name) === undefined
}

async function handleSourceBindingRequest(
  request: Request,
  env: SourceUploadEnv,
  match: RegExpExecArray,
): Promise<Response> {
  if (!env.AQUILLA_PG) return withCors(new Response('AQUILLA_PG binding not configured', { status: 500 }), request)
  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])
  const authHeader = request.headers.get('Authorization') ?? ''
  const auth = await verifyTokenForDoc(
    authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null,
    { projectId, fileId },
    env.SYNC_SECRET_KEY,
  )
  if (!auth.ok) return withCors(new Response(auth.reason, { status: auth.status }), request)
  if (auth.claims.role < ROLE.PROJECT_LEAD) {
    return withCors(new Response('role too low for artifact binding', { status: 403 }), request)
  }

  let body: Record<string, unknown>
  try {
    const parsed = await request.json() as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    body = parsed as Record<string, unknown>
  } catch {
    return withCors(new Response('invalid JSON body', { status: 400 }), request)
  }
  const artifactId = typeof body.artifactId === 'string' ? body.artifactId : ''
  const memberPath = typeof body.memberPath === 'string' ? body.memberPath : ''
  const profileId = typeof body.profileId === 'string' ? body.profileId : ''
  const profileVersion = typeof body.profileVersion === 'string' ? body.profileVersion : ''
  const fidelity = typeof body.fidelity === 'string' ? body.fidelity : ''
  if (
    !UUID_RE.test(artifactId)
    || body.bindingRole !== 'support'
    || !profileId
    || !profileVersion
    || profileId.length > 255
    || profileVersion.length > 64
    || !['native', 'verified-recipe', 'content-only', 'preserved-only'].includes(fidelity)
    || memberPath.length > 1024
  ) {
    return withCors(new Response('invalid artifact binding', { status: 400 }), request)
  }
  const file = await env.AQUILLA_PG.prepare(
    `SELECT id FROM files WHERE id = ? AND project_id = ?`,
  ).bind(fileId, projectId).first<{ id: string }>()
  if (!file) return withCors(new Response('file not found', { status: 404 }), request)
  const artifact = await env.AQUILLA_PG.prepare(
    `SELECT id FROM artifacts WHERE id::text = ? AND project_id = ? AND kind = 'source'`,
  ).bind(artifactId, projectId).first<{ id: string }>()
  if (!artifact) return withCors(new Response('artifact not found', { status: 404 }), request)

  try {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO artifact_bindings (
         id, project_id, artifact_id, file_id, binding_role, target_lang,
         member_path, profile_id, profile_version, fidelity, manifest
       ) VALUES (?::uuid, ?, ?::uuid, ?, 'support', '', ?, ?, ?, ?, '{}'::jsonb)
       ON CONFLICT (artifact_id, file_id, binding_role, target_lang, member_path)
       DO UPDATE SET
         profile_id = EXCLUDED.profile_id,
         profile_version = EXCLUDED.profile_version,
         fidelity = EXCLUDED.fidelity,
         updated_at = now()`,
    ).bind(crypto.randomUUID(), projectId, artifactId, fileId, memberPath, profileId, profileVersion, fidelity).run()
  } catch (error) {
    return withCors(Response.json({ error: `Artifact binding failed: ${String(error)}` }, { status: 500 }), request)
  }
  return withCors(Response.json({ ok: true, artifactId, fileId }), request)
}

export async function handleSourceUploadRequest(
  request: Request,
  env: SourceUploadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const bindingMatch = BINDING_PATH_RE.exec(url.pathname)
  if (bindingMatch) {
    if (request.method !== 'POST') return null
    return handleSourceBindingRequest(request, env, bindingMatch)
  }
  const match = PATH_RE.exec(url.pathname)
  if (!match) return null
  if (request.method !== "PUT") return null

  if (!env.AQUILLA_PG) {
    return withCors(new Response("AQUILLA_PG binding not configured", { status: 500 }), request)
  }
  const db = env.AQUILLA_PG

  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])

  // Mirror auth from import-route.ts:147-159.
  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  const auth = await verifyTokenForDoc(
    token,
    { projectId, fileId },
    env.SYNC_SECRET_KEY,
  )
  if (!auth.ok) {
    return withCors(new Response(auth.reason, { status: auth.status }), request)
  }
  if (auth.claims.role < ROLE.PROJECT_LEAD) {
    return withCors(
      new Response("role too low for source upload", { status: 403 }),
      request,
    )
  }

  const format = request.headers.get("X-Source-Format")?.trim().toLowerCase() ?? ""
  if (!/^[a-z0-9][a-z0-9+._-]{0,63}$/.test(format)) {
    return withCors(new Response("invalid source format", { status: 400 }), request)
  }
  const requestedArtifactId = request.headers.get('X-Artifact-Id')?.trim()
  if (requestedArtifactId && !UUID_RE.test(requestedArtifactId)) {
    return withCors(new Response('invalid artifact id', { status: 400 }), request)
  }

  // Reject oversize uploads before buffering the whole body when the client
  // advertises the size; the post-buffer check below is the backstop.
  const declaredLength = Number(request.headers.get("Content-Length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) {
    return withCors(new Response("source too large", { status: 413 }), request)
  }

  const body = await request.arrayBuffer()
  if (body.byteLength === 0) {
    return withCors(new Response("empty body", { status: 400 }), request)
  }
  if (body.byteLength > MAX_SOURCE_BYTES) {
    return withCors(new Response("source too large", { status: 413 }), request)
  }

  const artifactId = requestedArtifactId ?? crypto.randomUUID()
  const key = sourceObjectKey(env, projectId, fileId, format, artifactId)
  const contentTypes: Record<string, string> = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    usfm: "text/plain; charset=utf-8",
    usx: "application/xml; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    html: "text/html; charset=utf-8",
    json: "application/json; charset=utf-8",
    po: "text/x-gettext-translation; charset=utf-8",
    properties: "text/plain; charset=utf-8",
    vtt: "text/vtt; charset=utf-8",
    srt: "application/x-subrip; charset=utf-8",
    sbv: "text/plain; charset=utf-8",
    xliff: "application/xliff+xml",
    tmx: "application/xml",
    csv: "text/csv; charset=utf-8",
    tsv: "text/tab-separated-values; charset=utf-8",
    "paratext-project": "application/zip",
  }
  const contentType = contentTypes[format] ?? "application/octet-stream"
  const bindingRoleHeader = request.headers.get('X-Artifact-Binding-Role')?.trim()
  if (bindingRoleHeader && !['source', 'support'].includes(bindingRoleHeader)) {
    return withCors(new Response('invalid artifact binding role', { status: 400 }), request)
  }
  if (
    hasInvalidEncodedHeader(request, 'X-Artifact-Name')
    || hasInvalidEncodedHeader(request, 'X-Artifact-Member-Path')
  ) {
    return withCors(new Response('invalid encoded artifact metadata', { status: 400 }), request)
  }
  const bindingRole = bindingRoleHeader === 'support' ? 'support' : 'source'
  const artifactName = decodedHeader(request, 'X-Artifact-Name')
  const headerMemberPath = decodedHeader(request, 'X-Artifact-Member-Path')
  const headerProfileId = request.headers.get('X-Artifact-Profile-Id')?.trim()
  const headerProfileVersion = request.headers.get('X-Artifact-Profile-Version')?.trim()
  const headerFidelity = request.headers.get('X-Artifact-Fidelity')?.trim()
  const updateSourceHeader = request.headers.get('X-Update-Source-Sidecar')?.trim()
  if (
    (artifactName && artifactName.length > 1024)
    || (headerMemberPath && headerMemberPath.length > 1024)
    || (headerProfileId && headerProfileId.length > 255)
    || (headerProfileVersion && headerProfileVersion.length > 64)
    || (headerFidelity && !['native', 'verified-recipe', 'content-only', 'preserved-only'].includes(headerFidelity))
    || (updateSourceHeader && !['true', 'false'].includes(updateSourceHeader))
  ) {
    return withCors(new Response('invalid artifact metadata', { status: 400 }), request)
  }
  const updateSourceSidecar = updateSourceHeader !== 'false'
  const sha256 = await sha256Hex(body)

  const file = await db.prepare(
    `SELECT name, meta FROM files WHERE id = ? AND project_id = ?`,
  ).bind(fileId, projectId).first<{ name: string; meta: unknown }>()
  if (!file) {
    return withCors(new Response('file not found', { status: 404 }), request)
  }
  const existing = await db.prepare(
    `SELECT project_id, sha256 FROM artifacts WHERE id::text = ?`,
  ).bind(artifactId).first<{ project_id: string; sha256: string }>()
  if (existing && (existing.project_id !== projectId || existing.sha256 !== sha256)) {
    return withCors(new Response('artifact id already refers to different bytes', { status: 409 }), request)
  }

  const fileMeta = objectRecord(file.meta)
  const manifest = objectRecord(fileMeta.aquillaImport)
  const fidelityValues = new Set(['native', 'verified-recipe', 'content-only', 'preserved-only'])
  const fidelity = headerFidelity && fidelityValues.has(headerFidelity)
    ? headerFidelity
    : typeof manifest.fidelity === 'string' && fidelityValues.has(manifest.fidelity)
      ? manifest.fidelity
      : 'content-only'
  const profileId = headerProfileId
    || (typeof manifest.profileId === 'string' && manifest.profileId
      ? manifest.profileId
      : `legacy:${format}`)
  const profileVersion = headerProfileVersion
    || (typeof manifest.profileVersion === 'string' && manifest.profileVersion ? manifest.profileVersion : '1')
  const memberPath = headerMemberPath
    ?? (typeof manifest.memberPath === 'string' ? manifest.memberPath : '')
  const recipe = manifest.recipe && typeof manifest.recipe === 'object'
    ? JSON.stringify(manifest.recipe)
    : null

  await env.SNAPSHOTS.put(key, body, { httpMetadata: { contentType } })

  const statements: AquillaStatement[] = []
  if (updateSourceSidecar && bindingRole === 'source') {
    statements.push(db.prepare(
      `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT (file_id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         format     = EXCLUDED.format,
         raw_source = NULL,
         r2_key     = EXCLUDED.r2_key,
         size_bytes = EXCLUDED.size_bytes,
         created_at = EXCLUDED.created_at`,
    ).bind(fileId, projectId, format, key, body.byteLength, Date.now()))
  }
  statements.push(
    db.prepare(
      `INSERT INTO artifacts (
         id, project_id, uploaded_by_user_id, credential_id, name, content_type,
         size_bytes, sha256, r2_key, file_id, kind, metadata
       ) VALUES (?::uuid, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'source', ?::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    ).bind(
      artifactId,
      projectId,
      String(auth.claims.userId),
      artifactName ?? file.name,
      contentType,
      body.byteLength,
      sha256,
      key,
      fileId,
      JSON.stringify({ origin: 'browser-import', sourceFormat: format }),
    ),
    db.prepare(
      `INSERT INTO artifact_bindings (
         id, project_id, artifact_id, file_id, binding_role, target_lang,
         member_path, profile_id, profile_version, fidelity, manifest, recipe
       ) VALUES (?::uuid, ?, ?::uuid, ?, ?, '', ?, ?, ?, ?, ?::jsonb, ?::jsonb)
       ON CONFLICT (artifact_id, file_id, binding_role, target_lang, member_path)
       DO UPDATE SET
         profile_id = EXCLUDED.profile_id,
         profile_version = EXCLUDED.profile_version,
         fidelity = EXCLUDED.fidelity,
         manifest = EXCLUDED.manifest,
         recipe = EXCLUDED.recipe,
         updated_at = now()`,
    ).bind(
      crypto.randomUUID(),
      projectId,
      artifactId,
      fileId,
      bindingRole,
      memberPath,
      profileId,
      profileVersion,
      fidelity,
      JSON.stringify(manifest),
      recipe,
    ),
  )
  await db.batch(statements)

  return withCors(
    new Response(JSON.stringify({ ok: true, artifactId, key, sha256 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    request,
  )
}
