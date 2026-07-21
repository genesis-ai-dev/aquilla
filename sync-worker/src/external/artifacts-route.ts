// Agent API source-artifact upload / preservation (AQU-533 §5, W2-B).
//
//   POST /api/v1/external/projects/:projectId/artifacts
//     Body = raw bytes. Headers: x-artifact-name (required), content-type.
//     → store bytes in SNAPSHOTS, insert metadata row, return
//       { artifactId, sha256, sizeBytes }.
//   GET  .../artifacts/:artifactId          → metadata
//   GET  .../artifacts/:artifactId/content  → raw bytes
//   GET  .../artifacts/:artifactId/inspect  → lightweight format detection
//
// Auth on every route: an `aqk_` API credential (validateApiCredential), scoped
// to this project (assertCredentialScope), with the caller's LIVE project role
// re-resolved per call. Upload requires role >= CONTRIBUTOR (400); reads require
// role >= VIEWER (100). Bytes are worker-proxied — this repo has no presigned-URL
// pattern, so we do not invent one (§4 D10 signed URLs are a later concern; v1
// proxies through the worker like /audio does).

import { errorResponse, toErrorResponse } from './errors'
import { assertCredentialScope } from './token-bridge'
import { uuidv7 } from './uuid'
import { r2KeyPrefix, audioObjectKey } from '../audio'
import { ROLE } from '../events/role-policy'
import type { ExternalEnv } from './types'
import { validateApiCredential, type ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'

/** Max artifact size — 25 MB. Published in get_capabilities (operational
 *  contract §4); surfaced in the oversize error so an agent can self-correct. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024

/** Artifact kinds. `source` (default) preserves a verbatim import original;
 *  `audio` is an uploaded clip a LinkMedia changeset attaches to a cell. The
 *  caller declares the kind via the `x-artifact-kind` header (absent → source,
 *  keeping the existing source-upload path untouched). */
export type ArtifactKind = 'source' | 'audio'

/** Audio content types the upload path accepts (Agent API v1.1 §3), mapped to
 *  the file extension the audio R2 object name + `frontier-audio://` url carry.
 *  Cap is unchanged (MAX_ARTIFACT_BYTES). */
const AUDIO_CONTENT_TYPES: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
}

const ROUTE_RE =
  /^\/api\/v1\/external\/projects\/([^/]+)\/artifacts(?:\/([^/]+)(?:\/(content|inspect))?)?$/

function bearer(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

function artifactR2Key(env: ExternalEnv, projectId: string, artifactId: string): string {
  return `${r2KeyPrefix(env)}artifacts/${projectId}/${artifactId}`
}

interface AuthOk {
  ok: true
  cred: ApiCredentialContext
  role: number
}
type AuthResult = AuthOk | { ok: false; response: Response }

/** Credential → scope → live role. `minRole` gates the operation. */
async function authArtifact(
  request: Request,
  env: ExternalEnv,
  projectId: string,
  minRole: number,
): Promise<AuthResult> {
  const db = env.AQUILLA_PG
  if (!db) return { ok: false, response: errorResponse('job_failed', 'AQUILLA_PG not configured') }

  const cred = await validateApiCredential(db, bearer(request) ?? '')
  if (!cred) return { ok: false, response: errorResponse('permission_denied', 'invalid or missing API credential') }

  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    return { ok: false, response: toErrorResponse(err) }
  }

  const resolved = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!resolved || resolved.level < minRole) {
    return { ok: false, response: errorResponse('permission_denied', 'insufficient project role') }
  }
  return { ok: true, cred, role: resolved.level }
}

interface ArtifactRow {
  id: string
  project_id: string
  uploaded_by_user_id: string
  credential_id: string
  name: string
  content_type: string | null
  size_bytes: number | string
  sha256: string
  r2_key: string
  file_id: string | null
  kind: string
  audio_id: string | null
  metadata: unknown
  created_at: unknown
}

