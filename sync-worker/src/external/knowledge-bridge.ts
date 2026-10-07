// sync-worker → auth-worker bridge for knowledge-base upload / list (AQU-1762).
//
// The knowledge base lives in auth-worker (extension allowlist, docx/pdf text
// extraction, the PageIndex indexing job that holds the OpenRouter key, the
// `kb/…` R2 layout) — see auth-worker/src/routes/knowledge-internal.ts for why
// the Agent API bridges instead of forking a second uploader. Same shared-secret
// pattern as brief-summary-bridge.ts: `Authorization: Bearer SYNC_SECRET_KEY`
// plus `x-acting-user-id`, which names the credential owner the call acts as and
// is re-resolved to a live project role on the far side.
//
// Upstream errors are carried through with their code and message intact rather
// than collapsed to a generic failure: the extraction messages are authored for
// whoever uploaded the file (AQU-1499 — "could not extract text: <reason>") and
// are the whole reason an agent can self-correct instead of retrying blind.

import type { ExternalErrorCode } from './errors'

export interface KnowledgeBridgeEnv {
  AUTH_WORKER_URL?: string
  SYNC_SECRET_KEY?: string
}

export type KnowledgeBridgeResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; code: ExternalErrorCode; message: string }

/** auth-worker's knowledge error vocabulary → the external contract's. There is
 *  no 422 in the external codes, so an extraction refusal reports as
 *  `validation_failed` with its upstream message preserved. */
const UPSTREAM_CODES: Record<string, ExternalErrorCode> = {
  not_found: 'not_found',
  permission_denied: 'permission_denied',
  validation_failed: 'validation_failed',
  storage_unavailable: 'job_failed',
  job_failed: 'job_failed',
}

function mapUpstream(status: number, rawCode: unknown, rawMessage: unknown): KnowledgeBridgeResult {
  const message =
    typeof rawMessage === 'string' && rawMessage.trim() !== ''
      ? rawMessage
      : `knowledge base request failed (${status})`
  const mapped = typeof rawCode === 'string' ? UPSTREAM_CODES[rawCode] : undefined
  if (mapped) return { ok: false, code: mapped, message }
  if (status === 429) return { ok: false, code: 'rate_limited', message }
  if (status === 401 || status === 403) return { ok: false, code: 'permission_denied', message }
  if (status === 404) return { ok: false, code: 'not_found', message }
  if (status >= 400 && status < 500) return { ok: false, code: 'validation_failed', message }
  return { ok: false, code: 'job_failed', message }
}

/** A 404 with no JSON error body is the identity worker ANSWERING and not knowing
 *  this route — i.e. auth-worker is older than sync-worker. Worker deploys are
 *  manual and per-surface, so "sync has the route, auth does not" is a real,
 *  recurring state worth naming (same reasoning as brief-summary-bridge.ts). */
const BEHIND_MESSAGE =
  'the identity worker has no knowledge-base route at ' +
  '/api/v2/internal/projects/:projectId/knowledge — auth-worker is behind ' +
  'sync-worker; deploy auth-worker (docs/DEPLOYMENT-ENVIRONMENTS.md)'

async function callAuthWorker(
  env: KnowledgeBridgeEnv,
  path: string,
  init: RequestInit,
): Promise<KnowledgeBridgeResult> {
  if (!env.AUTH_WORKER_URL || !env.SYNC_SECRET_KEY) {
    return {
      ok: false,
      code: 'job_failed',
      message: 'the knowledge base backend is not configured in this environment',
    }
  }

  let res: Response
  try {
    res = await fetch(`${env.AUTH_WORKER_URL}${path}`, init)
  } catch {
    return { ok: false, code: 'job_failed', message: 'knowledge base backend unreachable' }
  }

  let body: unknown = undefined
  let parsed = true
  try {
    body = await res.json()
  } catch {
    parsed = false
  }

  if (res.ok) {
    if (!parsed) {
      return { ok: false, code: 'job_failed', message: 'knowledge base backend returned an unreadable response' }
    }
    return { ok: true, status: res.status, body }
  }

  const err = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error
  if (res.status === 404 && (!parsed || err === undefined)) {
    return { ok: false, code: 'job_failed', message: BEHIND_MESSAGE }
  }
  return mapUpstream(res.status, err?.code, err?.message)
}

/** Upload one knowledge document. `bytes` is the verbatim request body; `docName`
 *  is forwarded as `x-doc-name`, which auth-worker validates against the
 *  knowledge-base extension allowlist. */
export async function uploadKnowledgeDoc(
  env: KnowledgeBridgeEnv,
  input: { projectId: string; userId: string | number; docName: string; bytes: Uint8Array },
): Promise<KnowledgeBridgeResult> {
  return callAuthWorker(
    env,
    `/api/v2/internal/projects/${encodeURIComponent(input.projectId)}/knowledge`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
        'x-acting-user-id': String(input.userId),
        'x-doc-name': encodeURIComponent(input.docName),
        'Content-Type': 'application/octet-stream',
      },
      body: input.bytes.slice().buffer as ArrayBuffer,
    },
  )
}

/** List the project's knowledge documents (plus its org's shared ones). */
export async function listKnowledgeDocs(
  env: KnowledgeBridgeEnv,
  input: { projectId: string; userId: string | number },
): Promise<KnowledgeBridgeResult> {
  return callAuthWorker(
    env,
    `/api/v2/internal/projects/${encodeURIComponent(input.projectId)}/knowledge`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
        'x-acting-user-id': String(input.userId),
      },
    },
  )
}
