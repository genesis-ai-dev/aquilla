// Agent API knowledge-base (reference document) upload + list — AQU-1762.
//
//   POST /api/v1/external/projects/:projectId/knowledge
//     Body = raw bytes. Headers: x-doc-name (required). → { doc }
//   GET  /api/v1/external/projects/:projectId/knowledge  → { docs }
//
// Setting up reference material (a published Bible, approved prior translations,
// a style guide) is the first step of every rollout and is usually run by an
// agent on a partner's behalf, but the knowledge base was upload-in-the-app only:
// a converted Bible had to be handed to a human to drag in file by file. Every
// other setup action (settings, brief, terms, files, members) is in this API.
//
// Shape: a direct upload at the in-app role floor, not a changeset. The in-app
// upload is itself an immediate write with no approval gate, and a knowledge doc
// is additive reference material rather than a change to anyone's translation, so
// routing it through prepare → approve → commit would invent an approval the
// human surface does not ask for. Deleting one stays UI-only.
//
// Auth is this tier's standard gate (`authArtifact`): an `aqk_` credential, scoped
// to the project, with the owner's LIVE project role re-resolved per call. Upload
// needs role >= PROJECT_LEAD — the same floor as the in-app upload — and a
// read-write credential (AQU-1242); listing needs role >= VIEWER. The bytes are
// then bridged to auth-worker, which owns extraction and indexing (see
// knowledge-bridge.ts).

import { errorResponse } from './errors'
import { authArtifact } from './artifacts-route'
import { listKnowledgeDocs, uploadKnowledgeDoc } from './knowledge-bridge'
import { ROLE } from '../events/role-policy'
import type { ExternalEnv } from './types'
import {
  KB_EXTENSIONS,
  MAX_KB_ORIGINAL_BYTES,
  kbExtension,
} from '../../../db/shared/knowledge'
import { countRecentRateLimitEvents, recordRateLimitEvent } from '../../../db/shared/rate-limit'

const ROUTE_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/knowledge$/

/** decodeURIComponent that never throws on a malformed escape — a bad `%` in a
 *  filename is a name we cannot improve, not a reason to 500. Mirrors the
 *  in-app route's own safeDecode. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Mirrors the artifact-upload cap: comparable bytes moved per call, and a
 *  legitimate rollout uploads a handful of reference documents, not hundreds. */
const KNOWLEDGE_UPLOAD_MAX_PER_CREDENTIAL = 120
/** Cheap single-query read, so the looser search/metadata cap applies. */
const KNOWLEDGE_LIST_MAX_PER_CREDENTIAL = 300

async function checkRateLimit(
  db: AquillaDb,
  kind: string,
  credentialId: string,
  max: number,
  message: string,
): Promise<Response | null> {
  const identifier = `credential:${credentialId}`
  const recent = await countRecentRateLimitEvents(db, kind, identifier)
  if (recent >= max) return errorResponse('rate_limited', message)
  await recordRateLimitEvent(db, kind, identifier)
  return null
}

async function handleUpload(
  request: Request,
  env: ExternalEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authArtifact(request, env, projectId, ROLE.PROJECT_LEAD, {
    writes: true,
    action: 'upload a knowledge-base document',
  })
  if (!authed.ok) return authed.response
  const db = env.AQUILLA_PG as AquillaDb

  const limited = await checkRateLimit(
    db,
    'external_knowledge_upload',
    authed.cred.credentialId,
    KNOWLEDGE_UPLOAD_MAX_PER_CREDENTIAL,
    'knowledge upload rate limit exceeded, slow down',
  )
  if (limited) return limited

  // HTTP headers are ByteString-only, so a non-ASCII document name — which is
  // the common case here (an Arabic Bible, a Burmese style guide) — can only
  // travel percent-encoded. Decode on receipt, exactly as the in-app upload
  // does, and validate the real name; the bridge encodes it again for the hop
  // to auth-worker. An already-ASCII name decodes to itself, so a caller that
  // did not encode is unaffected.
  const rawName = request.headers.get('x-doc-name')
  const docName = safeDecode(rawName ?? '').trim()
  if (docName === '') {
    return errorResponse('validation_failed', 'x-doc-name header is required')
  }
  // Validated here as well as upstream so a 25 MB body is never proxied across
  // the worker seam only to be refused for its filename. `kbExtension` is the
  // shared allowlist the in-app upload uses, so the two cannot drift.
  if (kbExtension(docName) == null) {
    return errorResponse('validation_failed', 'unsupported file extension', {
      docName,
      supported: KB_EXTENSIONS,
    })
  }

  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_KB_ORIGINAL_BYTES) {
    return errorResponse('validation_failed', 'knowledge document exceeds maximum size', {
      sizeBytes: declaredLength,
      maxBytes: MAX_KB_ORIGINAL_BYTES,
    })
  }

  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength === 0) {
    return errorResponse('validation_failed', 'knowledge document body is empty')
  }
  if (bytes.byteLength > MAX_KB_ORIGINAL_BYTES) {
    return errorResponse('validation_failed', 'knowledge document exceeds maximum size', {
      sizeBytes: bytes.byteLength,
      maxBytes: MAX_KB_ORIGINAL_BYTES,
    })
  }

  const result = await uploadKnowledgeDoc(env, {
    projectId,
    userId: authed.cred.userId,
    docName,
    bytes,
  })
  if (!result.ok) return errorResponse(result.code, result.message)
  return Response.json(result.body, { status: result.status })
}

async function handleList(
  request: Request,
  env: ExternalEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authArtifact(request, env, projectId, ROLE.VIEWER)
  if (!authed.ok) return authed.response
  const db = env.AQUILLA_PG as AquillaDb

  const limited = await checkRateLimit(
    db,
    'external_knowledge_list',
    authed.cred.credentialId,
    KNOWLEDGE_LIST_MAX_PER_CREDENTIAL,
    'knowledge read rate limit exceeded, slow down',
  )
  if (limited) return limited

  const result = await listKnowledgeDocs(env, { projectId, userId: authed.cred.userId })
  if (!result.ok) return errorResponse(result.code, result.message)
  return Response.json(result.body, { status: result.status })
}

export async function handleExternalKnowledgeRequest(
  request: Request,
  env: ExternalEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const m = ROUTE_RE.exec(url.pathname)
  if (!m) return null

  const projectId = decodeURIComponent(m[1])
  if (request.method === 'POST') return handleUpload(request, env, projectId)
  if (request.method === 'GET') return handleList(request, env, projectId)
  return errorResponse('validation_failed', 'method not allowed')
}
