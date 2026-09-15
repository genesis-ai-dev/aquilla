// AQU-1205: browser consent for generic agents (RFC 8628). No token ever
// enters the consent browser. Single-statement redemption prevents replay.
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE, type AuthUser } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { mintApiToken, sha256Hex } from "../../../db/shared/api-credentials"
import { countRecentEvents, recordAuthEvent, ipIdentifier, userIdentifier } from "../utils/rate-limit"

const routes = new Hono<AuthHonoEnv>()
const CLIENT_ID = "aquilla-agent"
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
const TOKEN_SECONDS = 30 * 24 * 60 * 60
const codeSchema = z.string().regex(/^[A-Z2-9]{4}-?[A-Z2-9]{4}$/)
const startSchema = z.object({
  client_id: z.literal(CLIENT_ID),
  agent_name: z.string().trim().min(1).max(100),
  scope: z.enum(["ask", "act"]).default("ask"),
  project_id: z.string().min(1).max(200).optional(),
})
interface Grant {
  device_hash: string
  client_id: string
  agent_name: string
  mode: "ask" | "act"
  requested_project_id: string | null
  project_id: string | null
  user_id: string | null
  status: string
  expires_at: string
  last_poll_at: string | null
  poll_interval: number
}
const normalizeCode = (code: string) => code.replace(/-/g, "")
async function body(req: Request): Promise<unknown> {
  if (req.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(await req.text()))
  }
  return req.json().catch(() => null)
}
routes.use("*", bodyLimit({ maxSize: 4096 }))
routes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store")
  c.header("Pragma", "no-cache")
  await next()
})
routes.get("/", (c) => c.json({
  client_id: CLIENT_ID,
  device_authorization_endpoint: "device_authorization",
  token_endpoint: "token",
  grant_types_supported: [GRANT_TYPE],
  scopes_supported: ["ask", "act"],
  instructions: "POST client_id, agent_name, optional project_id and scope (default ask) as JSON or form data to device_authorization. Keep device_code private. Show verification_uri_complete and user_code to the human. They must confirm the code and approve in their browser; never approve for them. Poll token with client_id, grant_type and device_code at interval seconds. On slow_down add 5 seconds. Stop on access_denied or expired_token. Store access_token in your credential store, never chat or logs. Use it as a Bearer token with the existing Agent API or MCP transport.",
}))
routes.post("/device_authorization", async (c) => {
  const parsed = startSchema.safeParse(await body(c.req.raw))
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400)
  const ident = ipIdentifier(c.req.header("CF-Connecting-IP") ?? "local")
  if (await countRecentEvents(c.env.AQUILLA_PG, "agent_authorize", ident, { onlyFailures: false }) >= 20) {
    return c.json({ error: "slow_down" }, 429)
  }
  await recordAuthEvent(c.env.AQUILLA_PG, "agent_authorize", ident, true)
  const { token: deviceCode } = await mintApiToken()
  // 40 bits, uniform alphabet, no ambiguous 0/1/I/O; short-lived + throttled.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const rawCode = Array.from(bytes, (v) => alphabet[v % alphabet.length]).join("")
  const userCode = `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`
  const input = parsed.data
  await c.env.AQUILLA_PG.prepare(
    `INSERT INTO agent_authorizations
      (device_hash, user_code_hash, client_id, agent_name, mode,
       requested_project_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, now() + interval '10 minutes')`,
  ).bind(await sha256Hex(deviceCode), await sha256Hex(rawCode), CLIENT_ID,
    input.agent_name, input.scope, input.project_id ?? null).run()
  // Bounded retention, indexed expiry. No plaintext code or token persists.
  await c.env.AQUILLA_PG.prepare(
    "DELETE FROM agent_authorizations WHERE expires_at < now() - interval '1 day'",
  ).run()
  const verificationUri = `${(c.env.BASE_URL ?? "https://aquilla.app").replace(/\/$/, "")}/connect-agent`
  return c.json({ device_code: deviceCode, user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}#user_code=${userCode}`,
    expires_in: 600, interval: 5 })
})

// POST keeps the user code out of request URLs / access logs.
routes.post("/request", authMiddleware, async (c) => {
  const parsed = z.object({ user_code: codeSchema }).safeParse(await body(c.req.raw))
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400)
  const ident = userIdentifier(c.get("user").id)
  if (await countRecentEvents(c.env.AQUILLA_PG, "agent_code", ident, { onlyFailures: false }) >= 30) {
    return c.json({ error: "slow_down" }, 429)
  }
  await recordAuthEvent(c.env.AQUILLA_PG, "agent_code", ident, true)
  const row = await c.env.AQUILLA_PG.prepare(
    `SELECT agent_name, mode, requested_project_id, expires_at
     FROM agent_authorizations WHERE user_code_hash = ?
       AND status = 'pending' AND expires_at > now()`,
  ).bind(await sha256Hex(normalizeCode(parsed.data.user_code))).first<Grant>()
  if (!row) return c.json({ error: "expired_token" }, 400)
  return c.json({ agentName: row.agent_name, mode: row.mode,
    requestedProjectId: row.requested_project_id, expiresAt: row.expires_at,
    tokenExpiresIn: TOKEN_SECONDS })
})

