// Google is contacted only after the SPA's explicit button action. No GIS SDK,
// cookies, automatic prompts, profile images, or provider tokens are persisted.
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { createRemoteJWKSet, jwtVerify } from "jose"
import type { AuthHonoEnv } from "../middleware/auth"
import { JWTService } from "../auth/jwt"
import { sha256Hex } from "../../../db/shared/api-credentials"
import { countRecentEvents, ipIdentifier, recordAuthEvent } from "../utils/rate-limit"
import { verifyPassword } from "../utils/password"
import { legacyD1Config } from "./auth"
import { hasLegacyIdentityCollision } from "../services/frontier-d1"
import { sendWelcomeEmail } from "../services/email"
import { parseAdminEmails } from "../middleware/platform-admin"

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), { timeoutDuration: 10_000 })
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("")
export async function pkceChallenge(verifier: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
interface Flow { state_hash: string; browser_challenge: string; google_verifier: string; nonce: string; app_origin: string; subject: string; email: string; authoritative_email: boolean }
interface Account { id: number; username: string; password_hash: string | null }
const proof = z.object({ code: z.string().regex(/^[a-f0-9]{64}$/), verifier: z.string().regex(/^[a-f0-9]{64}$/) })
const routes = new Hono<AuthHonoEnv>()
routes.use("*", bodyLimit({ maxSize: 8192 }), async (c, next) => {
  c.header("Cache-Control", "no-store")
  c.header("Referrer-Policy", "no-referrer")
  if (!c.req.path.endsWith("/config") && !configured(c.env)) return c.json({ error: "unavailable" }, 503)
  await next()
})
function configured(env: AuthHonoEnv["Bindings"]): boolean {
  return !!(env.SECRET_KEY && env.ALGORITHM && env.GOOGLE_LOGIN_CLIENT_ID && env.GOOGLE_LOGIN_CLIENT_SECRET && env.GOOGLE_LOGIN_REDIRECT_URI && env.GOOGLE_LOGIN_APP_ORIGINS)
}
routes.get("/config", c => c.json({ enabled: configured(c.env) }))
// POST avoids prefetch/link scanners starting sign-in. Only exact configured SPA
// origins may receive a handoff; never accept an arbitrary return URL.
routes.post("/start", zValidator("json", z.object({ challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })), async c => {
  if (!configured(c.env)) return c.json({ error: "unavailable" }, 503)
  const origin = c.req.header("Origin") ?? ""
  const allowed = c.env.GOOGLE_LOGIN_APP_ORIGINS!.split(",").map(s => s.trim())
  if (!allowed.includes(origin)) return c.json({ error: "invalid_origin" }, 400)
  const ip = ipIdentifier(c.req.header("CF-Connecting-IP") || "unknown")
  if (await countRecentEvents(c.env.AQUILLA_PG, "social_login", ip, { onlyFailures: false }) >= 30) return c.json({ error: "rate_limited" }, 429)
  await recordAuthEvent(c.env.AQUILLA_PG, "social_login", ip, true)
  const state = random(), verifier = random(), nonce = random()
  await c.env.AQUILLA_PG.prepare("DELETE FROM social_login_flows WHERE expires_at < now()").run()
  await c.env.AQUILLA_PG.prepare(`INSERT INTO social_login_flows
    (state_hash, browser_challenge, google_verifier, nonce, app_origin, status) VALUES (?, ?, ?, ?, ?, 'started')`)
    .bind(await sha256Hex(state), c.req.valid("json").challenge, verifier, nonce, origin).run()
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  url.search = new URLSearchParams({ client_id: c.env.GOOGLE_LOGIN_CLIENT_ID!, redirect_uri: c.env.GOOGLE_LOGIN_REDIRECT_URI!, response_type: "code", scope: "openid email", state, nonce, code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", prompt: "select_account" }).toString()
  return c.json({ authorization_url: url.href })
})
routes.get("/callback", async c => {
  const state = c.req.query("state") ?? ""
  if (!configured(c.env) || !/^[a-f0-9]{64}$/.test(state)) return c.json({ error: "invalid_request" }, 400)
  // Consume state atomically before any provider contact. Callback replay cannot
  // exchange a second Google code, even on concurrent Worker instances.
  const flow = await c.env.AQUILLA_PG.prepare(`UPDATE social_login_flows SET status = 'callback'
    WHERE state_hash = ? AND status = 'started' AND expires_at > now() RETURNING *`).bind(await sha256Hex(state)).first<Flow>()
  if (!flow) return c.json({ error: "expired_request" }, 400)
  const back = new URL("/auth/google/return", flow.app_origin)
  const fail = (error: string) => { back.hash = new URLSearchParams({ error }).toString(); return c.redirect(back.href, 303) }
  if (c.req.query("error")) return fail("cancelled")
  const code = c.req.query("code")
  if (!code || code.length > 4096) return fail("invalid_request")
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.env.GOOGLE_LOGIN_CLIENT_ID!, client_secret: c.env.GOOGLE_LOGIN_CLIENT_SECRET!, code, code_verifier: flow.google_verifier, redirect_uri: c.env.GOOGLE_LOGIN_REDIRECT_URI!, grant_type: "authorization_code" }),
    })
    if (!response.ok) return fail("provider_failed")
    const data = await response.json() as { id_token?: unknown }
    if (typeof data.id_token !== "string") return fail("provider_failed")
    const { payload } = await jwtVerify(data.id_token, googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"], audience: c.env.GOOGLE_LOGIN_CLIENT_ID!, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "nonce", "email", "email_verified"], maxTokenAge: "10m",
    })
    if (payload.nonce !== flow.nonce || payload.email_verified !== true || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255 || typeof payload.email !== "string" || !z.string().email().max(320).safeParse(payload.email).success || (payload.azp !== undefined && payload.azp !== c.env.GOOGLE_LOGIN_CLIENT_ID)) return fail("provider_failed")
    const handoff = random()
    await c.env.AQUILLA_PG.prepare(`UPDATE social_login_flows SET status='ready', code_hash=?, google_verifier=NULL, subject=?, email=?, authoritative_email=?, expires_at=now()+interval '5 minutes' WHERE state_hash=? AND status='callback'`)
      .bind(await sha256Hex(handoff), payload.sub, payload.email, payload.email.toLowerCase().endsWith("@gmail.com") || (typeof payload.hd === "string" && payload.hd.length > 0), flow.state_hash).run()
    // Fragment isn't sent in HTTP requests/referrers. The SPA removes it before
    // rendering and requires its tab-local verifier to redeem it.
    back.hash = new URLSearchParams({ code: handoff }).toString()
    return c.redirect(back.href, 303)
  } catch { return fail("provider_failed") }
})
async function accountFor(db: AquillaDb, flow: Flow): Promise<{ account: Account | null; linked: boolean }> {
  const linked = await db.prepare("SELECT u.id, u.username, u.password_hash FROM provider_identities p JOIN users u ON u.id=p.user_id WHERE p.provider='google' AND p.subject=?").bind(flow.subject).first<Account>()
  if (linked) return { account: linked, linked: true }
  const account = await db.prepare("SELECT id, username, password_hash FROM users WHERE LOWER(email)=LOWER(?)").bind(flow.email).first<Account>()
  return { account, linked: false }
}
async function session(env: AuthHonoEnv["Bindings"], username: string, created: boolean) {
  const { token } = await new JWTService(env).createAccessTokenWithPayload(username)
  try { await env.AQUILLA_PG.prepare("INSERT INTO activity_logs (user_id, activity_type, description) SELECT id, ?, ? FROM users WHERE username=?")
    .bind(created ? "register" : "login", created ? "Account created with Google" : "Signed in with Google", username).run()
  } catch { console.warn("[social-login] activity log insert failed (non-fatal)") }
  return { access_token: token, token_type: "bearer", username, created }
}
routes.post("/exchange", zValidator("json", proof), async c => {
  const { code, verifier } = c.req.valid("json")
  const nextCode = random()
  const flow = await c.env.AQUILLA_PG.prepare(`UPDATE social_login_flows SET status='pending', code_hash=?
    WHERE code_hash=? AND browser_challenge=? AND status='ready' AND expires_at>now() RETURNING *`)
    .bind(await sha256Hex(nextCode), await sha256Hex(code), await pkceChallenge(verifier)).first<Flow>()
  if (!flow) return c.json({ error: "expired_request" }, 400)
  const { account, linked } = await accountFor(c.env.AQUILLA_PG, flow)
  if (linked && account) {
    await c.env.AQUILLA_PG.prepare("UPDATE social_login_flows SET status='consumed', code_hash=NULL WHERE state_hash=?").bind(flow.state_hash).run()
    return c.json(await session(c.env, account.username, false))
  }
  return c.json({ continuation: nextCode, step: account ? "link" : "signup", email: flow.email, ...(account ? { username: account.username } : {}) })
})

