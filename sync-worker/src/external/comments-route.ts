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
// AI console holds the token. So author identity is pseudonymous BY DEFAULT
// here: `author` is a stable per-project opaque id (`u_3f9ab21c`), never a
// username, unless the credential was explicitly minted to see real identities.
//
// The pseudonym scheme (HMAC-SHA256(SYNC_SECRET_KEY, `${projectId} ${author}`),
// first 8 hex, `u_` prefix) is deliberately identical to the one AQU-1180 is
// landing in external/pii.ts, so the ids agree across surfaces and this module
// collapses into a `mapAuthor()` call once that lands — see the note on
// `resolveIdentityMode` below.

import { isAgentAuthoredLabel } from "../events/comment-authorship"
import type { ApiCredentialContext } from "../../../db/shared/api-credentials"
import { handleCommentsReadRequest, type CommentRowOut } from "../events/comments-read-route"
import { externalError } from "./errors"
import {
  authenticateAndScope,
  checkReadRateLimit,
  mintInternalToken,
  type ExternalReadsEnv,
} from "./read-routes"

const COMMENTS_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/comments$/

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** How much of the HMAC a pseudonym keeps. 8 hex = 32 bits: two translators on
 *  one project colliding into a single identity is negligible, where the 4-char
 *  form collides at even odds around 300 distinct authors. Matches AQU-1180. */
const PSEUDONYM_HEX = 8

/** Author strings that name a machine rather than a person — nothing to hide,
 *  and far more useful to an agent passed through than hashed. */
const NON_HUMAN_AUTHORS = new Set(["importer", "system", "agent"])

/**
 * Whether this credential may see real identities.
 *
 * The `pii` grant is minted on the credential by AQU-1180 (owner-only, default
 * off). That column is not on `main` yet, so the flag is read optionally: a
 * credential without it is pseudonymous, which is the safe direction. When
 * AQU-1180 lands this becomes a call to `resolveAuthorshipPolicy()` from
 * external/pii.ts (which additionally honours a project's `agentAuthorship:
 * none` opt-out by dropping author fields entirely) — the default behaviour
 * here does not change when it does.
 */
export function resolveIdentityMode(cred: ApiCredentialContext & { pii?: boolean }): "real" | "pseudonymous" {
  return cred.pii === true ? "real" : "pseudonymous"
}

/** Hex of an HMAC-SHA256 over `message`, keyed by the worker secret. */
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))
  let hex = ""
  for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, "0")
  return hex
}

/**
 * Stable per-project pseudonym for one author string.
 *
 * Keyed by the worker secret so it cannot be reversed with a username
 * dictionary, and salted by the project so the same translator is a DIFFERENT
 * id in each project — two agents comparing notes across projects cannot
 * re-identify anyone by intersecting the ids they hold.
 */
export async function commentAuthorPseudonym(
  secret: string,
  projectId: string,
  author: string,
): Promise<string> {
  const digest = await hmacHex(secret, `${projectId} ${author}`)
  return `u_${digest.slice(0, PSEUDONYM_HEX)}`
}

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
   *  credential. Machine authors ("importer") pass through either way. */
  author: string
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
 * marker is reported as the boolean `viaAgent`; the name is reduced to
 * `author` under the identity mode.
 */
async function toExternal(
  row: CommentRowOut,
  mode: "real" | "pseudonymous",
  secret: string,
  projectId: string,
  pseudonyms: Map<string, string>,
): Promise<ExternalCommentOut> {
  let author = row.authorId
  if (mode === "pseudonymous" && author !== "" && !NON_HUMAN_AUTHORS.has(author)) {
    // One HMAC per distinct author per page, not one per row: a 200-comment
    // thread written by two people costs two hashes.
    const cached = pseudonyms.get(author)
    if (cached !== undefined) {
      author = cached
    } else {
      const pseudonym = await commentAuthorPseudonym(secret, projectId, author)
      pseudonyms.set(row.authorId, pseudonym)
      author = pseudonym
    }
  }
  return {
    commentId: row.commentId,
    scopeKind: row.scopeKind,
    fileId: row.fileId,
    cellId: row.cellId,
    cellRef: row.cellRef,
    parentCommentId: row.parentCommentId,
    body: row.body,
    resolved: row.resolved,
    author,
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
  const mode = resolveIdentityMode(authed.ctx.credential)
  const secret = env.SYNC_SECRET_KEY as string
  const pseudonyms = new Map<string, string>()
  const data: ExternalCommentOut[] = []
  for (const row of body.comments) {
    data.push(await toExternal(row, mode, secret, projectId, pseudonyms))
  }
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
