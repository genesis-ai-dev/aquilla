import { legacyD1Config } from "./auth"
import { hasLegacyIdentityCollision } from "../services/frontier-d1"
import { Hono, type Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { bodyLimit } from "hono/body-limit"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { verifyPassword } from "../utils/password"
import { sha256Hex } from "../../../db/shared/api-credentials"
import { pkceChallenge } from "./oauth-google"
import {
  parseAdminEmails,
  hasActiveElevation,
} from "../middleware/platform-admin"
import { checkDevAccess } from "../services/dev-access"
import { countRecentEvents, recordAuthEvent } from "../utils/rate-limit"
import { evictUserSessions } from "../lib/session-cache"

function sixDigitCode(): string {
  const values = new Uint32Array(1)
  do { crypto.getRandomValues(values) } while (values[0] >= 4294000000)
  return String(values[0] % 1_000_000).padStart(6, "0")
}

// A keyed digest prevents offline enumeration of the small code space from a DB copy.
async function codeHash(secret: string, userId: number, code: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`email-change:${userId}:${code}`))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")
}

const routes = new Hono<AuthHonoEnv>()
routes.use(
  "*",
  bodyLimit({ maxSize: 8192 }),
  authMiddleware,
  async (c, next) => {
    c.header("Cache-Control", "no-store")
    await next()
  },
)
async function account(c: Context<AuthHonoEnv>) {
  return c.env.AQUILLA_PG.prepare(
    `SELECT id,email,password_hash,session_version,
    EXISTS(SELECT 1 FROM platform_admins WHERE email=LOWER(users.email)) AS admin
    FROM users WHERE id=?`,
  )
    .bind(c.get("user").id)
    .first<{
      id: number
      email: string
      password_hash: string | null
      session_version: number
      admin: boolean
    }>()
}
async function guard(
  c: Context<AuthHonoEnv>,
  old: NonNullable<Awaited<ReturnType<typeof account>>>,
  email: string,
) {
  const legacy = legacyD1Config(c.env)
  if (legacy && await hasLegacyIdentityCollision(legacy,email,email)) return "email_unavailable"
  const bootstrap = parseAdminEmails(c.env)
  if (bootstrap.has(old.email.toLowerCase()) || bootstrap.has(email))
    return "administrator_coordination_required"
  if (old.admin && !(await hasActiveElevation(c)))
    return "admin_verification_required"
  if (
    await c.env.AQUILLA_PG.prepare(
      "SELECT 1 FROM users WHERE (LOWER(email)=? OR LOWER(username)=?) AND id<>?",
    )
      .bind(email, email, old.id)
      .first()
  )
    return "email_unavailable"
  if (
    await c.env.AQUILLA_PG.prepare(
      "SELECT 1 FROM platform_admins WHERE email=?",
    )
      .bind(email)
      .first()
  )
    return "email_unavailable"
  // Database admins retain their grant in the same statement as the email.
  // KV is not transactional with Postgres: never silently migrate or grant access.
  if (!old.admin && !(await checkDevAccess(c.env, email)).allowed)
    return "destination_dev_access_required"
  return null
}
const requestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(1024).optional(),
  google: z
    .object({
      code: z.string().regex(/^[a-f0-9]{64}$/),
      verifier: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
})
routes.post("/request", zValidator("json", requestSchema), async (c) => {
  const old = await account(c)
  if (!old) return c.json({ error: "session_expired" }, 401)
  const key = `email-change:${old.id}`
  if (
    (await countRecentEvents(c.env.AQUILLA_PG, "social_link", key, {
      onlyFailures: false,
    })) >= 5
  )
    return c.json({ error: "rate_limited" }, 429)
  await recordAuthEvent(c.env.AQUILLA_PG, "social_link", key, true)
  const { email, password, google } = c.req.valid("json")
  if (email === old.email.toLowerCase())
    return c.json({ error: "email_unchanged" }, 400)
  const refusal = await guard(c, old, email)
  if (refusal) return c.json({ error: refusal }, 403)
  let proved = password
    ? (await verifyPassword(password, old.password_hash)).isValid
    : false
  if (!proved && google) {
    const row = await c.env.AQUILLA_PG.prepare(
      `UPDATE social_login_flows f SET status='consumed',code_hash=NULL
      WHERE code_hash=? AND browser_challenge=? AND status='ready' AND expires_at>now()
      AND EXISTS(SELECT 1 FROM provider_identities p WHERE p.provider='google' AND p.subject=f.subject AND p.user_id=?)
      RETURNING subject`,
    )
      .bind(
        await sha256Hex(google.code),
        await pkceChallenge(google.verifier),
        old.id,
      )
      .first()
    proved = !!row
  }
  if (!proved) return c.json({ error: password && !google ? "incorrect_password" : "ownership_proof_required" }, 401)
  if (!c.env.EMAIL) return c.json({ error: "email_delivery_unavailable" }, 503)
  const token = sixDigitCode()
  const hash = await codeHash(c.env.SECRET_KEY, old.id, token)
  const saved = await c.env.AQUILLA_PG.prepare(
    `INSERT INTO email_change_requests(user_id,old_email,new_email,session_version,token_hash,expires_at)
    SELECT id,email,?,session_version,?,now()+interval '15 minutes' FROM users
    WHERE id=? AND email=? AND session_version=? AND password_hash IS NOT DISTINCT FROM ?
    ON CONFLICT(user_id) DO UPDATE SET old_email=excluded.old_email,new_email=excluded.new_email,
    session_version=excluded.session_version,token_hash=excluded.token_hash,expires_at=excluded.expires_at,confirmation_attempts=0 RETURNING user_id`,
  )
    .bind(
      email,
      hash,
      old.id,
      old.email,
      old.session_version,
      old.password_hash,
    )
    .first()
  if (!saved) return c.json({ error: "restart" }, 409)
  try {
    await c.env.EMAIL.send({
      from: c.env.EMAIL_FROM || "noreply@support.aquilla.app",
      to: [email],
      subject: "Confirm your Aquilla email change",
      text: `Enter this verification code in Aquilla to change your account email: ${token}\nIt expires in 15 minutes. If you did not request this, ignore this email.`,
    })
  } catch {
    await c.env.AQUILLA_PG.prepare(
      "DELETE FROM email_change_requests WHERE user_id=? AND token_hash=?",
    )
      .bind(old.id, hash)
      .run()
    return c.json({ error: "email_delivery_unavailable" }, 503)
  }
  return c.json({ sent: true })
})
routes.post(
  "/confirm",
  zValidator(
    "json",
    z.object({
      token: z
        .string()
        .trim()
        .regex(/^[0-9]{6}$/),
    }),
  ),
  async (c) => {
    const old = await account(c)
    if (!old) return c.json({ error: "session_expired" }, 401)
    const hash = await codeHash(c.env.SECRET_KEY, old.id, c.req.valid("json").token)
    const pending = await c.env.AQUILLA_PG.prepare(
      `UPDATE email_change_requests SET confirmation_attempts=confirmation_attempts+1
       WHERE user_id=? AND expires_at>now() AND confirmation_attempts<5
       RETURNING new_email,token_hash`,
    )
      .bind(old.id)
      .first<{ new_email: string; token_hash: string }>()
    if (!pending || pending.token_hash !== hash) return c.json({ error: "invalid_or_expired_code" }, 400)
    const refusal = await guard(c, old, pending.new_email)
    if (refusal) return c.json({ error: refusal }, 403)
    try {
      const changed = await c.env.AQUILLA_PG.prepare(
        `WITH changed AS (
      UPDATE users u SET email=r.new_email,email_verified_at=now(),email_changed_at=now(),updated_at=now(),
        password_changed_at=now(),session_version=u.session_version+1
      FROM email_change_requests r WHERE u.id=? AND r.user_id=u.id AND r.token_hash=? AND r.expires_at>now()
        AND u.email=r.old_email AND u.session_version=r.session_version
        AND EXISTS(SELECT 1 FROM platform_admins WHERE email=LOWER(u.email))=?
        AND NOT EXISTS(SELECT 1 FROM platform_admins WHERE email=r.new_email)
        AND NOT EXISTS(SELECT 1 FROM users other WHERE other.id<>u.id AND LOWER(other.username)=r.new_email)
      RETURNING u.id,u.email
    ), grants AS (UPDATE platform_admins SET email=(SELECT email FROM changed)
      WHERE email=LOWER(?) AND EXISTS(SELECT 1 FROM changed) RETURNING email),
    requests AS (DELETE FROM email_change_requests WHERE user_id IN(SELECT id FROM changed)),
    resets AS (DELETE FROM password_reset_tokens WHERE user_id IN(SELECT id FROM changed)),
    verification AS (DELETE FROM email_verification_tokens WHERE user_id IN(SELECT id FROM changed)),
    elevation AS (DELETE FROM admin_elevations WHERE user_id IN(SELECT id FROM changed)),
    credentials AS (UPDATE api_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id IN(SELECT id::text FROM changed)),
    audit AS (INSERT INTO activity_logs(user_id,activity_type,description) SELECT id,'email_changed','Verified account email change' FROM changed)
    SELECT id FROM changed`,
      )
        .bind(old.id, hash, old.admin, old.email)
        .first()
      if (!changed) return c.json({ error: "restart" }, 409)
      evictUserSessions(old.id)
      return c.json({ changed: true, login_required: true })
    } catch {
      return c.json({ error: "email_unavailable" }, 409)
    }
  },
)
export default routes
