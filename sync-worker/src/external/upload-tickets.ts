// Signed upload URLs for files too large to pass through an MCP tool call.
//
//   MCP tool create_upload_url → { uploadUrl, ... }
//   PUT /api/v1/external/uploads/:ticket   (body = raw bytes, no Authorization)
//     → the same { artifactId, sha256, sizeBytes, kind } as the REST upload.
//
// Why a URL: upload_artifact carries the bytes as base64 inside the tool call,
// so the model has to write the whole file out as tokens. That caps it at a
// few hundred KB. A URL lets the agent's shell (curl) send the bytes instead.
// The MCP OAuth token cannot go to REST (audience-bound), and must never sit
// in a URL, so the URL carries its own short-lived ticket.
//
// The ticket is an HS256 JWT signed with a key DERIVED from SYNC_SECRET_KEY
// (HMAC with a fixed label), not the key itself, so no other verifier of
// SYNC_SECRET_KEY tokens (sync JWTs, checking-link sessions) can accept it and
// it cannot stand in for one of theirs. It names the credential, project,
// filename, kind and content type. At PUT time the credential is re-read by id
// (revoked / expired → refused) and its write access, project scope and live
// role are checked again, then the bytes go through the REST upload's own
// storeArtifact (size cap, audio allowlist, per-user rate limit).
//
// Single use: the ticket's jti is spent with an INSERT that only one request
// can win (see spendTicket), before any bytes are stored.

import { sign, verify } from 'hono/jwt'
import { errorResponse } from './errors'
import { authorizeArtifactCredential, storeArtifact, MAX_ARTIFACT_BYTES } from './artifacts-route'
import { uuidv7 } from './uuid'
import { ROLE } from '../events/role-policy'
import type { ExternalEnv } from './types'
import { revalidateApiCredentialById, type ApiCredentialContext } from '../../../db/shared/api-credentials'
import type { AquillaDb } from '../../../db/shim/postgres'

export const UPLOAD_TICKET_TTL_SECONDS = 15 * 60
const AUDIENCE = 'artifact-upload'
const PATH_RE = /^\/api\/v1\/external\/uploads\/([^/]+)$/

interface UploadTicketClaims {
  aud: typeof AUDIENCE
  jti: string
  /** credentialId */
  sub: string
  /** The credential's OAuth resource, re-checked like a token's audience. */
  res?: string
  projectId: string
  name: string
  kind: 'source' | 'audio'
  contentType: string
  iat: number
  exp: number
}

async function ticketKey(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('aquilla artifact upload ticket v1'))
  return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export interface MintedUploadUrl {
  uploadUrl: string
  method: 'PUT'
  expiresAt: string
  maxBytes: number
}

/** Mint an upload URL for an authorized credential. The caller (the MCP tool)
 *  has already checked write access, scope and role, so a refusal surfaces at
 *  mint time rather than after a 40 MB transfer. */
export async function mintUploadUrl(
  env: ExternalEnv,
  cred: ApiCredentialContext,
  input: { projectId: string; name: string; kind: 'source' | 'audio'; contentType: string },
): Promise<MintedUploadUrl> {
  if (!env.SYNC_SECRET_KEY) throw new Error('SYNC_SECRET_KEY not configured')
  if (!env.externalPublicBase) throw new Error('public base URL unknown')
  const now = Math.floor(Date.now() / 1000)
  const claims: UploadTicketClaims = {
    aud: AUDIENCE,
    jti: uuidv7(),
    sub: cred.credentialId,
    ...(cred.oauthResource ? { res: cred.oauthResource } : {}),
    projectId: input.projectId,
    name: input.name,
    kind: input.kind,
    contentType: input.contentType,
    iat: now,
    exp: now + UPLOAD_TICKET_TTL_SECONDS,
  }
  const ticket = await sign(claims as unknown as Record<string, unknown>, await ticketKey(env.SYNC_SECRET_KEY), 'HS256')
  return {
    uploadUrl: `${env.externalPublicBase.replace(/\/+$/, '')}/api/v1/external/uploads/${ticket}`,
    method: 'PUT',
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    maxBytes: MAX_ARTIFACT_BYTES,
  }
}

async function readTicket(secret: string, ticket: string): Promise<UploadTicketClaims | null> {
  try {
    const claims = (await verify(ticket, await ticketKey(secret), 'HS256')) as unknown as UploadTicketClaims
    if (claims.aud !== AUDIENCE || typeof claims.exp !== 'number') return null
    if (typeof claims.sub !== 'string' || typeof claims.jti !== 'string' || typeof claims.projectId !== 'string') return null
    return claims
  } catch {
    return null
  }
}

/** Spend a ticket's jti exactly once. A row keyed (kind, jti, exp) in
 *  rate_limit_counters is the spent marker: the primary key makes the INSERT
 *  the atomic check, and keying the row on the ticket's own `exp` (not an
 *  epoch-aligned window, as enforceRateLimit does) means no window boundary
 *  inside the ticket's life can reset it. The prune sweep drops the row an hour
 *  after `exp`, when the ticket no longer verifies anyway. Any error refuses,
 *  a missing table included (enforceRateLimit lets that case through). */
async function spendTicket(db: AquillaDb, claims: UploadTicketClaims): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `INSERT INTO rate_limit_counters (kind, identifier, window_start, hits)
         VALUES ('artifact_upload_ticket', ?, to_timestamp(?::double precision), 1)
         ON CONFLICT (kind, identifier, window_start) DO NOTHING
         RETURNING hits`,
      )
      .bind(claims.jti, claims.exp)
      .first<{ hits: number }>()
    return row != null
  } catch (err) {
    console.warn('[upload-ticket] could not spend ticket, refusing:', err)
    return false
  }
}

export async function handleUploadTicketRequest(request: Request, env: ExternalEnv): Promise<Response | null> {
  const m = PATH_RE.exec(new URL(request.url).pathname)
  if (!m) return null
  if (request.method !== 'PUT' && request.method !== 'POST') {
    return errorResponse('validation_failed', 'method not allowed; PUT the raw file bytes')
  }
  const db = env.AQUILLA_PG
  if (!db || !env.SYNC_SECRET_KEY) return errorResponse('job_failed', 'upload URLs are not configured')

  const claims = await readTicket(env.SYNC_SECRET_KEY, m[1])
  if (!claims) {
    return errorResponse('permission_denied', 'upload URL is invalid or expired; call create_upload_url again')
  }
  const cred = await revalidateApiCredentialById(db, claims.sub, claims.res)
  if (!cred) return errorResponse('permission_denied', 'the credential that created this upload URL is no longer valid')
  const authed = await authorizeArtifactCredential(env, cred, claims.projectId, ROLE.CONTRIBUTOR, { writes: true })
  if (!authed.ok) return authed.response

  if (!(await spendTicket(db, claims))) {
    return errorResponse('conflict', 'this upload URL was already used; call create_upload_url again')
  }

  return storeArtifact(request, env, claims.projectId, cred, {
    name: claims.name,
    contentType: claims.contentType,
    kind: claims.kind,
  })
}
