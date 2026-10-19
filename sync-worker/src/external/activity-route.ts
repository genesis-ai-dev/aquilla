// Project activity feed — the polling surface for "something happened" triggers
// (Zapier and any other poller; plan workstream B).
//
//   GET /api/v1/external/projects/:projectId/activity?kinds=&fileId=&limit=&cursor=
//
// Newest first. A poller keeps the first page and dedupes on `id`, so the two
// properties that matter are (1) the newest events are always on page 1 and
// (2) walking `nextCursor` never repeats or skips an event, even while new ones
// land between calls.
//
// That is why the cursor is a KEYSET on `server_seq` (`server_seq < cursor`),
// not the offset cursor in pagination.ts: with an offset, every event inserted
// between two calls pushes the window down and the next page repeats rows.
// `server_seq` is unique per project (idx_events_project_seq_id) and allocated
// under a per-project row lock, so a new event always sorts above every cursor
// already handed out.
//
// Scan window: each call reads at most ACTIVITY_SCAN_WINDOW events of the
// project below the cursor. A filter on a rare kind therefore cannot turn into
// a whole-project scan (there is deliberately no `kind` index — it would slow
// writes on the hottest table). When the window runs out before the page
// fills, the page comes back short (possibly empty) and `nextCursor` points
// just below the window, so the caller can keep walking without a gap.
//
// Payloads never pass through raw: they carry validator and assignee identities
// (`cell.unvalidate.targetUsername`, …). Each kind has an ALLOWLIST of fields
// (see projectActivityData); everything else is dropped. Authors and `@[name]`
// mentions in comment bodies go through pii.ts like every other read.

import { externalError } from "./errors"
import { mapHistoryRow, type EventRowRaw } from "./read-routes"
import { authenticateAndScope, checkReadRateLimit, type ExternalReadsEnv } from "./read-auth"
import { mapAuthor, recordAgentRead, resolveAuthorshipPolicy, scrubAuthorField, type AuthorshipPolicy } from "./pii"
import { visibleTagsForMember } from "../../../db/shared/lane-visibility"
import { lanesForRequestedTag, type LaneIdentity } from "../../../src/lib/lanes/read-wall"

const ACTIVITY_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/activity$/

/** Max events one call may scan, whatever the filters. */
export const ACTIVITY_SCAN_WINDOW = 5000
export const ACTIVITY_DEFAULT_LIMIT = 50
export const ACTIVITY_MAX_LIMIT = 100

/** Bookkeeping kinds that describe replication, not anything a person did. */
function isInternalKind(kind: string): boolean {
  return kind.endsWith(".mirror") || kind === "link.cursor.advance"
}

const KIND_RE = /^[a-z][a-z.]*[a-z]$/

export interface ActivityItem {
  id: string
  kind: string
  fileId: string | null
  cellId: string | null
  serverSeq: number
  serverTs: number
  author?: string | null
  data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Cursor — opaque base64url of { s: serverSeq }. A cursor we cannot read is a
// 400, not "start over": restarting a keyset walk silently would re-deliver
// every event the caller already has.
// ---------------------------------------------------------------------------

function toBase64Url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
  return atob(padded + pad)
}

export function encodeActivityCursor(serverSeq: number): string {
  return toBase64Url(JSON.stringify({ s: serverSeq }))
}

