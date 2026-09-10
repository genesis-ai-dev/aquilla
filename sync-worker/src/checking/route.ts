// AQU-1249: isolated guest capability gateway. Guest JWTs have aud=checking,
// which every ordinary sync endpoint rejects. Only selected cell text/audio
// and new cell comments cross this boundary. Internal sync JWTs never leave
// this module; writes still use the canonical event ingestion/projector.
import { sign, verify } from "hono/jwt"
import { verifyTokenForProject } from "../auth"
import { handleAudioRequest, type AudioEnv } from "../audio"
import { handleEventsWriteRequest, type EventsRouteEnv } from "../events/route"
import { hashPasswordWerkzeugScrypt, verifyPasswordWerkzeugScrypt } from "../../../auth-worker/src/utils/password"
import { createCheckingSchema, joinCheckingSchema, feedbackSchema, inCheckingScope, type CheckingUnit } from "./policy"

export type CheckingEnv = EventsRouteEnv & AudioEnv
interface Link {
  token: string; project_id: string; created_by: number; title: string
  role: "viewer" | "commenter" | "reviewer"; units: CheckingUnit[] | string
  pin_hash: string | null; failed_attempts: number; locked_until: number | null
  expires_at: number; revoked_at: number | null
}
const bearer = (request: Request) => request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? ""
const dead = () => Response.json({ error: "This checking link is unavailable." }, { status: 401 })
const jsonError = (error: string, status = 400) => Response.json({ error }, { status })
function unitsFor(link: Link): CheckingUnit[] {
  return typeof link.units === "string" ? JSON.parse(link.units) as CheckingUnit[] : link.units
}

// Fail closed, including revoked creators, demotion, frozen/archived projects.
async function canShare(db: AquillaDb, projectId: string, userId: number): Promise<boolean> {
  const row = await db.prepare(`SELECT p.id FROM projects p
    WHERE p.id = ? AND p.archived_at IS NULL AND p.is_active = TRUE AND (
      p.created_by = ? OR
      EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ? AND m.role_level >= 500) OR
      EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = p.org_id AND m.user_id = ? AND m.role_level >= 600) OR
      EXISTS (SELECT 1 FROM group_members m JOIN group_project_grants g ON g.group_id = m.group_id
        WHERE g.project_id = p.id AND m.user_id = ? AND g.role_level >= 500))`)
    .bind(projectId, userId, userId, userId, userId).first()
  return !!row
}
async function takeBudget(db: AquillaDb, token: string, kind: "join" | "feedback", max: number) {
  // Column names come exclusively from this closed union, never a request.
  const window = Math.floor(Date.now() / (15 * 60_000))
  const row = await db.prepare(`UPDATE checking_links SET
    ${kind}_count = CASE WHEN ${kind}_window = ? THEN ${kind}_count + 1 ELSE 1 END,
    ${kind}_window = ? WHERE token = ? AND (${kind}_window != ? OR ${kind}_count < ?)
    RETURNING token`).bind(window, window, token, window, max).first()
  return !!row
}
async function internalToken(env: CheckingEnv, link: Link, fileId: string, username: string) {
  const now = Math.floor(Date.now() / 1000)
  return sign({ aud: "sync", userId: Number(link.created_by), username,
    projectId: link.project_id, fileId, role: link.role === "viewer" ? 100 : 200,
    iat: now, exp: now + 60 }, env.SYNC_SECRET_KEY!, "HS256")
}

