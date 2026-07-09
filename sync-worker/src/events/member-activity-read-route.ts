// Per-member activity read route (AQU-498).
//
//   GET /api/v1/projects/:projectId/members/:author/activity
//
// Lets a team lead select a member and see what they've been doing, straight
// off the event log (AD-2 source of truth) rather than a separate rollup
// table — no new write path, no new projection.
//
//   - recentEvents: the member's most recent events on this project, newest
//     first (same shape/ordering convention as cell-history-read-route.ts).
//   - fileRollup: per-file volume + timing, derived from the `cells`
//     projection's `last_editor`/`word_count` columns — NOT from replaying
//     every event. This deliberately reconciles with project totals: each
//     row here is a strict SQL subset (`last_editor = :author`) of the exact
//     same `cells` rows that feed the file-level word/cell counts shown
//     elsewhere on the dashboard (see files-read-route.ts, portfolio.ts), so
//     a member's contributions can never sum to MORE than the project total.
//     It undercounts vs. a full event replay (only the CURRENT owner of a
//     cell is counted, not every historical editor of a re-edited cell) —
//     acceptable for "what has this person been doing lately," and far
//     simpler / cheaper than parsing every commit payload for word deltas.
//
// `:author` is the events.author / cells.last_editor value — the acting
// user's Aquilla username (see events-emit.ts callers: `author: username`),
// NOT a numeric user id.
//
// Auth: sync-token JWT scoped to `projectId`. Additionally gated by the
// org's memberProgressViewMinRole floor (AQU-485) — see
// member-progress-floor.ts. A caller below the floor gets 403, mirroring the
// client-side SectionVisibilityGate so the API can't be used to bypass the
// dashboard's hard gate.

import { verifyTokenForProject } from "../auth"
import { resolveMemberProgressFloor } from "./member-progress-floor"

export interface MemberActivityReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

interface RecentEventRow {
  id: string
  kind: string
  file_id: string | null
  cell_id: string | null
  client_ts: number
  server_ts: number
  server_seq: number
}

interface FileRollupRow {
  file_id: string
  file_name: string
  cells_touched: number
  word_count: number
  last_activity_at: number | null
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/members\/([^/]+)\/activity$/

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export async function handleMemberActivityReadRequest(
  request: Request,
  env: MemberActivityReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== "GET") return null

  if (!env.SYNC_SECRET_KEY) {
    return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  }
  if (!env.AQUILLA_PG) {
    return new Response("AQUILLA_PG binding not configured", { status: 500 })
  }

  const projectId = decodeURIComponent(match[1])
  const author = decodeURIComponent(match[2])

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) {
    return new Response("missing Authorization header", { status: 401 })
  }

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) {
    return new Response(auth.reason, { status: auth.status })
  }

  const floor = await resolveMemberProgressFloor(env.AQUILLA_PG, projectId)
  if (auth.claims.role < floor) {
    return new Response("insufficient role for member-progress view", { status: 403 })
  }

  let limit = DEFAULT_LIMIT
  const qLimit = url.searchParams.get("limit")
  if (qLimit !== null) {
    const parsed = parseInt(qLimit, 10)
    if (!isNaN(parsed)) {
      limit = Math.min(MAX_LIMIT, Math.max(1, parsed))
    }
  }

  const [recentRes, rollupRes] = await Promise.all([
    env.AQUILLA_PG.prepare(
      "SELECT id, kind, file_id, cell_id, client_ts, server_ts, server_seq " +
        "FROM events " +
        "WHERE project_id = ? AND author = ? " +
        "ORDER BY server_seq DESC, id DESC " +
        "LIMIT ?",
    )
      .bind(projectId, author, limit)
      .all<RecentEventRow>(),
    env.AQUILLA_PG.prepare(
      "SELECT c.file_id AS file_id, f.name AS file_name, " +
        "COUNT(*) AS cells_touched, COALESCE(SUM(c.word_count), 0) AS word_count, " +
        "MAX(c.last_edit_at) AS last_activity_at " +
        "FROM cells c JOIN files f ON f.id = c.file_id " +
        "WHERE c.project_id = ? AND c.last_editor = ? AND f.deleted_at IS NULL " +
        "GROUP BY c.file_id, f.name " +
        "ORDER BY last_activity_at DESC",
    )
      .bind(projectId, author)
      .all<FileRollupRow>(),
  ])

  const recentEvents = recentRes.results.map((row) => ({
    id: row.id,
    kind: row.kind,
    fileId: row.file_id,
    cellId: row.cell_id,
    clientTs: row.client_ts,
    serverTs: row.server_ts,
    serverSeq: row.server_seq,
  }))

  const fileRollup = rollupRes.results.map((row) => ({
    fileId: row.file_id,
    fileName: row.file_name,
    cellsTouched: Number(row.cells_touched),
    wordCount: Number(row.word_count),
    lastActivityAt: row.last_activity_at,
  }))

  return Response.json({ recentEvents, fileRollup })
}