export function decodeActivityCursor(cursor: string): number | null {
  try {
    const parsed = JSON.parse(fromBase64Url(cursor)) as { s?: unknown }
    return typeof parsed.s === "number" && Number.isSafeInteger(parsed.s) && parsed.s > 0 ? parsed.s : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Per-kind payload allowlist
// ---------------------------------------------------------------------------

function pick(payload: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const v = payload[key]
    if (v === undefined) continue
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = v
  }
  return out
}

const LANE_KEYS = ["laneId", "targetLang"] as const

/**
 * The fields of one event's payload an external caller may see. Kinds not
 * listed here return `{}` — the item still says what happened (kind, file,
 * cell, author, time), just not with what.
 */
export function projectActivityData(kind: string, payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return {}
  const p = payload as Record<string, unknown>
  switch (kind) {
    case "comment.create": {
      const out = pick(p, ["commentId", "body", "parentCommentId", "viaAgent"])
      const scope = p.scope as { kind?: unknown } | undefined
      if (scope && typeof scope.kind === "string") out.scope = scope.kind
      return out
    }
    case "comment.edit":
      return pick(p, ["commentId", "body"])
    case "comment.resolve":
      return pick(p, ["commentId", "resolved"])
    case "comment.delete":
      return pick(p, ["commentId"])
    case "target.cell.commit":
    case "target.cell.create": {
      const out = pick(p, ["value", ...LANE_KEYS])
      // Provenance objects stay server-side; whether a model drafted it is enough.
      if (p.ai_draft !== undefined || p.ai_suggestion === true) out.aiDrafted = true
      return out
    }
    case "target.cell.delete":
      return pick(p, LANE_KEYS)
    case "source.cell.create":
    case "source.cell.commit":
      return pick(p, ["value"])
    case "cell.validate":
    case "cell.unvalidate":
      // NOT targetUsername — that names the validator being overridden.
      return pick(p, ["editEventId", ...LANE_KEYS])
    case "file.create":
      return pick(p, ["name", "fileType", "bookCode"])
    case "file.rename":
      return pick(p, ["name"])
    default:
      return {}
  }
}

/** Lane-scoped kinds carry `laneId`/`targetLang`; everything else is lane-free. */
function isLaneScopedKind(kind: string): boolean {
  return kind.startsWith("target.") || (kind.startsWith("cell.") && kind !== "cell.link.set")
}

const MENTION_RE = /@\[([^\]]+)\]/g

/** `@[username]` is the stored mention form (src/lib/comments/mention-suggest.ts).
 *  The handle inside is as identifying as the author field, so it gets the same
 *  policy: pseudonym by default, a neutral placeholder under `none`. */
