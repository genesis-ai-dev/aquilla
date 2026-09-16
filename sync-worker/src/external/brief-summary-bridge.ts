// sync-worker → auth-worker bridge for the L1 brief-summary render (AQU-1282 §2).
//
// The copilot reads `translationBrief.l1Summary`, which is an LLM render of the
// brief's sections. The render lives in auth-worker (it owns the OpenRouter key,
// the model allowlist, and the credit ledger — see
// auth-worker/src/routes/ai-brief-internal.ts); this module calls it with the
// same shared-secret pattern as commands-draft-cells.ts::requestDrafts.
//
// Unlike requestDrafts this NEVER throws: SetBrief's auto-render is
// best-effort (the sections are already committed when it runs), and
// RegenerateBriefSummary wants to answer with a named code without consuming
// the human's approval. `not_configured` is what a test env (no
// AUTH_WORKER_URL) and a mis-wired deploy both look like.

export interface BriefSummaryBridgeEnv {
  AUTH_WORKER_URL?: string
  SYNC_SECRET_KEY?: string
}

export type BriefSummaryFailureCode = 'not_configured' | 'rate_limited' | 'permission_denied' | 'job_failed'

export type BriefSummaryResult =
  | { ok: true; summary: string; model: string }
  | { ok: false; code: BriefSummaryFailureCode; message: string }

export async function renderBriefSummary(
  env: BriefSummaryBridgeEnv,
  input: { projectId: string; userId: string | number; l2Markdown: string },
): Promise<BriefSummaryResult> {
  if (!env.AUTH_WORKER_URL || !env.SYNC_SECRET_KEY) {
    return { ok: false, code: 'not_configured', message: 'brief summary backend is not configured in this environment' }
  }

  let res: Response
  try {
    res = await fetch(`${env.AUTH_WORKER_URL}/api/v1/ai/agent/internal/brief-summary`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    })
  } catch {
    return { ok: false, code: 'job_failed', message: 'brief summary backend unreachable' }
  }

  if (!res.ok) {
    let body: { error?: string; message?: string; reason?: string } = {}
    try {
      body = (await res.json()) as typeof body
    } catch {
      /* non-JSON upstream error — fall through to the generic message */
    }
    if (body.error === 'credit_cap_exceeded' || res.status === 429) {
      return {
        ok: false,
        code: 'rate_limited',
        message: body.message ?? `credit cap reached on the agent rail (${body.reason ?? 'cap'})`,
      }
    }
    if (res.status === 403) {
      return { ok: false, code: 'permission_denied', message: body.message ?? 'brief summary render is not permitted for this user' }
    }
    return { ok: false, code: 'job_failed', message: body.message ?? `brief summary render failed (${res.status})` }
  }

  let body: { summary?: unknown; model?: unknown }
  try {
    body = (await res.json()) as typeof body
  } catch {
    return { ok: false, code: 'job_failed', message: 'brief summary backend returned an unreadable response' }
  }
  if (typeof body.summary !== 'string' || body.summary.trim() === '') {
    return { ok: false, code: 'job_failed', message: 'brief summary backend returned no summary' }
  }
  return {
    ok: true,
    summary: body.summary,
    model: typeof body.model === 'string' && body.model !== '' ? body.model : 'unknown',
  }
}