function rowToMeta(row: ArtifactRow): Record<string, unknown> {
  return {
    artifactId: row.id,
    projectId: row.project_id,
    uploadedByUserId: row.uploaded_by_user_id,
    credentialId: row.credential_id,
    name: row.name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    fileId: row.file_id,
    kind: row.kind,
    audioId: row.audio_id,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at == null
          ? null
          : new Date(row.created_at as string).toISOString(),
  }
}

async function loadArtifact(
  db: AquillaDb,
  projectId: string,
  artifactId: string,
): Promise<ArtifactRow | null> {
  return db
    .prepare(
      `SELECT id, project_id, uploaded_by_user_id, credential_id, name, content_type,
              size_bytes, sha256, r2_key, file_id, kind, audio_id, metadata, created_at
         FROM artifacts WHERE id::text = ? AND project_id = ?`,
    )
    .bind(artifactId, projectId)
    .first<ArtifactRow>()
}

// ── POST (upload) ────────────────────────────────────────────────────────────

async function handleUpload(
  request: Request,
  env: ExternalEnv,
  projectId: string,
): Promise<Response> {
  if (!env.SNAPSHOTS) return errorResponse('job_failed', 'SNAPSHOTS bucket not configured')
  const authed = await authArtifact(request, env, projectId, ROLE.CONTRIBUTOR)
  if (!authed.ok) return authed.response
  const db = env.AQUILLA_PG as AquillaDb

  const name = request.headers.get('x-artifact-name')
  if (!name || name.trim() === '') {
    return errorResponse('validation_failed', 'x-artifact-name header is required')
  }
  const contentType = request.headers.get('content-type')

  // Kind (Agent API v1.1 §3). Absent header → 'source' — the existing path is
  // byte-for-byte unchanged. 'audio' validates the content type against the
  // audio allowlist and lands the bytes in the per-file audio R2 layout.
  const kindHeader = request.headers.get('x-artifact-kind')
  let kind: ArtifactKind
  if (kindHeader == null || kindHeader === 'source') {
    kind = 'source'
  } else if (kindHeader === 'audio') {
    kind = 'audio'
  } else {
    return errorResponse('validation_failed', `unsupported artifact kind: ${kindHeader}`)
  }

  let audioExt: string | null = null
  if (kind === 'audio') {
    const normalized = (contentType ?? '').split(';')[0].trim().toLowerCase()
    audioExt = AUDIO_CONTENT_TYPES[normalized] ?? null
    if (!audioExt) {
      return errorResponse('validation_failed', 'unsupported audio content type', {
        contentType,
        supported: Object.keys(AUDIO_CONTENT_TYPES),
      })
    }
  }

  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength === 0) {
    return errorResponse('validation_failed', 'artifact body is empty')
  }
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    return errorResponse('validation_failed', 'artifact exceeds maximum size', {
      sizeBytes: bytes.byteLength,
      maxBytes: MAX_ARTIFACT_BYTES,
    })
  }

  const artifactId = uuidv7()
  const sha256 = await sha256HexBytes(bytes)

  // Audio artifacts land in the EXISTING audio R2 layout used by audio.ts, keyed
  // with the artifactId in the file slot; `audioId` is the full object name
  // (`<artifactId>.<ext>`) that layout + the compiled cell.audio.attach payload
  // expect. A LinkMedia commit copies these bytes under the target cell's file
  // so the app's native /audio route serves them. Source artifacts keep the
  // verbatim `artifacts/{projectId}/{artifactId}` key.
  const audioId = kind === 'audio' ? `${artifactId}.${audioExt}` : null
  const r2Key =
    kind === 'audio'
      ? audioObjectKey(env, projectId, artifactId, audioId as string)
      : artifactR2Key(env, projectId, artifactId)

  await env.SNAPSHOTS.put(r2Key, bytes, {
    httpMetadata: contentType ? { contentType } : undefined,
  })

  try {
    await db
      .prepare(
        `INSERT INTO artifacts
           (id, project_id, uploaded_by_user_id, credential_id, name, content_type, size_bytes, sha256, r2_key, kind, audio_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        artifactId,
        projectId,
        String(authed.cred.userId),
        authed.cred.credentialId,
        name,
        contentType,
        bytes.byteLength,
        sha256,
        r2Key,
        kind,
        audioId,
      )
      .run()
  } catch (err) {
    // Roll back the orphaned R2 object so a failed insert leaves no dangling blob.
    await env.SNAPSHOTS.delete(r2Key).catch(() => {})
    return errorResponse('job_failed', `artifact insert failed: ${String(err)}`)
  }

  return Response.json({
    artifactId,
    sha256,
    sizeBytes: bytes.byteLength,
    kind,
    ...(audioId ? { audioId } : {}),
  })
}

/** SHA-256 hex of raw bytes (canonical.ts's sha256Hex takes a string). */
async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
}

// ── GET metadata / content ─────────────────────────────────────────────────

async function handleGetMeta(
  request: Request,
  env: ExternalEnv,
  projectId: string,
  artifactId: string,
): Promise<Response> {
  const authed = await authArtifact(request, env, projectId, ROLE.VIEWER)
  if (!authed.ok) return authed.response
  const row = await loadArtifact(env.AQUILLA_PG as AquillaDb, projectId, artifactId)
  if (!row) return errorResponse('not_found', `artifact ${artifactId} not found`)
  return Response.json({ artifact: rowToMeta(row) })
}

async function handleGetContent(
  request: Request,
  env: ExternalEnv,
  projectId: string,
  artifactId: string,
): Promise<Response> {
  if (!env.SNAPSHOTS) return errorResponse('job_failed', 'SNAPSHOTS bucket not configured')
  const authed = await authArtifact(request, env, projectId, ROLE.VIEWER)
  if (!authed.ok) return authed.response
  const row = await loadArtifact(env.AQUILLA_PG as AquillaDb, projectId, artifactId)
  if (!row) return errorResponse('not_found', `artifact ${artifactId} not found`)

  const obj = await env.SNAPSHOTS.get(row.r2_key)
  if (!obj) return errorResponse('not_found', 'artifact bytes missing from storage')
  const buf = await obj.arrayBuffer()
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': row.content_type || 'application/octet-stream',
      'Content-Length': String(buf.byteLength),
    },
  })
}

// ── GET inspect (lightweight format detection) ──────────────────────────────

/** How many leading bytes to sniff — enough to see structural markers without
 *  reading a large file into the worker. */
const INSPECT_SNIFF_BYTES = 64 * 1024

interface InspectDetails {
  byteCount: number
  sniffedBytes: number
  lineCount: number
  [key: string]: unknown
}

/** Sniff format from the first ~64KB. Deterministic, order-of-checks matters:
 *  USFM (\id marker) → XLIFF/TMX (XML roots) → JSON → CSV/TSV → plaintext. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function zipMemberNames(bytes: Uint8Array): string[] {
  const names: string[] = []
  const decoder = new TextDecoder()
  // Scan local-file headers rather than inflating members. This is bounded and
  // sufficient to classify OOXML and Paratext packages by their inventory.
  for (let offset = 0; offset + 30 <= bytes.length && names.length < 500; offset++) {
    if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4b || bytes[offset + 2] !== 0x03 || bytes[offset + 3] !== 0x04) continue
    const nameLength = bytes[offset + 26] | (bytes[offset + 27] << 8)
    const extraLength = bytes[offset + 28] | (bytes[offset + 29] << 8)
    const nameStart = offset + 30
    const nameEnd = nameStart + nameLength
    if (nameEnd > bytes.length) break
    names.push(decoder.decode(bytes.subarray(nameStart, nameEnd)))
    // Skip the fixed header/name/extra. We deliberately resume scanning after
    // it instead of trusting compressed-size when the data-descriptor flag is
    // set; the next PK header is found safely by the outer scan.
    offset = Math.max(offset, nameEnd + extraLength - 1)
  }
  return names
}

function detectFormat(
  text: string,
  bytes: Uint8Array,
  name: string,
): { detectedFormat: string; confidence: number; extra: Record<string, unknown> } {
  const head = text.slice(0, 4096)
  const trimmed = text.trimStart()
  const extension = extensionOf(name)

  const isZip = bytes.length >= 4
    && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  if (isZip) {
    const members = zipMemberNames(bytes)
    const lower = members.map((member) => member.toLowerCase())
    const sfmMembers = members.filter((member) => /(?:^|\/)[^/]+\.(?:sfm|usfm)$/i.test(member))
    if (lower.includes('word/document.xml')) {
      return { detectedFormat: 'docx', confidence: 1, extra: { container: 'zip', memberCount: members.length, memberSample: members.slice(0, 50) } }
    }
    if (lower.some((member) => member.startsWith('ppt/slides/slide') && member.endsWith('.xml'))) {
      return { detectedFormat: 'pptx', confidence: 1, extra: { container: 'zip', memberCount: members.length, memberSample: members.slice(0, 50) } }
    }
    if (sfmMembers.length > 0 || lower.some((member) => /(?:^|\/)settings\.xml$/i.test(member))) {
      return {
        detectedFormat: 'paratext-project',
        confidence: sfmMembers.length > 0 ? 0.99 : 0.85,
        extra: {
          container: 'zip',
          memberCount: members.length,
          scriptureMemberCount: sfmMembers.length,
          scriptureMembers: sfmMembers.slice(0, 100),
          memberSample: members.slice(0, 50),
        },
      }
    }
    return { detectedFormat: extension === 'zip' ? 'zip' : extension || 'zip', confidence: 0.75, extra: { container: 'zip', memberCount: members.length, memberSample: members.slice(0, 50) } }
  }

  // Legacy Word binary (OLE compound file). It is preserved, but requires a
  // recipe/converter before semantic cells can be produced.
  const oleMagic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
  if (bytes.length >= oleMagic.length && oleMagic.every((value, index) => bytes[index] === value)) {
    return { detectedFormat: 'doc', confidence: 1, extra: { container: 'ole', needsRecipe: true } }
  }

  // USFM: the \id marker is the canonical opening tag.
  if (/(^|\n)\s*\\id\b/.test(head)) {
    return { detectedFormat: 'usfm', confidence: 1, extra: {} }
  }
  // XML dialects.
  if (/<xliff[\s>]/i.test(head)) return { detectedFormat: 'xliff', confidence: 1, extra: {} }
  if (/<tmx[\s>]/i.test(head)) return { detectedFormat: 'tmx', confidence: 1, extra: {} }
  if (/<usx[\s>]/i.test(head)) return { detectedFormat: 'usx', confidence: 1, extra: {} }

  if (/^WEBVTT(?:\s|$)/i.test(trimmed)) return { detectedFormat: 'vtt', confidence: 1, extra: {} }
  if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+/m.test(text)) {
    return { detectedFormat: 'srt', confidence: 0.98, extra: {} }
  }

  // JSON — parse the whole text; report top-level shape.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        return { detectedFormat: 'json', confidence: 1, extra: { jsonShape: 'array', length: parsed.length } }
      }
      if (parsed !== null && typeof parsed === 'object') {
        const keys = Object.keys(parsed)
        return {
          detectedFormat: 'json',
          confidence: 1,
          extra: { jsonShape: 'object', keyCount: keys.length, keySample: keys.slice(0, 10) },
        }
      }
      return { detectedFormat: 'json', confidence: 1, extra: { jsonShape: typeof parsed } }
    } catch {
      // Not valid JSON despite the leading brace — fall through.
    }
  }

  // CSV / TSV — sniff the delimiter on the first non-empty line.
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const tabs = (firstLine.match(/\t/g) ?? []).length
  const commas = (firstLine.match(/,/g) ?? []).length
  if (tabs >= 1 && tabs >= commas) {
    return { detectedFormat: 'tsv', confidence: 0.9, extra: { delimiter: '\\t', columns: tabs + 1 } }
  }
  if (commas >= 1) {
    return { detectedFormat: 'csv', confidence: 0.85, extra: { delimiter: ',', columns: commas + 1 } }
  }

  if (extension === 'md' || extension === 'markdown') {
    return { detectedFormat: 'markdown', confidence: 0.9, extra: {} }
  }
  if (['txt', 'text'].includes(extension)) {
    return { detectedFormat: 'plaintext', confidence: 0.9, extra: {} }
  }
  return { detectedFormat: extension || 'unknown', confidence: extension ? 0.45 : 0.2, extra: { needsAssistance: true } }
}

async function handleInspect(
  request: Request,
  env: ExternalEnv,
  projectId: string,
  artifactId: string,
): Promise<Response> {
  if (!env.SNAPSHOTS) return errorResponse('job_failed', 'SNAPSHOTS bucket not configured')
  const authed = await authArtifact(request, env, projectId, ROLE.VIEWER)
  if (!authed.ok) return authed.response
  const row = await loadArtifact(env.AQUILLA_PG as AquillaDb, projectId, artifactId)
  if (!row) return errorResponse('not_found', `artifact ${artifactId} not found`)

  // Audio artifacts report size + content type only — no decoding, no
  // duration/waveform sniffing (Agent API v1.1 §3; that would require decoding).
  if (row.kind === 'audio') {
    return Response.json({
      detectedFormat: 'audio',
      details: {
        contentType: row.content_type,
        sizeBytes: Number(row.size_bytes),
        audioId: row.audio_id,
      },
    })
  }

  const obj = await env.SNAPSHOTS.get(row.r2_key)
  if (!obj) return errorResponse('not_found', 'artifact bytes missing from storage')
  const full = new Uint8Array(await obj.arrayBuffer())
  const sniff = full.subarray(0, INSPECT_SNIFF_BYTES)
  const text = new TextDecoder().decode(sniff)

  const { detectedFormat, confidence, extra } = detectFormat(text, full, row.name)
  const lineCount = text === '' ? 0 : text.split(/\r?\n/).length

  const details: InspectDetails = {
    byteCount: full.byteLength,
    sniffedBytes: sniff.byteLength,
    lineCount,
    truncated: full.byteLength > sniff.byteLength,
    confidence,
    ...extra,
  }
  const inspection = {
    detectedFormat,
    details,
    inspectedAt: new Date().toISOString(),
  }
  await (env.AQUILLA_PG as AquillaDb)
    .prepare(`UPDATE artifacts SET metadata = metadata || ?::jsonb WHERE id::text = ? AND project_id = ?`)
    .bind(JSON.stringify({ inspection }), artifactId, projectId)
    .run()
  return Response.json({ detectedFormat, details })
}

// ── Router ──────────────────────────────────────────────────────────────────

export async function handleExternalArtifactsRequest(
  request: Request,
  env: ExternalEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const m = ROUTE_RE.exec(url.pathname)
  if (!m) return null

  const projectId = decodeURIComponent(m[1])
  const artifactId = m[2] ? decodeURIComponent(m[2]) : undefined
  const sub = m[3] as 'content' | 'inspect' | undefined

  // Collection: POST → upload.
  if (!artifactId) {
    if (request.method !== 'POST') return errorResponse('validation_failed', 'method not allowed')
    return handleUpload(request, env, projectId)
  }

  // Item sub-resources.
  if (sub === 'content') {
    if (request.method !== 'GET') return errorResponse('validation_failed', 'method not allowed')
    return handleGetContent(request, env, projectId, artifactId)
  }
  if (sub === 'inspect') {
    if (request.method !== 'GET') return errorResponse('validation_failed', 'method not allowed')
    return handleInspect(request, env, projectId, artifactId)
  }

  // Item: GET → metadata.
  if (request.method !== 'GET') return errorResponse('validation_failed', 'method not allowed')
  return handleGetMeta(request, env, projectId, artifactId)
}