async function scrubMentions(
  body: string,
  policy: AuthorshipPolicy,
  secret: string | undefined,
  projectId: string,
): Promise<string> {
  if (policy === "real" || !body.includes("@[")) return body
  const names = new Set<string>()
  for (const m of body.matchAll(MENTION_RE)) names.add(m[1]!)
  const mapped = new Map<string, string>()
  for (const name of names) {
    const value = await mapAuthor(name, policy, secret, projectId)
    mapped.set(name, typeof value === "string" && value !== name ? value : "someone")
  }
  return body.replace(MENTION_RE, (_all, name: string) => `@[${mapped.get(name) ?? "someone"}]`)
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface ActivityRow extends EventRowRaw {
  file_id: string | null
  cell_id: string | null
}

async function handleExternalActivity(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response
  const db = env.AQUILLA_PG as AquillaDb
  const limited = await checkReadRateLimit(db, authed.ctx.credential)
  if (limited) return limited

  const url = new URL(request.url)
  const limitParam = url.searchParams.get("limit")
  let limit = ACTIVITY_DEFAULT_LIMIT
  if (limitParam !== null) {
    const n = Number(limitParam)
    if (!Number.isInteger(n) || n < 1) return externalError("validation_failed", "limit must be a positive integer", 400)
    limit = Math.min(n, ACTIVITY_MAX_LIMIT)
  }

  const cursorParam = url.searchParams.get("cursor")
  let below: number | null = null
  if (cursorParam) {
    below = decodeActivityCursor(cursorParam)
    if (below === null) return externalError("validation_failed", "invalid cursor", 400)
  }

  const kindsParam = url.searchParams.get("kinds")
  let kinds: string[] | null = null
  if (kindsParam) {
    kinds = [...new Set(kindsParam.split(",").map((k) => k.trim()).filter(Boolean))]
    const bad = kinds.find((k) => !KIND_RE.test(k))
    if (bad !== undefined) return externalError("validation_failed", `invalid kind "${bad}"`, 400)
    // Internal kinds are never served, so asking for only them is an empty feed.
    kinds = kinds.filter((k) => !isInternalKind(k))
    if (kinds.length === 0) return Response.json({ items: [], nextCursor: null })
  }
  const fileId = url.searchParams.get("fileId")

  const seqBound = below !== null ? " AND server_seq < ?" : ""
  const seqBinds = below !== null ? [below] : []

  // 1. The floor of this call's scan window: the WINDOW-th newest seq below the
  //    cursor. Null = fewer events than that remain, so the window reaches the
  //    start of the project.
  const floorRow = await db
    .prepare(
      `SELECT server_seq FROM events WHERE project_id = ?${seqBound} ` +
        "ORDER BY server_seq DESC LIMIT 1 OFFSET ?",
    )
    .bind(projectId, ...seqBinds, ACTIVITY_SCAN_WINDOW - 1)
    .first<{ server_seq: number | string }>()
  const floor = floorRow ? Number(floorRow.server_seq) : null

  // 2. The filtered page inside that window, one row over to detect "more".
  let filters = " AND kind NOT LIKE '%.mirror' AND kind <> 'link.cursor.advance'"
  const filterBinds: unknown[] = []
  if (floor !== null) {
    filters += " AND server_seq >= ?"
    filterBinds.push(floor)
  }
  if (kinds) {
    filters += ` AND kind IN (${kinds.map(() => "?").join(", ")})`
    filterBinds.push(...kinds)
  }
  if (fileId) {
    filters += " AND file_id = ?"
    filterBinds.push(fileId)
  }
  const { results } = await db
    .prepare(
      "SELECT id, parent_id, kind, author, payload, client_ts, server_ts, server_seq, file_id, cell_id " +
        `FROM events WHERE project_id = ?${seqBound}${filters} ` +
        "ORDER BY server_seq DESC LIMIT ?",
    )
    .bind(projectId, ...seqBinds, ...filterBinds, limit + 1)
    .all<ActivityRow>()

  const rows = results.slice(0, limit)
  let nextCursor: string | null = null
  if (results.length > limit) {
    nextCursor = encodeActivityCursor(Number(rows[rows.length - 1]!.server_seq))
  } else if (floor !== null) {
    // Window exhausted before the page filled: resume just below it.
    nextCursor = encodeActivityCursor(floor)
  }

  // Lane read wall (AQU-730): a walled member must not learn about edits on a
  // lane they cannot read. Filtering here, after the cursor is fixed, can only
  // shorten a page — it never moves the cursor, so it cannot cause a skip.
  const userId = Number(authed.ctx.credential.userId)
  const { visible, lanes } = await visibleTagsForMember(db, env.LANE_READ_WALL, projectId, userId, authed.ctx.role)
  const policy = await resolveAuthorshipPolicy(db, authed.ctx.credential, projectId)

  const items: ActivityItem[] = []
  for (const row of rows) {
    const event = mapHistoryRow(row)
    const data = projectActivityData(event.kind, event.payload)
    if (visible !== null && isLaneScopedKind(event.kind) && !laneVisible(visible, lanes, data)) continue
    if (typeof data.body === "string") {
      data.body = await scrubMentions(data.body, policy, env.SYNC_SECRET_KEY, projectId)
    }
    items.push({
      id: event.id,
      kind: event.kind,
      fileId: row.file_id,
      cellId: row.cell_id,
      serverSeq: Number(event.serverSeq),
      serverTs: Number(event.serverTs),
      author: event.author,
      data,
    })
  }

  const scrubbed = (await scrubAuthorField(items, "author", policy, env.SYNC_SECRET_KEY, projectId)) as ActivityItem[]
  await recordAgentRead(db, {
    credentialId: authed.ctx.credential.credentialId,
    projectId,
    resource: "activity",
    resourceId: fileId,
    rowCount: scrubbed.length,
  })
  return Response.json({ items: scrubbed, nextCursor })
}

/** Same rule as callerMayReadLane (db/shared/lane-visibility.ts), applied per
 *  event against grants loaded once per call. */
function laneVisible(
  visible: ReadonlySet<string>,
  lanes: readonly LaneIdentity[],
  data: Record<string, unknown>,
): boolean {
  const laneId = typeof data.laneId === "string" ? data.laneId.trim() : ""
  if (laneId) return visible.has(laneId)
  const tag = typeof data.targetLang === "string" ? data.targetLang : ""
  const matches = lanesForRequestedTag(lanes, tag)
  return matches.length === 1 && visible.has(matches[0]!.id)
}

export async function handleExternalActivityRequest(
  request: Request,
  env: ExternalReadsEnv,
): Promise<Response | null> {
  if (request.method !== "GET") return null
  const match = new URL(request.url).pathname.match(ACTIVITY_RE)
  if (!match) return null
  return handleExternalActivity(request, env, decodeURIComponent(match[1]!))
}
