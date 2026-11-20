import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import {
  authMiddleware,
  resolveSession,
  type AuthHonoEnv,
} from "../middleware/auth"
import { accountMutation } from "../lib/account-mutation"
import {
  deployment,
  securityFactor,
  securityAttempt,
  grant,
  hasGrant,
  requireSettingsProof,
  requireCurrentSecuritySession,
  consumeFactor,
  encryptAccountSeed,
  decryptAccountSeed,
} from "../lib/account-security"
import { base32, matchingStep } from "../lib/admin-totp"
import { sha256Hex } from "../../../db/shared/api-credentials"
import { verifyPassword, hashPasswordWerkzeugScrypt } from "../utils/password"
import { evictUserSessions } from "../lib/session-cache"
import { JWTService } from "../auth/jwt"

const routes = new Hono<AuthHonoEnv>()
routes.use(
  "*",
  bodyLimit({ maxSize: 8192 }),
  authMiddleware,
  async (c, next) => {
    c.header("Cache-Control", "no-store")
    const fresh = await resolveSession(c.env, c.req.header("Authorization"), {
      fresh: true,
    })
    if (!fresh.ok) return c.json({ error: "session_expired" }, 401)
    c.set("user", fresh.user)
    c.set("sessionKey", fresh.sessionKey)
    await next()
  },
)
routes.onError((error, c) => {
  const known = [
    "rate_limited",
    "invalid_password",
    "fresh_verification_required",
    "settings_verification_required",
    "invalid_code",
    "not_enrolled",
    "setup_expired",
    "already_enrolled",
    "last_login_method",
    "authenticator_unavailable",
  ]
  if (!known.includes(error.message)) {
    console.error("[account-security] operation failed")
    return c.json({ error: "unavailable" }, 503)
  }
  return c.json(
    { error: error.message },
    error.message === "rate_limited"
      ? 429
      : error.message === "authenticator_unavailable"
        ? 503
        : 403,
  )
})
routes.get("/", async (c) => {
  const f = await securityFactor(
    c.env.AQUILLA_PG,
    c.get("user").id,
    deployment(c),
  )
  const methods = await c.env.AQUILLA_PG.prepare(
    "SELECT password_hash IS NOT NULL AS password, EXISTS(SELECT 1 FROM provider_identities WHERE user_id=users.id AND provider='google') AS google FROM users WHERE id=?",
  )
    .bind(c.get("user").id)
    .first<{ password: boolean; google: boolean }>()
  return c.json({
    password: !!methods?.password,
    google: !!methods?.google,
    google_verified:
      !!methods?.google && (await hasGrant(c, c.env.AQUILLA_PG, "google")),
    google_available: !!(
      c.env.GOOGLE_LOGIN_CLIENT_ID &&
      c.env.GOOGLE_LOGIN_CLIENT_SECRET &&
      c.env.GOOGLE_LOGIN_REDIRECT_URI &&
      c.env.GOOGLE_LOGIN_APP_ORIGINS
    ),
    enabled: !!f?.enabled,
    configured: !!c.env.ADMIN_TOTP_KEY && c.env.ADMIN_TOTP_KEY.length >= 32,
    verified:
      !!f?.enabled &&
      (await hasGrant(c, c.env.AQUILLA_PG, "factor", f.generation)),
  })
})
routes.use("*", async (c, next) => {
  if (c.req.method !== "GET") await securityAttempt(c)
  await next()
})
routes.post(
  "/password-proof",
  zValidator("json", z.object({ password: z.string().min(1).max(1024) })),
  async (c) => {
    await accountMutation(c.env.AQUILLA_PG, c.get("user").id, async (db) => {
      await requireCurrentSecuritySession(c, db)
      const row = await db
        .prepare("SELECT password_hash FROM users WHERE id=?")
        .bind(c.get("user").id)
        .first<{ password_hash: string | null }>()
      if (
        !row?.password_hash ||
        !(await verifyPassword(c.req.valid("json").password, row.password_hash))
          .isValid
      )
        throw new Error("invalid_password")
      await grant(c, db, "primary", await sha256Hex(row.password_hash))
    })
    return c.json({ verified: true })
  },
)
routes.post("/setup", async (c) => {
  return accountMutation(c.env.AQUILLA_PG, c.get("user").id, async (db) => {
    await requireCurrentSecuritySession(c, db)
    if (
      !(await hasGrant(c, db, "primary")) &&
      !(await hasGrant(c, db, "google"))
    )
      throw new Error("fresh_verification_required")
    const secret = base32(crypto.getRandomValues(new Uint8Array(20))),
      generation = crypto.randomUUID()
    const row = await db
      .prepare(
        `INSERT INTO account_security(user_id,deployment,generation,secret_enc,setup_session,expires_at) VALUES(?,?,?,?,?,now()+interval '10 minutes')
 ON CONFLICT(user_id,deployment) DO UPDATE SET generation=EXCLUDED.generation,secret_enc=EXCLUDED.secret_enc,setup_session=EXCLUDED.setup_session,expires_at=EXCLUDED.expires_at,confirmed_step=NULL,recovery_hashes='[]',last_step=-1 WHERE NOT account_security.enabled RETURNING generation`,
      )
      .bind(
        c.get("user").id,
        deployment(c),
        generation,
        await encryptAccountSeed(c, secret),
        c.get("sessionKey"),
      )
      .first()
    if (!row) throw new Error("already_enrolled")
    return c.json({
      secret,
      generation,
      uri: `otpauth://totp/${encodeURIComponent(`Aquilla:${c.get("user").email}`)}?secret=${secret}&issuer=Aquilla&algorithm=SHA1&digits=6&period=30`,
    })
  })
})
const proof = z.object({
  code: z.string().min(6).max(64),
  recovery: z.boolean().optional(),
})
routes.post(
  "/confirm",
  zValidator("json", proof.extend({ generation: z.string().uuid() })),
  async (c) =>
    accountMutation(c.env.AQUILLA_PG, c.get("user").id, async (db) => {
      await requireCurrentSecuritySession(c, db)
      const f = await securityFactor(db, c.get("user").id, deployment(c)),
        input = c.req.valid("json")
      if (!f || f.enabled || f.generation !== input.generation)
        throw new Error("setup_expired")
      const step = await matchingStep(
        await decryptAccountSeed(c, f.secret_enc),
        input.code,
      )
      if (step === null) throw new Error("invalid_code")
      const codes = Array.from({ length: 8 }, () =>
        base32(crypto.getRandomValues(new Uint8Array(16))),
      )
      const hashes = await Promise.all(codes.map(sha256Hex))
      const updated = await db
        .prepare(
          `UPDATE account_security SET confirmed_step=?,recovery_hashes=?::text::jsonb WHERE user_id=? AND deployment=? AND generation=? AND NOT enabled AND setup_session=? AND expires_at>now() AND confirmed_step IS NULL RETURNING generation`,
        )
        .bind(
          step,
          JSON.stringify(hashes),
          c.get("user").id,
          deployment(c),
          f.generation,
          c.get("sessionKey"),
        )
        .first()
      if (!updated) throw new Error("setup_expired")
      return c.json({ recoveryCodes: codes })
    }),
)
routes.post(
  "/complete",
  zValidator(
    "json",
    z.object({
      generation: z.string().uuid(),
      savedRecoveryCodes: z.literal(true),
    }),
  ),
  async (c) =>
    accountMutation(c.env.AQUILLA_PG, c.get("user").id, async (db) => {
      await requireCurrentSecuritySession(c, db)
      const updated = await db
        .prepare(
          `UPDATE account_security SET enabled=true,last_step=confirmed_step WHERE user_id=? AND deployment=? AND generation=? AND NOT enabled AND confirmed_step IS NOT NULL AND setup_session=? AND expires_at>now() RETURNING generation`,
        )
        .bind(
          c.get("user").id,
          deployment(c),
          c.req.valid("json").generation,
          c.get("sessionKey"),
        )
        .first<{ generation: string }>()
      if (!updated) throw new Error("setup_expired")
      await db
        .prepare("DELETE FROM password_reset_tokens WHERE user_id=?")
        .bind(c.get("user").id)
        .run()
      await grant(c, db, "factor", updated.generation)
      return c.json({ enabled: true })
    }),
)
routes.post(
  "/verify",
  zValidator(
    "json",
    proof
      .extend({
        disable: z.boolean().optional(),
        regenerate: z.boolean().optional(),
      })
      .refine((input) => !(input.disable && input.regenerate)),
  ),
  async (c) =>
    accountMutation(c.env.AQUILLA_PG, c.get("user").id, async (db) => {
      await requireCurrentSecuritySession(c, db)
      const input = c.req.valid("json")
      await consumeFactor(c, db, input.code, !!input.recovery)
      if (input.disable) {
        await db
          .prepare(
            "DELETE FROM account_security WHERE user_id=? AND deployment=?",
          )
          .bind(c.get("user").id, deployment(c))
          .run()
        await db
          .prepare(
            "DELETE FROM account_security_grants WHERE user_id=? AND deployment=? AND kind='factor'",
          )
          .bind(c.get("user").id, deployment(c))
          .run()
      }
      if (input.regenerate) {
        const codes = Array.from({ length: 8 }, () =>
          base32(crypto.getRandomValues(new Uint8Array(16))),
        )
        const generation = crypto.randomUUID()
        await db
          .prepare(
            "UPDATE account_security SET recovery_hashes=?::text::jsonb,generation=? WHERE user_id=? AND deployment=?",
          )
          .bind(
            JSON.stringify(await Promise.all(codes.map(sha256Hex))),
            generation,
            c.get("user").id,
            deployment(c),
          )
          .run()
        await grant(c, db, "factor", generation)
        return c.json({ recoveryCodes: codes })
      }
      return c.json({ verified: true })
    }),
)
routes.post(
  "/password",
  zValidator("json", z.object({ password: z.string().min(8).max(1024) })),
  async (c) => {
    const hash = await hashPasswordWerkzeugScrypt(c.req.valid("json").password)
    const version = await accountMutation(
      c.env.AQUILLA_PG,
      c.get("user").id,
      async (db) => {
        await requireCurrentSecuritySession(c, db)
        await requireSettingsProof(c, db)
        if (
          !(await hasGrant(c, db, "google")) &&
          !(await hasGrant(c, db, "primary"))
        )
          throw new Error("fresh_verification_required")
        const previous = await db
          .prepare(
            "SELECT password_hash IS NOT NULL AS password FROM users WHERE id=?",
          )
          .bind(c.get("user").id)
          .first<{ password: boolean }>()
        const row = await db
          .prepare(
            "UPDATE users SET password_changed_at=CASE WHEN password_hash IS NULL THEN password_changed_at ELSE now() END,session_version=CASE WHEN password_hash IS NULL THEN session_version ELSE session_version+1 END,password_hash=?,password_login_disabled=false,updated_at=now() WHERE id=? RETURNING session_version",
          )
          .bind(hash, c.get("user").id)
          .first<{ session_version: number }>()
        await db
          .prepare("DELETE FROM password_reset_tokens WHERE user_id=?")
          .bind(c.get("user").id)
          .run()
        await db
          .prepare(
            "DELETE FROM account_security_grants WHERE user_id=? AND kind='primary'",
          )
          .bind(c.get("user").id)
          .run()
        if (previous?.password)
          await db
            .prepare(
              "UPDATE api_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=?",
            )
            .bind(String(c.get("user").id))
            .run()
        return row!.session_version
      },
    )
    evictUserSessions(c.get("user").id)
    const { token } = await new JWTService(c.env).createAccessTokenWithPayload(
      c.get("user").username,
      undefined,
      undefined,
      c.get("user").id,
      version,
    )
    return c.json({
      password: true,
      access_token: token,
      username: c.get("user").username,
      token_type: "bearer",
    })
  },
)
routes.post("/remove-password", async (c) => {
  const user = c.get("user")
  const version = await accountMutation(
    c.env.AQUILLA_PG,
    user.id,
    async (db) => {
      await requireCurrentSecuritySession(c, db)
      await requireSettingsProof(c, db)
      if (!(await hasGrant(c, db, "google")))
        throw new Error("fresh_verification_required")
      const linked = await db
        .prepare(
          "SELECT 1 FROM provider_identities WHERE user_id=? AND provider='google'",
        )
        .bind(user.id)
        .first()
      if (!linked) throw new Error("last_login_method")
      const row = await db
        .prepare(
          "UPDATE users SET password_hash=NULL,password_login_disabled=true,session_version=session_version+1,password_changed_at=now(),updated_at=now() WHERE id=? RETURNING session_version",
        )
        .bind(user.id)
        .first<{ session_version: number }>()
      await db
        .prepare("DELETE FROM password_reset_tokens WHERE user_id=?")
        .bind(user.id)
        .run()
      await db
        .prepare("DELETE FROM account_security_grants WHERE user_id=?")
        .bind(user.id)
        .run()
      await db
        .prepare(
          "UPDATE api_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=?",
        )
        .bind(String(user.id))
        .run()
      return row!.session_version
    },
  )
  evictUserSessions(user.id)
  const { token } = await new JWTService(c.env).createAccessTokenWithPayload(
    user.username,
    undefined,
    undefined,
    user.id,
    version,
  )
  return c.json({
    password: false,
    access_token: token,
    username: user.username,
    token_type: "bearer",
  })
})
export default routes
