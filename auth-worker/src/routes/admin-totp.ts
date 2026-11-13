import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { AuthHonoEnv } from "../middleware/auth"
import {
  base32,
  decryptSeed,
  deployment,
  encryptSeed,
  factor,
  keyMaterial,
  matchingStep,
} from "../lib/admin-totp"
import { sha256Hex } from "../../../db/shared/api-credentials"

const routes = new Hono<AuthHonoEnv>()
const proof = z.object({ code: z.string().min(6).max(64) })
routes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store")
  await next()
})
routes.get("/", async (c) => {
  const row = await factor(c)
  return c.json({
    enabled: row?.enabled === true,
    configured: Boolean(
      c.env.ADMIN_TOTP_KEY && c.env.ADMIN_TOTP_KEY.length >= 32,
    ),
  })
})
// Count every attempt, not only failed attempts, so overlapping guesses count.
routes.use("*", async (c, next) => {
  if (c.req.method === "GET") return next()
  const allowed = await c.env.AQUILLA_PG.prepare(
    `INSERT INTO admin_totp_attempts(user_id,deployment,started_at,attempts)
    VALUES(?,?,now(),1) ON CONFLICT(user_id,deployment) DO UPDATE SET
    attempts=CASE WHEN admin_totp_attempts.started_at<now()-interval '5 minutes' THEN 1 ELSE admin_totp_attempts.attempts+1 END,
    started_at=CASE WHEN admin_totp_attempts.started_at<now()-interval '5 minutes' THEN now() ELSE admin_totp_attempts.started_at END
    WHERE admin_totp_attempts.attempts<10 OR admin_totp_attempts.started_at<now()-interval '5 minutes' RETURNING attempts`,
  )
    .bind(c.get("user").id, deployment(c))
    .first()
  if (!allowed) return c.json({ error: "rate_limited" }, 429)
  try {
    keyMaterial(c)
  } catch {
    return c.json({ error: "authenticator_unavailable" }, 503)
  }
  await next()
})
routes.post("/setup", async (c) => {
  const user = c.get("user"),
    scope = deployment(c)
  const fresh = await c.env.AQUILLA_PG.prepare(
    `SELECT 1 FROM admin_elevations WHERE user_id=? AND session_key=? AND elevated_until>now() AND updated_at>now()-interval '5 minutes'`,
  )
    .bind(user.id, c.get("sessionKey"))
    .first()
  if (!fresh) return c.json({ error: "fresh_verification_required" }, 403)
  const secret = base32(crypto.getRandomValues(new Uint8Array(20)))
  const generation = crypto.randomUUID()
  const row = await c.env.AQUILLA_PG.prepare(
    `INSERT INTO admin_totp(user_id,deployment,generation,secret_enc,setup_session,expires_at)
    VALUES(?,?,?,?,?,now()+interval '10 minutes') ON CONFLICT(user_id,deployment) DO UPDATE SET
    generation=EXCLUDED.generation,secret_enc=EXCLUDED.secret_enc,setup_session=EXCLUDED.setup_session,
    expires_at=EXCLUDED.expires_at,confirmed_step=NULL,recovery_hashes='[]' WHERE NOT admin_totp.enabled RETURNING generation`,
  )
    .bind(
      user.id,
      scope,
      generation,
      await encryptSeed(c, secret),
      c.get("sessionKey"),
    )
    .first()
  if (!row) return c.json({ error: "already_enrolled" }, 409)
  const issuer = `Aquilla (${scope})`
  return c.json({
    generation,
    secret,
    uri: `otpauth://totp/${encodeURIComponent(`${issuer}:${user.email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`,
  })
})
routes.post(
  "/confirm",
  zValidator("json", proof.extend({ generation: z.string().uuid() })),
  async (c) => {
    const row = await factor(c)
    if (
      !row ||
      row.enabled ||
      row.generation !== c.req.valid("json").generation
    )
      return c.json({ error: "setup_expired" }, 400)
    let step: number | null
    try {
      step = await matchingStep(
        await decryptSeed(c, row.secret_enc),
        c.req.valid("json").code,
      )
    } catch {
      return c.json({ error: "authenticator_unavailable" }, 503)
    }
    if (step === null) return c.json({ error: "invalid_code" }, 400)
    const codes = Array.from({ length: 8 }, () =>
      base32(crypto.getRandomValues(new Uint8Array(16))),
    )
    const hashes = await Promise.all(codes.map(sha256Hex))
    const saved = await c.env.AQUILLA_PG.prepare(
      `UPDATE admin_totp SET confirmed_step=?,recovery_hashes=?::text::jsonb
    WHERE user_id=? AND deployment=? AND generation=? AND NOT enabled AND setup_session=? AND expires_at>now() AND confirmed_step IS NULL RETURNING generation`,
    )
      .bind(
        step,
        JSON.stringify(hashes),
        c.get("user").id,
        deployment(c),
        row.generation,
        c.get("sessionKey"),
      )
      .first()
    if (!saved) return c.json({ error: "setup_expired" }, 400)
    return c.json({ recoveryCodes: codes })
  },
)
routes.post(
  "/complete",
  zValidator(
    "json",
    z.object({
      savedRecoveryCodes: z.literal(true),
      generation: z.string().uuid(),
    }),
  ),
  async (c) => {
    const row = await c.env.AQUILLA_PG.prepare(
      `WITH activated AS (
    UPDATE admin_totp SET enabled=true,last_step=confirmed_step WHERE user_id=? AND deployment=? AND NOT enabled
      AND confirmed_step IS NOT NULL AND setup_session=? AND generation=? AND expires_at>now() RETURNING user_id,generation
    ), cleared AS (DELETE FROM admin_elevation_codes WHERE user_id IN(SELECT user_id FROM activated)),
    revoked AS (DELETE FROM admin_elevations WHERE user_id IN(SELECT user_id FROM activated)),
    audited AS (INSERT INTO admin_audit_log(user_id,action,detail) SELECT user_id,'totp.enrolled','{}' FROM activated)
    SELECT generation FROM activated`,
    )
      .bind(
        c.get("user").id,
        deployment(c),
        c.get("sessionKey"),
        c.req.valid("json").generation,
      )
      .first()
    if (!row) return c.json({ error: "setup_expired" }, 400)
    return c.json({ enabled: true })
  },
)
// Verification consumes the time step or recovery hash with a conditional UPDATE.
// Concurrent requests cannot redeem the same proof twice.
routes.post(
  "/verify",
  zValidator(
    "json",
    proof.extend({
      recovery: z.boolean().optional(),
      disable: z.boolean().optional(),
    }),
  ),
  async (c) => {
    const input = c.req.valid("json"),
      row = await factor(c),
      user = c.get("user")
    if (!row?.enabled) return c.json({ error: "not_enrolled" }, 400)
    let step: number | null = null
    if (!input.recovery) {
      try {
        step = await matchingStep(
          await decryptSeed(c, row.secret_enc),
          input.code,
        )
      } catch {
        return c.json({ error: "authenticator_unavailable" }, 503)
      }
      if (step === null) return c.json({ error: "invalid_code" }, 400)
    }
    const hash = await sha256Hex(
      input.code.trim().toUpperCase().replace(/[ -]/g, ""),
    )
    const condition = input.recovery
      ? "recovery_hashes @> ?::text::jsonb"
      : "last_step < ?"
    const assignment = input.recovery
      ? "recovery_hashes=recovery_hashes - ?"
      : "last_step=?"
    const value = input.recovery ? hash : step
    const guard = input.recovery ? JSON.stringify([hash]) : step
    const hours = Number(c.env.ELEVATION_SESSION_HOURS ?? 6)
    const until = new Date(Date.now() + hours * 3600000).toISOString()
    const operation = `granted AS (INSERT INTO admin_elevations(user_id,session_key,elevated_until,updated_at,factor_generation)
       SELECT user_id,?,?,now(),generation FROM used ON CONFLICT(user_id,session_key) DO UPDATE SET
       elevated_until=EXCLUDED.elevated_until,updated_at=now(),factor_generation=EXCLUDED.factor_generation),`
    const disableSet = input.disable
      ? ",enabled=false,secret_enc='',recovery_hashes='[]',generation=?"
      : ""
    const disableOperation = `revoked AS (DELETE FROM admin_elevations WHERE user_id IN(SELECT user_id FROM used)),
       cleared AS (DELETE FROM admin_elevation_codes WHERE user_id IN(SELECT user_id FROM used)),`
    const sql = `WITH used AS (UPDATE admin_totp SET ${input.disable ? "last_step=last_step" : assignment}${disableSet}
    WHERE user_id=? AND deployment=? AND generation=? AND enabled AND ${condition} RETURNING user_id,generation),
    ${input.disable ? disableOperation : operation}
    audited AS (INSERT INTO admin_audit_log(user_id,action,detail) SELECT user_id,?,'{}' FROM used)
    SELECT generation FROM used`
    const bindings = [
      ...(input.disable ? [crypto.randomUUID()] : [value]),
      user.id,
      deployment(c),
      row.generation,
      guard,
      ...(input.disable ? [] : [c.get("sessionKey"), until]),
      input.disable
        ? "totp.disabled"
        : input.recovery
          ? "elevation.recovery"
          : "elevation.totp",
    ]
    const used = await c.env.AQUILLA_PG.prepare(sql)
      .bind(...bindings)
      .first()
    if (!used) return c.json({ error: "invalid_or_used_code" }, 400)
    return c.json(
      input.disable
        ? { enabled: false }
        : { elevated: true, elevatedUntil: until },
    )
  },
)
export default routes