export async function pruneSocialLoginFlows(db: AquillaDb): Promise<void> {
  try { await db.prepare("DELETE FROM social_login_flows WHERE expires_at < now()").run() }
  catch { console.warn("[social-login] expired flow cleanup failed") }
}

routes.post("/finish", zValidator("json", proof.extend({ username: z.string().trim().min(3).max(50).optional(), password: z.string().max(1024).optional() })), async c => {
  const { code, verifier, username, password } = c.req.valid("json")
  const hash = await sha256Hex(code), challenge = await pkceChallenge(verifier)
  const flow = await c.env.AQUILLA_PG.prepare("SELECT * FROM social_login_flows WHERE code_hash=? AND browser_challenge=? AND status='pending' AND expires_at>now()")
    .bind(hash, challenge).first<Flow>()
  if (!flow) return c.json({ error: "expired_request" }, 400)
  const ip = ipIdentifier(c.req.header("CF-Connecting-IP") || "unknown")
  const ownerKey = `social:${await sha256Hex(flow.email.toLowerCase())}`
  if (await countRecentEvents(c.env.AQUILLA_PG, "social_link", ip, { onlyFailures: false }) >= 20 || await countRecentEvents(c.env.AQUILLA_PG, "social_link", ownerKey, { onlyFailures: false }) >= 8) return c.json({ error: "rate_limited" }, 429)
  await recordAuthEvent(c.env.AQUILLA_PG, "social_link", ip, true)
  await recordAuthEvent(c.env.AQUILLA_PG, "social_link", ownerKey, true)
  const { account, linked } = await accountFor(c.env.AQUILLA_PG, flow)
  if (linked) return c.json({ error: "restart" }, 409)
  if (account) {
    // Require proof of the existing Aquilla account, not merely matching email.
    if (!password || !(await verifyPassword(password, account.password_hash)).isValid) return c.json({ error: "invalid_password" }, 401)
    // The single SQL statement atomically claims the continuation and links.
    // Compare the password hash too: a concurrent reset invalidates this proof.
    let result: { username: string } | null
    try { result = await c.env.AQUILLA_PG.prepare(`WITH claimed AS (
      UPDATE social_login_flows SET status='consumed', code_hash=NULL
      WHERE code_hash=? AND browser_challenge=? AND status='pending' AND expires_at>now()
      AND EXISTS (SELECT 1 FROM users WHERE id=? AND password_hash=? AND LOWER(email)=LOWER(?))
      RETURNING subject
    ), linked AS (
      INSERT INTO provider_identities (provider, subject, user_id) SELECT 'google', subject, ? FROM claimed RETURNING user_id
    ) SELECT u.username FROM users u JOIN linked l ON u.id=l.user_id`)
      .bind(hash, challenge, account.id, account.password_hash, flow.email, account.id).first<{ username: string }>()
    } catch { return c.json({ error: "restart" }, 409) }
    if (!result) return c.json({ error: "restart" }, 409)
    return c.json(await session(c.env, result.username, false))
  }
  if (!username) return c.json({ error: "username_required" }, 400)
  if (c.env.ENVIRONMENT !== "production") {
    const reserved = parseAdminEmails(c.env)
    if (reserved.has(flow.email.toLowerCase()) || reserved.has(username.toLowerCase())) return c.json({ error: "identity_taken" }, 409)
  }
  const existing = await c.env.AQUILLA_PG.prepare("SELECT id FROM users WHERE LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?) OR LOWER(email)=LOWER(?) OR LOWER(username)=LOWER(?)")
    .bind(username, flow.email, username, flow.email).first()
  if (existing) return c.json({ error: "identity_taken" }, 409)
  try {
    const d1 = legacyD1Config(c.env)
    if (d1 && await hasLegacyIdentityCollision(d1, username, flow.email)) return c.json({ error: "identity_taken" }, 409)
  } catch { return c.json({ error: "unavailable" }, 503) }
  try {
    const result = await c.env.AQUILLA_PG.prepare(`WITH claimed AS (
      UPDATE social_login_flows SET status='consumed', code_hash=NULL
      WHERE code_hash=? AND browser_challenge=? AND status='pending' AND expires_at>now() RETURNING subject, email, authoritative_email
    ), created AS (
      INSERT INTO users (username, email, password_hash, email_verified_at)
      SELECT ?, email, NULL, CASE WHEN authoritative_email THEN now() ELSE NULL END FROM claimed RETURNING id, username
    ), linked AS (
      INSERT INTO provider_identities (provider, subject, user_id)
      SELECT 'google', c.subject, u.id FROM claimed c CROSS JOIN created u RETURNING user_id
    ) SELECT u.username FROM created u JOIN linked l ON u.id=l.user_id`)
      .bind(hash, challenge, username).first<{ username: string }>()
    if (!result) return c.json({ error: "expired_request" }, 400)
    // Preserve the ordinary signup verification path for addresses for which
    // Google is not authoritative. Email delivery must not strand a new account.
    const welcome = async () => {
      let verifyUrl: string | undefined
      if (!flow.authoritative_email) {
        const verifyToken = random()
        await c.env.AQUILLA_PG.prepare(`INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
          SELECT id, ?, now()+interval '7 days' FROM users WHERE username=?`)
          .bind(await sha256Hex(verifyToken), result.username).run()
        verifyUrl = `${c.env.BASE_URL || "https://aquilla.app"}/verify-email?token=${verifyToken}`
      }
      await sendWelcomeEmail(c.env, flow.email, result.username, verifyUrl)
    }
    const delivery = welcome().catch(() => { console.warn("[social-login] welcome delivery failed (non-fatal)") })
    try { c.executionCtx.waitUntil(delivery) } catch { await delivery }
    return c.json(await session(c.env, result.username, true))
  } catch {
    // Uniqueness races roll back the entire CTE, never leaving an orphan account.
    return c.json({ error: "signup_failed" }, 409)
  }
})

export default routes
