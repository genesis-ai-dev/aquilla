// sync-worker → auth-worker bridge for the L1 brief-summary render (AQU-1282 §2).
//
// The copilot reads `translationBrief.l1Summary`, which is an LLM render of the
// brief's sections. The render lives in auth-worker (it owns the OpenRouter key,
// the model allowlist, and the credit ledger — see
// auth-worker/src/routes/ai-brief-internal.ts); this module calls it with the
// same shared-secret pattern as commands-draft-cells.ts::requestDrafts.
//
// AQU-2191: it also calls it over the same TRANSPORT. `fetchIdentity` prefers
// the `AUTH_WORKER` service binding, because a global fetch to this zone's own
// `api.*.aquilla.app` host bypasses the Worker route and goes to the zone
// origin — which does not exist, so Cloudflare answers 522 and the render never
// reaches auth-worker at all. The bare `fetch` this used to do made the brief
// unrenderable on every deployed environment while DraftCells (binding-first
// since AQU-1186) kept working.
//
// Unlike requestDrafts this NEVER throws: SetBrief's auto-render is
// best-effort (the sections are already committed when it runs), and
// RegenerateBriefSummary wants to answer with a named code without consuming
// the human's approval. `not_configured` is what a test env (no
// AUTH_WORKER_URL) and a mis-wired deploy both look like.

import { fetchIdentity, type IdentityTransport } from './identity-bridge'

export interface BriefSummaryBridgeEnv extends IdentityTransport {
  AUTH_WORKER_URL?: string
  SYNC_SECRET_KEY?: string
}

export type BriefSummaryFailureCode = 'not_configured' | 'rate_limited' | 'permission_denied' | 'job_failed'

export type BriefSummaryResult =
  | {
      ok: true
      summary: string
      model: string
      /** The render exceeded `BRIEF_L1_MAX_CHARS` and was clipped, so some of
       *  the brief's sections are NOT represented in what the copilot reads
       *  (AQU-1323). Absent on an auth-worker older than the flag → `false`;
       *  that under-reports truncation rather than inventing it. */
      truncated: boolean
    }
  | { ok: false; code: BriefSummaryFailureCode; message: string }

/** Statuses Cloudflare's edge generates when it cannot get an answer from an
 *  origin. auth-worker's renderer only ever answers 401/403/429/500/502/504, so
 *  one of these proves the request never reached it — and therefore that
 *  nothing auth-worker could log will show the failure (AQU-2191). */
const EDGE_GENERATED_STATUSES = new Set([520, 521, 522, 523, 524, 525, 526, 527, 530])

/** AQU-2191: the render failed silently from the outside — the only trace was
 *  the API error string, so three weeks of total failure left nothing in logs
 *  or error tracking. Every failure now writes one line a Logpush/PostHog query
 *  can find by its prefix. */
function fail(
  code: BriefSummaryFailureCode,
  message: string,
  context: { projectId: string; status?: number; host?: string },
): BriefSummaryResult {
  console.error(
    '[brief-summary-render] failed',
    JSON.stringify({ code, message, ...context }),
  )
  return { ok: false, code, message }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export async function renderBriefSummary(
  env: BriefSummaryBridgeEnv,
  input: { projectId: string; userId: string | number; l2Markdown: string },
): Promise<BriefSummaryResult> {
  if (!env.AUTH_WORKER_URL || !env.SYNC_SECRET_KEY) {
    return fail('not_configured', 'brief summary backend is not configured in this environment', {
      projectId: input.projectId,
    })
  }
  const host = hostOf(env.AUTH_WORKER_URL)

  let res: Response
  try {
    res = await fetchIdentity(env, `${env.AUTH_WORKER_URL}/api/v1/ai/agent/internal/brief-summary`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    })
  } catch {
    return fail('job_failed', 'brief summary backend unreachable', { projectId: input.projectId, host })
  }

  if (!res.ok) {
    let body: { error?: string; message?: string; reason?: string } = {}
    try {
      body = (await res.json()) as typeof body
    } catch {
      /* non-JSON upstream error — fall through to the generic message */
    }
    if (body.error === 'credit_cap_exceeded' || res.status === 429) {
      return fail(
        'rate_limited',
        body.message ?? `credit cap reached on the agent rail (${body.reason ?? 'cap'})`,
        { projectId: input.projectId, status: res.status, host },
      )
    }
    if (res.status === 403) {
      return fail(
        'permission_denied',
        body.message ?? 'brief summary render is not permitted for this user',
        { projectId: input.projectId, status: res.status, host },
      )
    }
    // A 404 is the identity worker ANSWERING and not knowing this route — i.e.
    // auth-worker is older than sync-worker. Worker deploys are manual and
    // per-surface (.github/workflows/deploy-workers.yml), and PR previews point
    // at the shared development backend, so "sync has the command, auth does not
    // have the renderer" is a real, recurring state. Name it instead of letting
    // it read as a transient render failure nobody can act on.
    if (res.status === 404) {
      return fail(
        'not_configured',
        'the identity worker has no brief-summary renderer at ' +
          '/api/v1/ai/agent/internal/brief-summary — auth-worker is behind sync-worker; ' +
          'deploy auth-worker (docs/DEPLOYMENT-ENVIRONMENTS.md). Brief sections are unaffected',
        { projectId: input.projectId, status: res.status, host },
      )
    }
    // AQU-2191: a 52x is CLOUDFLARE answering, not auth-worker — the edge had no
    // origin to reach for this host. Retrying does not help and never did; the
    // wiring is what is wrong, so say which wiring.
    if (EDGE_GENERATED_STATUSES.has(res.status)) {
      return fail(
        'not_configured',
        `Cloudflare answered ${res.status} for ${host} — the brief-summary request never reached ` +
          'the identity worker, so auth-worker logged nothing. The subrequest went to the zone ' +
          'origin instead of the Worker: bind the AUTH_WORKER service binding for this ' +
          'environment (sync-worker/wrangler.toml [[env.<env>.services]]) and redeploy sync-worker. ' +
          'Brief sections are unaffected; retrying the render will not clear this',
        { projectId: input.projectId, status: res.status, host },
      )
    }
    return fail(
      'job_failed',
      body.message ?? `brief summary render failed (${res.status})`,
      { projectId: input.projectId, status: res.status, host },
    )
  }

  let body: { summary?: unknown; model?: unknown; truncated?: unknown }
  try {
    body = (await res.json()) as typeof body
  } catch {
    return fail('job_failed', 'brief summary backend returned an unreadable response', {
      projectId: input.projectId,
      host,
    })
  }
  if (typeof body.summary !== 'string' || body.summary.trim() === '') {
    return fail('job_failed', 'brief summary backend returned no summary', {
      projectId: input.projectId,
      host,
    })
  }
  return {
    ok: true,
    summary: body.summary,
    model: typeof body.model === 'string' && body.model !== '' ? body.model : 'unknown',
    truncated: body.truncated === true,
  }
}
