/**
 * Client for the org termbase publish/subscribe API.
 *
 * Server contract: docs/swarm/TERM3-ORG-API.md
 * (routes in auth-worker/src/routes/termbase-subscriptions.ts).
 *
 * Every function takes the caller's Bearer JWT (obtained from
 * `useFrontierSession().session.jwt`, mirroring src/lib/frontier/members.ts)
 * and hits `${FRONTIER_BASE}/api/v2/...`. JSON shapes match the contract
 * exactly.
 */

import { FRONTIER_BASE } from "../frontier/auth"
import type { MessageKey } from "../i18n/messages/en"
import { t } from "../i18n/standalone"

function authHeaders(jwt: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  }
}

/** Thrown when a termbase API call returns a non-2xx the caller should surface. */
export class TermbaseApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "TermbaseApiError"
    this.status = status
  }
}

/**
 * AQU-820: the message is OURS — a translated sentence chosen by the call site
 * (TermbaseSharingSection renders `e.message` verbatim). The server's `error`
 * string is untranslated and often a raw diagnostic, so it is kept on `cause`
 * for DevTools rather than shown to the user.
 */
async function readError(res: Response, fallbackKey: MessageKey): Promise<never> {
  let detail = ""
  try {
    const body = (await res.json()) as { error?: string }
    detail = body?.error ?? ""
  } catch {
    // non-JSON body; nothing to preserve
  }
  const err = new TermbaseApiError(t(fallbackKey), res.status)
  err.cause = `HTTP ${res.status}${detail ? ` — ${detail.slice(0, 400)}` : ""}`
  throw err
}

// ── Shapes (mirror the contract) ───────────────────────────────────────────

/** Endpoint 3 item: an org's published termbase. */
export interface PublishedTermbase {
  projectId: string
  name: string
  createdBy: string
}

/** Endpoint 4 item: a subscription row, enriched with the upstream name. */
export interface TermbaseSubscription {
  termbaseProjectId: string
  termbaseName: string
  /** Lower = higher precedence. */
  priority: number
  createdAt: string
  /** false once the upstream unpublishes (subscription goes inert). */
  published: boolean
}

/** Endpoint 5 response item (no name/published — those come from GET). */
export interface CreatedSubscription {
  termbaseProjectId: string
  priority: number
  createdAt: string
}

// ── 1. Publish ──────────────────────────────────────────────────────────────

/** POST /projects/:id/termbase/publish — maintainer 600+, org-owned project. */
export async function publishTermbase(
  jwt: string,
  projectId: string,
): Promise<{ projectId: string; published: true }> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/termbase/publish`,
    { method: "POST", headers: authHeaders(jwt) },
  )
  if (!res.ok) return readError(res, "error.termbase.publish")
  return (await res.json()) as { projectId: string; published: true }
}

// ── 2. Unpublish ──────────────────────────────────────────────────────────────

/** DELETE /projects/:id/termbase/publish — maintainer 600+. */
export async function unpublishTermbase(
  jwt: string,
  projectId: string,
): Promise<{ projectId: string; published: false }> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/termbase/publish`,
    { method: "DELETE", headers: authHeaders(jwt) },
  )
  if (!res.ok) return readError(res, "error.termbase.unpublish")
  return (await res.json()) as { projectId: string; published: false }
}

// ── 3. List an org's published termbases ─────────────────────────────────────

/** GET /orgs/:orgId/published-termbases — any org member. */
export async function listPublishedTermbases(
  jwt: string,
  orgId: number,
): Promise<PublishedTermbase[]> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/orgs/${encodeURIComponent(String(orgId))}/published-termbases`,
    { headers: authHeaders(jwt) },
  )
  if (!res.ok) return readError(res, "error.termbase.listPublished")
  const body = (await res.json()) as { termbases: PublishedTermbase[] }
  return body.termbases ?? []
}

// ── 4. List a project's subscriptions ────────────────────────────────────────

/** GET /projects/:id/termbase/subscriptions — viewer 100+ on project. */
export async function listSubscriptions(
  jwt: string,
  projectId: string,
): Promise<TermbaseSubscription[]> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/termbase/subscriptions`,
    { headers: authHeaders(jwt) },
  )
  if (!res.ok) return readError(res, "error.termbase.listSubscriptions")
  const body = (await res.json()) as { subscriptions: TermbaseSubscription[] }
  return body.subscriptions ?? []
}

// ── 5. Subscribe (idempotent on PK) ──────────────────────────────────────────

/**
 * POST /projects/:id/termbase/subscriptions — maintainer 600+.
 * `priority` omitted ⇒ server appends at the end. Re-POST updates priority.
 */
export async function subscribeTermbase(
  jwt: string,
  projectId: string,
  termbaseProjectId: string,
  priority?: number,
): Promise<CreatedSubscription> {
  const body: { termbaseProjectId: string; priority?: number } = { termbaseProjectId }
  if (priority != null) body.priority = priority
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/termbase/subscriptions`,
    { method: "POST", headers: authHeaders(jwt), body: JSON.stringify(body) },
  )
  if (!res.ok) return readError(res, "error.termbase.subscribe")
  const json = (await res.json()) as { subscription: CreatedSubscription }
  return json.subscription
}

// ── 6. Unsubscribe ───────────────────────────────────────────────────────────

/** DELETE /projects/:id/termbase/subscriptions/:termbaseProjectId — maintainer 600+. */
export async function unsubscribeTermbase(
  jwt: string,
  projectId: string,
  termbaseProjectId: string,
): Promise<{ ok: true }> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/termbase/subscriptions/${encodeURIComponent(termbaseProjectId)}`,
    { method: "DELETE", headers: authHeaders(jwt) },
  )
  if (!res.ok) return readError(res, "error.termbase.unsubscribe")
  return (await res.json()) as { ok: true }
}

// ── 7. Reorder (priority) ────────────────────────────────────────────────────

/**
 * PATCH /projects/:id/termbase/subscriptions — maintainer 600+.
 * `order` = termbaseProjectIds in desired precedence; index 0 = priority 0 =
 * highest precedence. Unknown ids are ignored. Returns the same shape as GET.
 */
export async function reorderSubscriptions(
  jwt: string,
  projectId: string,
  order: string[],
): Promise<TermbaseSubscription[]> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/termbase/subscriptions`,
    { method: "PATCH", headers: authHeaders(jwt), body: JSON.stringify({ order }) },
  )
  if (!res.ok) return readError(res, "error.termbase.reorder")
  const body = (await res.json()) as { subscriptions: TermbaseSubscription[] }
  return body.subscriptions ?? []
}
