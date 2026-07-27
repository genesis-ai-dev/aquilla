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
import {
  MAX_BUFFERED_SOURCE_ARTIFACT_BYTES,
  MAX_SOURCE_ARTIFACT_BYTES,
  sourceArtifactDescriptor,
} from "../../../shared/import-contract"
import { buildSourceArtifactPersistenceStatements } from "./source-artifact-persistence"

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/source$/
const BINDING_PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/source-bindings$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const MAX_SOURCE_BYTES = MAX_SOURCE_ARTIFACT_BYTES
const MAX_LEGACY_BUFFERED_SOURCE_BYTES = MAX_BUFFERED_SOURCE_ARTIFACT_BYTES

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
  const ext = sourceArtifactDescriptor(format).extension
  if (artifactId) {
    return `${r2KeyPrefix(env)}artifacts/${projectId}/${artifactId}/original.${ext}`
  }
  return `${r2KeyPrefix(env)}projects/${projectId}/files/${fileId}/source/original.${ext}`
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

function sha256Bytes(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes.buffer
}

async function readBodyWithLimit(request: Request, limit: number): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel("source too large")
      throw new RangeError("source too large")
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out.buffer
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
  const bindingRole = typeof body.bindingRole === 'string' ? body.bindingRole : ''
  const targetLang = typeof body.targetLang === 'string' ? body.targetLang : ''
  if (
    !UUID_RE.test(artifactId)
    || !['support', 'target'].includes(bindingRole)
    || (bindingRole !== 'target' && targetLang.length > 0)
    || !profileId
    || !profileVersion
    || profileId.length > 255
    || profileVersion.length > 64
    || !['native', 'verified-recipe', 'content-only', 'preserved-only'].includes(fidelity)
    || memberPath.length > 1024
    || targetLang.length > 255
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
       ) VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, '{}'::jsonb)
       ON CONFLICT (artifact_id, file_id, binding_role, target_lang, member_path)
       DO UPDATE SET
         profile_id = EXCLUDED.profile_id,
         profile_version = EXCLUDED.profile_version,
         fidelity = EXCLUDED.fidelity,
         updated_at = now()`,
    ).bind(crypto.randomUUID(), projectId, artifactId, fileId, bindingRole, targetLang, memberPath, profileId, profileVersion, fidelity).run()
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

  const shaHeader = request.headers.get("X-Source-Sha256")?.trim().toLowerCase()
  const sizeHeader = request.headers.get("X-Source-Size")?.trim()
  const hasStreamingHeaders = Boolean(shaHeader || sizeHeader)
  if (
    hasStreamingHeaders
    && (!shaHeader || !/^[0-9a-f]{64}$/.test(shaHeader) || !sizeHeader || !/^\d+$/.test(sizeHeader))
  ) {
    return withCors(new Response("invalid source checksum metadata", { status: 400 }), request)
  }
  const sourceSize = hasStreamingHeaders ? Number(sizeHeader) : undefined
  if (sourceSize !== undefined && (!Number.isSafeInteger(sourceSize) || sourceSize <= 0)) {
    return withCors(new Response("invalid source size", { status: 400 }), request)
  }

  // Reject oversize uploads before reading the body. New clients provide
  // verified size+checksum metadata and stream to R2; legacy clients use the
  // bounded reader below and retain the previous 50 MB memory ceiling.
  const declaredLength = Number(request.headers.get("Content-Length"))
  if (
    (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES)
    || (sourceSize !== undefined && sourceSize > MAX_SOURCE_BYTES)
  ) {
    return withCors(new Response("source too large", { status: 413 }), request)
  }

  let bufferedBody: ArrayBuffer | undefined
  let sha256: string
  let byteLength: number
  if (hasStreamingHeaders) {
    sha256 = shaHeader!
    byteLength = sourceSize!
  } else {
    if (Number.isFinite(declaredLength) && declaredLength > MAX_LEGACY_BUFFERED_SOURCE_BYTES) {
      return withCors(new Response("source too large for legacy buffered upload", { status: 413 }), request)
    }
    try {
      bufferedBody = await readBodyWithLimit(request, MAX_LEGACY_BUFFERED_SOURCE_BYTES)
    } catch (error) {
      if (error instanceof RangeError) {
        return withCors(new Response("source too large", { status: 413 }), request)
      }
      throw error
    }
    if (bufferedBody.byteLength === 0) {
      return withCors(new Response("empty body", { status: 400 }), request)
    }
    byteLength = bufferedBody.byteLength
    sha256 = await sha256Hex(bufferedBody)
  }

  const artifactId = requestedArtifactId ?? crypto.randomUUID()
  const key = sourceObjectKey(env, projectId, fileId, format, artifactId)
  const contentType = sourceArtifactDescriptor(format).contentType
  const bindingRoleHeader = request.headers.get('X-Artifact-Binding-Role')?.trim()
  if (bindingRoleHeader && !['source', 'target', 'support'].includes(bindingRoleHeader)) {
    return withCors(new Response('invalid artifact binding role', { status: 400 }), request)
  }
  if (
    hasInvalidEncodedHeader(request, 'X-Artifact-Name')
    || hasInvalidEncodedHeader(request, 'X-Artifact-Member-Path')
    || hasInvalidEncodedHeader(request, 'X-Artifact-Target-Lang')
  ) {
    return withCors(new Response('invalid encoded artifact metadata', { status: 400 }), request)
  }
  const bindingRole = bindingRoleHeader === 'support'
    ? 'support'
    : bindingRoleHeader === 'target'
      ? 'target'
      : 'source'
  const artifactName = decodedHeader(request, 'X-Artifact-Name')
  const headerMemberPath = decodedHeader(request, 'X-Artifact-Member-Path')
  const headerTargetLang = decodedHeader(request, 'X-Artifact-Target-Lang')
  const headerProfileId = request.headers.get('X-Artifact-Profile-Id')?.trim()
  const headerProfileVersion = request.headers.get('X-Artifact-Profile-Version')?.trim()
  const headerFidelity = request.headers.get('X-Artifact-Fidelity')?.trim()
  const updateSourceHeader = request.headers.get('X-Update-Source-Sidecar')?.trim()
  if (
    (artifactName && artifactName.length > 1024)
    || (headerMemberPath && headerMemberPath.length > 1024)
    || (headerTargetLang && headerTargetLang.length > 255)
    || (headerProfileId && headerProfileId.length > 255)
    || (headerProfileVersion && headerProfileVersion.length > 64)
    || (headerFidelity && !['native', 'verified-recipe', 'content-only', 'preserved-only'].includes(headerFidelity))
    || (updateSourceHeader && !['true', 'false'].includes(updateSourceHeader))
    || (bindingRole !== 'target' && Boolean(headerTargetLang))
  ) {
    return withCors(new Response('invalid artifact metadata', { status: 400 }), request)
  }
  // Source originals are the default export skeleton. Target/support artifacts
  // never replace it unless the importer deliberately opts in (Paratext target
  // imports do, because their target USFM is the round-trip skeleton).
  const updateSourceSidecar = updateSourceHeader
    ? updateSourceHeader === 'true'
    : bindingRole === 'source'
  const file = await db.prepare(
    `SELECT name, meta FROM files WHERE id = ? AND project_id = ?`,
  ).bind(fileId, projectId).first<{ name: string; meta: unknown }>()
  if (!file) {
    return withCors(new Response('file not found', { status: 404 }), request)
  }
  const existing = await db.prepare(
    `SELECT project_id, kind, sha256, r2_key, size_bytes FROM artifacts WHERE id::text = ?`,
  ).bind(artifactId).first<{
    project_id: string
    kind: string
    sha256: string
    r2_key: string
    size_bytes: number
  }>()
  if (existing && (
    existing.project_id !== projectId
    || existing.kind !== 'source'
    || existing.sha256 !== sha256
    || existing.r2_key !== key
    || Number(existing.size_bytes) !== byteLength
  )) {
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

  let stored: R2Object
  try {
    stored = await env.SNAPSHOTS.put(
      key,
      bufferedBody ?? request.body!,
      {
        httpMetadata: { contentType },
        ...(bufferedBody ? {} : { sha256: sha256Bytes(sha256) }),
      },
    )
  } catch (error) {
    return withCors(
      new Response(`source storage upload failed: ${error instanceof Error ? error.message : String(error)}`, { status: 502 }),
      request,
    )
  }
  if (stored.size !== byteLength) {
    await env.SNAPSHOTS.delete(key)
    return withCors(new Response("source size did not match uploaded bytes", { status: 400 }), request)
  }

  // The sidecar is the export skeleton, not necessarily the source lane's
  // original. A target-side Paratext import deliberately selects its target
  // USFM skeleton; other target artifacts explicitly send update=false.
  const statements = buildSourceArtifactPersistenceStatements(db, {
    projectId,
    fileId,
    artifactId,
    bindingId: crypto.randomUUID(),
    uploadedByUserId: String(auth.claims.userId),
    artifactName: artifactName ?? file.name,
    contentType,
    byteLength,
    sha256,
    r2Key: key,
    format,
    bindingRole,
    targetLang: headerTargetLang ?? '',
    memberPath,
    profileId,
    profileVersion,
    fidelity: fidelity as 'native' | 'verified-recipe' | 'content-only' | 'preserved-only',
    manifest,
    recipe: recipe ? objectRecord(recipe) : null,
    origin: 'browser-import',
    updateSourceSidecar,
    createdAt: Date.now(),
  })
  try {
    await db.batch(statements)
  } catch (error) {
    // Keep R2 and Postgres convergent. A new artifact has no durable owner if
    // its metadata transaction fails, so remove its object before returning.
    // An already-recorded artifact may be a retry after a lost response; never
    // delete that established object on a later metadata failure.
    if (!existing) {
      try {
        await env.SNAPSHOTS.delete(key)
      } catch (cleanupError) {
        console.error(`[source-upload] failed to clean up ${key}:`, cleanupError)
      }
    }
    console.error(`[source-upload] metadata persistence failed for ${projectId}/${fileId}:`, error)
    return withCors(new Response("source metadata write failed", { status: 500 }), request)
  }

  return withCors(
    new Response(JSON.stringify({ ok: true, artifactId, key, sha256 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    request,
  )
}
