// External comment reads (AQU-1233 — Agent API cell comments).
//
//   GET /api/v1/external/projects/:projectId/comments
//   Query params (all optional):
//     fileId  — filter to one file's threads
//     cellId  — filter to one cell's threads (requires fileId)
//     limit   — page size (default 50, max 200)
//     cursor  — opaque keyset cursor from a previous page's `nextCursor`
//
// Why this exists: comments are where a reviewer says "this rendering is wrong,
// use the 1984 wording". Before this route an agent could rewrite the cell but
// never see the objection, and a reviewer's question sat unanswered until the
// agent's operator opened the browser themselves.
//
// Reads are a thin wrapper over the in-app comments read route
// (events/comments-read-route.ts) — same query, same keyset cursor, same
// (created_at, comment_id) ordering — so what an agent lists is by construction
// what the in-app drawer shows, rather than a second query drifting from it.
//
// The WRITE side already exists and is deliberately not duplicated here: a
// reply is an `EmitEvents` changeset carrying one `comment.create` with
// `parentCommentId` (see commands-emit-events.ts). It authors as the
// credential's minting user, marks the comment agent-posted (AQU-1233 —
// events/comment-authorship.ts), and routes through the /events perimeter, so
// the normal comment notification path fires unchanged.
//
// ── Identity ────────────────────────────────────────────────────────────────
// Comment authors are people, and everything this API returns lands in whatever
// AI console holds the token. Identity handling is delegated entirely to
// `external/pii.ts` (AQU-1180): pseudonymous by default (a stable per-project
// opaque id, `u_3f9ab21c`), real usernames only for a credential minted `pii:
// true`, and the field dropped ENTIRELY when the project itself has opted out
// via `agentAuthorship: 'none'` — the project's choice always wins over the
// credential's, per pii.ts's documented invariant. This route used to carry a
// second, hand-rolled copy of the pseudonym scheme that only ever consulted
// the credential flag, so a project's `'none'` opt-out was silently ignored
// here even though every other read route already honoured it (found in the
// 2026-09-17 pen test).

import { isAgentAuthoredLabel } from "../events/comment-authorship"
import { handleCommentsReadRequest, type CommentRowOut } from "../events/comments-read-route"
import { externalError } from "./errors"
import { mintInternalToken } from "./read-routes"
import { authenticateAndScope, checkReadRateLimit, type ExternalReadsEnv } from "./read-auth"
import { resolveAuthorshipPolicy, scrubAuthorField } from "./pii"

const COMMENTS_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/comments$/

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** One comment as the Agent API reports it. */
export interface ExternalCommentOut {
  commentId: string
  scopeKind: "cell" | "file" | "project"
  fileId: string | null
  cellId: string | null
  /** Canonical reference of the cell the thread hangs on (e.g. "GEN 1:1"). */
  cellRef: string | null
  /** null = a root thread; otherwise the thread this reply belongs to. */
  parentCommentId: string | null
  body: string
  resolved: boolean
  /** Pseudonymous per-project id by default; the real username on a `pii`
   *  credential; ABSENT entirely when the project has set `agentAuthorship:
   *  'none'`. Machine authors ("importer") pass through under every policy. */
  author: string | undefined
  /** True when the comment was posted through the Agent API rather than typed
   *  by its author — so an agent can tell its own prior replies from a human's. */
  viaAgent: boolean
  createdAt: number
  updatedAt: number
  /** Non-null on a soft-deleted comment; its body reads "" (the row stays so
   *  the thread remains navigable). */
  deletedAt: number | null
}

/**
 * Map one in-app comment row to its agent-facing shape.
 *
 * `authorLabel` never reaches the caller: it is a display string that carries
 * the human's name AND (for agent-posted comments) the marker suffix. The
 * marker is reported as the boolean `viaAgent`; `author` is scrubbed by the
 * caller via `scrubAuthorField` once every row has been mapped.
 */
function toExternal(row: CommentRowOut): ExternalCommentOut {
  return {
    commentId: row.commentId,
    scopeKind: row.scopeKind,
    fileId: row.fileId,
    cellId: row.cellId,
    cellRef: row.cellRef,
    parentCommentId: row.parentCommentId,
    body: row.body,
    resolved: row.resolved,
    author: row.authorId,
    viaAgent: isAgentAuthoredLabel(row.authorLabel),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }
}

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT
  const parsed = parseInt(raw, 10)
  if (isNaN(parsed)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, parsed))
}

async function handleExternalComments(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response
  const db = env.AQUILLA_PG as AquillaDb
  const limited = await checkReadRateLimit(db, authed.ctx.credential.credentialId)
  if (limited) return limited

  const url = new URL(request.url)
  const fileId = url.searchParams.get("fileId")
  const cellId = url.searchParams.get("cellId")
  if (cellId !== null && fileId === null) {
    return externalError("validation_failed", "cellId requires fileId", 400)
  }

  // Delegate to the in-app route: identical filters and the same keyset cursor,
  // so a page here is byte-for-byte the page the comments drawer would render.
  const internalUrl = new URL(request.url)
  internalUrl.pathname = `/api/v1/projects/${encodeURIComponent(projectId)}/comments`
  internalUrl.search = ""
  if (fileId !== null) internalUrl.searchParams.set("fileId", fileId)
  if (cellId !== null) internalUrl.searchParams.set("cellId", cellId)
  internalUrl.searchParams.set("limit", String(parseLimit(url.searchParams.get("limit"))))
  const cursor = url.searchParams.get("cursor")
  if (cursor !== null) internalUrl.searchParams.set("cursor", cursor)

  const token = await mintInternalToken(env, authed.ctx, projectId, "")
  const internalRes = await handleCommentsReadRequest(
    new Request(internalUrl.toString(), { headers: { Authorization: `Bearer ${token}` } }),
    env,
  )
  if (!internalRes) return externalError("not_found", "comments route did not match", 404)
  if (!internalRes.ok) {
    return externalError("validation_failed", await internalRes.text(), internalRes.status)
  }

  const body = (await internalRes.json()) as { comments: CommentRowOut[]; nextCursor: string | null }
  const policy = await resolveAuthorshipPolicy(db, authed.ctx.credential, projectId)
  const data = (await scrubAuthorField(
    body.comments.map(toExternal),
    "author",
    policy,
    env.SYNC_SECRET_KEY,
    projectId,
  )) as ExternalCommentOut[]
  return Response.json({ data, nextCursor: body.nextCursor })
}

export async function handleExternalCommentsRequest(
  request: Request,
  env: ExternalReadsEnv,
): Promise<Response | null> {
  if (request.method !== "GET") return null
  const match = new URL(request.url).pathname.match(COMMENTS_RE)
  if (!match) return null
  return handleExternalComments(request, env, decodeURIComponent(match[1]))
}