routes.post("/decision", authMiddleware, async (c) => {
  const parsed = z.object({ user_code: codeSchema, approve: z.boolean(),
    project_id: z.string().min(1).max(200).optional(),
    code_confirmed: z.literal(true).optional(),
  }).safeParse(await body(c.req.raw))
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400)
  const input = parsed.data
  const ident = userIdentifier(c.get("user").id)
  if (await countRecentEvents(c.env.AQUILLA_PG, "agent_decision", ident, { onlyFailures: false }) >= 20) {
    return c.json({ error: "slow_down" }, 429)
  }
  await recordAuthEvent(c.env.AQUILLA_PG, "agent_decision", ident, true)
  const hash = await sha256Hex(normalizeCode(input.user_code))
  const grant = await c.env.AQUILLA_PG.prepare(
    `SELECT * FROM agent_authorizations WHERE user_code_hash = ?
     AND status = 'pending' AND expires_at > now()`,
  ).bind(hash).first<Grant>()
  if (!grant) return c.json({ error: "expired_token" }, 400)
  if (input.approve) {
    if (!input.project_id || !input.code_confirmed) return c.json({ error: "invalid_request" }, 400)
    if (grant.requested_project_id && grant.requested_project_id !== input.project_id) {
      return c.json({ error: "scope_denied" }, 403)
    }
    const role = await resolveProjectRole(c.env, c.get("user"), input.project_id)
    if (!role || role.level < (grant.mode === "act" ? ROLE.MAINTAINER : ROLE.CONTRIBUTOR)) {
      return c.json({ error: "scope_denied" }, 403)
    }
  }
  const changed = await c.env.AQUILLA_PG.prepare(
    `UPDATE agent_authorizations SET status = ?, user_id = ?, project_id = ?
     WHERE user_code_hash = ? AND status = 'pending' AND expires_at > now()
     RETURNING status`,
  ).bind(input.approve ? "approved" : "denied", String(c.get("user").id),
    input.approve ? input.project_id : null, hash).first()
  if (!changed) return c.json({ error: "expired_token" }, 400)
  return c.json({ status: input.approve ? "approved" : "denied" })
})

routes.post("/token", async (c) => {
  const parsed = z.object({ client_id: z.literal(CLIENT_ID),
    grant_type: z.literal(GRANT_TYPE), device_code: z.string().min(40).max(100),
  }).safeParse(await body(c.req.raw))
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400)
  const hash = await sha256Hex(parsed.data.device_code)
  const grant = await c.env.AQUILLA_PG.prepare(
    "SELECT * FROM agent_authorizations WHERE device_hash = ? AND client_id = ?",
  ).bind(hash, CLIENT_ID).first<Grant>()
  if (!grant || grant.status === "consumed" || new Date(grant.expires_at).getTime() <= Date.now()) {
    return c.json({ error: "expired_token" }, 400)
  }
  if (grant.status === "denied") return c.json({ error: "access_denied" }, 400)
  // Atomic poll claim: concurrent requests cannot both pass the interval gate.
  const poll = await c.env.AQUILLA_PG.prepare(
    `UPDATE agent_authorizations SET last_poll_at = now()
     WHERE device_hash = ? AND (last_poll_at IS NULL OR
       last_poll_at <= now() - poll_interval * interval '1 second')
     RETURNING device_hash`,
  ).bind(hash).first()
  if (!poll) {
    await c.env.AQUILLA_PG.prepare(
      "UPDATE agent_authorizations SET poll_interval = LEAST(poll_interval + 5, 600) WHERE device_hash = ?",
    ).bind(hash).run()
    return c.json({ error: "slow_down" }, 400)
  }
  if (grant.status === "pending") return c.json({ error: "authorization_pending" }, 400)
  const user = await c.env.AQUILLA_PG.prepare("SELECT * FROM users WHERE id::text = ?")
    .bind(grant.user_id).first<AuthUser>()
  const role = user && grant.project_id
    ? await resolveProjectRole(c.env, user, grant.project_id) : null
  if (!role || role.level < (grant.mode === "act" ? ROLE.MAINTAINER : ROLE.CONTRIBUTOR)) {
    return c.json({ error: "access_denied" }, 400)
  }
  const minted = await mintApiToken()
  const id = crypto.randomUUID()
  // Consume and mint in ONE Postgres statement. Failure rolls back both.
  const credential = await c.env.AQUILLA_PG.prepare(
    `WITH claimed AS (
       UPDATE agent_authorizations SET status = 'consumed'
       WHERE device_hash = ? AND status = 'approved' AND expires_at > now()
       RETURNING user_id, agent_name, mode, project_id
     ) INSERT INTO api_credentials
       (id, user_id, name, token_prefix, token_hash, mode, project_id, expires_at)
       SELECT ?, user_id, agent_name, ?, ?, mode, project_id,
         now() + interval '30 days' FROM claimed RETURNING id`,
  ).bind(hash, id, minted.tokenPrefix, minted.tokenHash).first()
  if (!credential) return c.json({ error: "expired_token" }, 400)
  return c.json({ access_token: minted.token, token_type: "Bearer",
    expires_in: TOKEN_SECONDS, scope: grant.mode, project_id: grant.project_id,
    credential_id: id })
})
export default routes