export async function handleCheckingRequest(request: Request, env: CheckingEnv,
  ctx?: Pick<ExecutionContext, "waitUntil">): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith("/checking")) return null
  if (!env.AQUILLA_PG || !env.SYNC_SECRET_KEY) return jsonError("Checking is unavailable.", 503)
  const db = env.AQUILLA_PG
  const route = url.pathname.match(/^\/checking(?:\/([a-f0-9]{64})(?:\/(join|content|events|revoke|audio))?)?$/)
  if (!route) return jsonError("Not found", 404)
  // Small bodies protect the public join endpoint and bounded WIP selections.
  async function body() {
    const reader = request.body?.getReader()
    if (!reader) throw new SyntaxError("Missing body")
    const decoder = new TextDecoder()
    let text = ""
    let size = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 600_000) { await reader.cancel(); throw new RangeError("Request too large") }
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  }
  try {
    if (!route[1]) {
      const projectId = request.method === "GET" ? url.searchParams.get("projectId") ?? "" : ""
      const parsed = request.method === "POST" ? createCheckingSchema.safeParse(await body()) : null
      if (request.method !== "GET" && request.method !== "POST") return jsonError("Method not allowed", 405)
      if (parsed && !parsed.success) return jsonError("Select 1–2000 units, a title, a role, and an optional 4–12 digit PIN.")
      const pid = parsed?.success ? parsed.data.projectId : projectId
      const auth = await verifyTokenForProject(bearer(request), pid, env.SYNC_SECRET_KEY)
      if (!auth.ok) return dead()
      if (auth.claims.role < 500 || !await canShare(db, pid, auth.claims.userId)) return jsonError("Project lead access required.", 403)
      if (request.method === "GET") {
        const rows = await db.prepare(`SELECT token, title, role, expires_at AS "expiresAt", revoked_at AS "revokedAt"
          FROM checking_links WHERE project_id = ? ORDER BY created_at DESC LIMIT 100`).bind(pid).all()
        return Response.json({ links: rows.results ?? [] })
      }
      if (!parsed?.success) return jsonError("Invalid request")
      const data = parsed.data
      const unique = new Set(data.units.map(unit => JSON.stringify([unit.fileId, unit.cellId])))
      if (unique.size !== data.units.length) return jsonError("Duplicate units")
      const existing = await db.prepare(`SELECT c.file_id, c.cell_id FROM cells c
        JOIN files f ON f.id = c.file_id AND f.project_id = c.project_id
        JOIN jsonb_to_recordset(?::text::jsonb) AS u("fileId" text, "cellId" text)
          ON u."fileId" = c.file_id AND u."cellId" = c.cell_id
        WHERE c.project_id = ? AND f.deleted_at IS NULL
        GROUP BY c.file_id, c.cell_id`).bind(JSON.stringify(data.units), pid).all()
      if (existing.results?.length !== data.units.length) return jsonError("Some selected passages are no longer available.")
      const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "")
      const pinHash = data.pin ? await hashPasswordWerkzeugScrypt(data.pin) : null
      const expiresAt = Date.now() + 30 * 86400_000
      await db.prepare(`INSERT INTO checking_links
        (token, project_id, created_by, title, role, units, pin_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?::text::jsonb, ?, ?, ?)`)
        .bind(token, pid, auth.claims.userId, data.title, data.role, JSON.stringify(data.units), pinHash, expiresAt, Date.now()).run()
      return Response.json({ token, expiresAt }, { status: 201 })
    }
    const link = await db.prepare("SELECT * FROM checking_links WHERE token = ?").bind(route[1]).first<Link>()
    if (!link) return dead()
    if (route[2] === "revoke" && request.method === "POST") {
      const auth = await verifyTokenForProject(bearer(request), link.project_id, env.SYNC_SECRET_KEY)
      if (!auth.ok || auth.claims.role < 500 || !await canShare(db, link.project_id, auth.claims.userId)) return dead()
      await db.prepare("UPDATE checking_links SET revoked_at = ? WHERE token = ?").bind(Date.now(), link.token).run()
      return Response.json({ revoked: true })
    }
    if (link.revoked_at || Number(link.expires_at) <= Date.now() || !await canShare(db, link.project_id, Number(link.created_by))) return dead()
    if (route[2] === "join" && request.method === "POST") {
      if (!await takeBudget(db, link.token, "join", 50)) return jsonError("Too many attempts. Try again in 15 minutes.", 429)
      const parsed = joinCheckingSchema.safeParse(await body())
      if (!parsed.success) return jsonError("Enter your name and the PIN, if supplied.")
      if (link.locked_until && Number(link.locked_until) > Date.now()) return dead()
      if (link.pin_hash && !await verifyPasswordWerkzeugScrypt(parsed.data.pin ?? "", link.pin_hash)) {
        await db.prepare(`UPDATE checking_links SET failed_attempts = failed_attempts + 1,
          locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN ? ELSE locked_until END WHERE token = ?`)
          .bind(Date.now() + 15 * 60_000, link.token).run()
        return dead()
      }
      await db.prepare("UPDATE checking_links SET failed_attempts = 0, locked_until = NULL WHERE token = ?").bind(link.token).run()
      const now = Math.floor(Date.now() / 1000)
      const guestId = crypto.randomUUID()
      const session = await sign({ aud: "checking", link: link.token, guestId,
        name: parsed.data.name, iat: now, exp: Math.floor(Number(link.expires_at) / 1000) }, env.SYNC_SECRET_KEY, "HS256")
      return Response.json({ session, guestId, name: parsed.data.name, title: link.title,
        role: link.role, projectId: link.project_id })
    }
    let guest
    try { guest = await verify(bearer(request), env.SYNC_SECRET_KEY, "HS256") } catch { return dead() }
    if (guest.aud !== "checking" || guest.link !== link.token || typeof guest.guestId !== "string" || typeof guest.name !== "string") return dead()
    const units = unitsFor(link)
    const username = `${guest.name} (guest ${guest.guestId.slice(0, 8)})`
    if (route[2] === "content" && request.method === "GET") {
      const rows = await db.prepare(`SELECT u.ordinality, c.file_id AS "fileId", c.cell_id AS "cellId", f.name AS "fileName",
        c.canonical_ref AS label, c.value AS text, c.side
        FROM jsonb_array_elements(?::text::jsonb) WITH ORDINALITY AS u(unit, ordinality)
        JOIN cells c ON c.project_id = ? AND c.file_id = u.unit->>'fileId' AND c.cell_id = u.unit->>'cellId'
        JOIN files f ON f.project_id = c.project_id AND f.id = c.file_id AND f.deleted_at IS NULL
        WHERE c.target_lang = '' ORDER BY u.ordinality, c.side DESC`)
        .bind(JSON.stringify(units), link.project_id).all()
      const audio = await db.prepare(`SELECT a.file_id AS "fileId", a.cell_id AS "cellId", a.audio_id AS "audioId",
        a.url, a.trim_start_ms AS "trimStartMs", a.trim_end_ms AS "trimEndMs"
        FROM cell_audio a JOIN jsonb_to_recordset(?::text::jsonb) AS u("fileId" text, "cellId" text)
          ON a.file_id = u."fileId" AND a.cell_id = u."cellId"
        JOIN files f ON f.id = a.file_id AND f.project_id = a.project_id AND f.deleted_at IS NULL
        WHERE a.project_id = ? AND a.deleted = 0 AND a.selected = 1 AND a.slot = 'recording'`)
        .bind(JSON.stringify(units), link.project_id).all()
      return Response.json({ rows: rows.results ?? [], audio: audio.results ?? [] })
    }
    if (route[2] === "audio" && request.method === "GET") {
      const fileId = url.searchParams.get("fileId") ?? ""
      const cellId = url.searchParams.get("cellId") ?? ""
      const audioId = url.searchParams.get("audioId") ?? ""
      if (!inCheckingScope(units, fileId, cellId)) return dead()
      const row = await db.prepare(`SELECT a.url FROM cell_audio a JOIN files f ON f.id = a.file_id AND f.project_id = a.project_id
        WHERE a.project_id = ? AND a.file_id = ? AND a.cell_id = ? AND a.audio_id = ?
          AND a.deleted = 0 AND a.selected = 1 AND a.slot = 'recording' AND f.deleted_at IS NULL`)
        .bind(link.project_id, fileId, cellId, audioId).first<{ url: string }>()
      const objectId = row?.url.match(/^frontier-audio:\/\/([^/]+)$/)?.[1]
      if (!objectId) return jsonError("Recording unavailable.", 404)
      const headers = new Headers(request.headers)
      headers.set("Authorization", `Bearer ${await internalToken(env, link, fileId, username)}`)
      return await handleAudioRequest(new Request(`${url.origin}/audio/${encodeURIComponent(link.project_id)}/${encodeURIComponent(fileId)}/${encodeURIComponent(objectId)}`, { headers }), env)
    }
    if (route[2] === "events" && request.method === "POST") {
      if (link.role === "viewer") return jsonError("This link allows listening only.", 403)
      if (!await takeBudget(db, link.token, "feedback", 500)) return jsonError("Too much feedback at once. Try again in 15 minutes.", 429)
      const input = await body()
      const parsed = feedbackSchema.safeParse(input)
      if (!parsed.success) return jsonError("Only new passage feedback is supported.")
      const event = parsed.data
      const scope = event.payload.scope
      if (event.projectId !== link.project_id || event.fileId !== scope.fileId ||
          (event.cellId != null && event.cellId !== scope.cellId) || !inCheckingScope(units, scope.fileId, scope.cellId)) return dead()
      const liveCell = await db.prepare(`SELECT c.cell_id FROM cells c
        JOIN files f ON f.id = c.file_id AND f.project_id = c.project_id
        WHERE c.project_id = ? AND c.file_id = ? AND c.cell_id = ? AND f.deleted_at IS NULL LIMIT 1`)
        .bind(link.project_id, scope.fileId, scope.cellId).first()
      if (!liveCell) return jsonError("This passage is no longer available.", 410)
      // Preserve the client event ID for idempotent outbox retries. Stamp
      // identity and scope on the server; never trust the submitted author.
      event.author = username
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${await internalToken(env, link, scope.fileId, username)}` }
      return await handleEventsWriteRequest(new Request(`${url.origin}/events`, { method: "POST", headers,
        body: JSON.stringify({ events: [event] }) }), env, ctx)
    }
    return jsonError("Not found", 404)
  } catch (error) {
    if (error instanceof RangeError) return jsonError("Request too large", 413)
    if (error instanceof SyntaxError) return jsonError("Invalid JSON")
    console.error("[checking] request failed", error instanceof Error ? error.message : "unknown")
    return jsonError("Checking is temporarily unavailable. Please try again.", 503)
  }
}
