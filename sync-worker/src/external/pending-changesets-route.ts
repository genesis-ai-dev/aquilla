// Project-wide "plans waiting for a human" feed (plan workstream B).
//
//   GET /api/v1/external/projects/:projectId/changesets/pending?limit=
//
// The existing GET /changesets lists only the calling credential's own plans.
// A "Changeset Needs Approval" trigger has the opposite question: what is
// staged on this project, by anyone, that a person should go approve. So the
// floor is MAINTAINER — the people who can approve — and the DTO is slim:
// enough to say what is waiting and link to it, never the commands (raw
// payloads), the credential id, or the receipt.
//
// `summary` is cut to its numeric counts plus `command`: several summary fields
// are names (`orgMemberUsername`, project/org names), and an allowlist keeps a
// future string field from leaking by default.
//
// Mounted from the read router (read-routes.ts), ahead of changesets-route.ts,
// whose `/changesets/:id` pattern would otherwise read "pending" as an id.

import { externalError } from "./errors"
import { authenticateAndScope, checkReadRateLimit, type ExternalReadsEnv } from "./read-auth"
import { approvalUrlFor } from "./stage"
import { recordAgentRead, resolveAuthorshipPolicy, scrubAuthorField } from "./pii"
import { ROLE } from "../events/role-policy"

const PENDING_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/changesets\/pending$/

export const PENDING_DEFAULT_LIMIT = 25
export const PENDING_MAX_LIMIT = 100

export interface PendingChangesetItem {
  id: string
  createdAt: string
  summary: Record<string, unknown>
  author?: string | null
  approvalUrl: string
}

interface PendingRow {
  id: string
  created_at: unknown
  summary: unknown
  username: string | null
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  return new Date(v as string).toISOString()
}

/** Counts and the command kind only — see the header for why not the rest. */
export function slimSummary(raw: unknown): Record<string, unknown> {
  let parsed = raw
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return {}
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === "command" && typeof value === "string") out.command = value
    else if (typeof value === "number") out[key] = value
  }
  return out
}

async function handlePendingChangesets(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response
  const db = env.AQUILLA_PG as AquillaDb
  const limited = await checkReadRateLimit(db, authed.ctx.credential)
  if (limited) return limited
  if (authed.ctx.role < ROLE.MAINTAINER) {
    return externalError(
      "permission_denied",
      "pending changesets are visible to project maintainers and above (the people who can approve them)",
      403,
    )
  }

  const limitParam = new URL(request.url).searchParams.get("limit")
  let limit = PENDING_DEFAULT_LIMIT
  if (limitParam !== null) {
    const n = Number(limitParam)
    if (!Number.isInteger(n) || n < 1) return externalError("validation_failed", "limit must be a positive integer", 400)
    limit = Math.min(n, PENDING_MAX_LIMIT)
  }

  // Expired plans are still 'staged' until a sweep flips them, but nobody can
  // approve one, so they are not "pending".
  const { results } = await db
    .prepare(
      `SELECT c.id, c.created_at, c.summary, u.username
         FROM changesets c
         LEFT JOIN users u ON u.id::text = c.created_by_user_id
        WHERE c.project_id = ? AND c.status = 'staged' AND c.expires_at > now()
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ?`,
    )
    .bind(projectId, limit)
    .all<PendingRow>()

  const items: PendingChangesetItem[] = results.map((row) => ({
    id: row.id,
    createdAt: toIso(row.created_at),
    summary: slimSummary(row.summary),
    author: row.username,
    approvalUrl: approvalUrlFor(env, row.id),
  }))
  const policy = await resolveAuthorshipPolicy(db, authed.ctx.credential, projectId)
  const data = await scrubAuthorField(items, "author", policy, env.SYNC_SECRET_KEY, projectId)
  await recordAgentRead(db, {
    credentialId: authed.ctx.credential.credentialId,
    projectId,
    resource: "changesets",
    resourceId: null,
    rowCount: data.length,
  })
  // No cursor: this is a short, live queue (staged plans expire), and a poller
  // only ever needs its head. nextCursor stays for shape parity with every
  // other list read.
  return Response.json({ data, nextCursor: null })
}

export async function handleExternalPendingChangesetsRequest(
  request: Request,
  env: ExternalReadsEnv,
): Promise<Response | null> {
  if (request.method !== "GET") return null
  const match = new URL(request.url).pathname.match(PENDING_RE)
  if (!match) return null
  return handlePendingChangesets(request, env, decodeURIComponent(match[1]!))
}
