import type { Context } from "hono"
import type { AuthHonoEnv } from "../middleware/auth"
import { matchingStep } from "./admin-totp"
import {
  encryptIntegrationToken,
  decryptIntegrationToken,
} from "./integrations/token-crypto"
import { sha256Hex } from "../../../db/shared/api-credentials"
// Previews share the dev identity database: protection must follow the account,
// not the Worker hostname, or another preview could bypass an enrolled factor.
export const deployment = (c: Context<AuthHonoEnv>) =>
  c.env.ENVIRONMENT === "production" ? "production" : "development"
export interface SecurityFactor {
  enabled: boolean
  generation: string
  secret_enc: string
  last_step: number
}
export const securityFactor = (db: AquillaDb, id: number, scope: string) =>
  db
    .prepare("SELECT * FROM account_security WHERE user_id=? AND deployment=?")
    .bind(id, scope)
    .first<SecurityFactor>()
function key(c: Context<AuthHonoEnv>) {
  const value = c.env.ADMIN_TOTP_KEY
  if (!value || value.length < 32) throw new Error("authenticator_unavailable")
  return value
}
export const encryptAccountSeed = (c: Context<AuthHonoEnv>, seed: string) =>
  encryptIntegrationToken(
    key(c),
    `:account-security:${deployment(c)}:${c.get("user").id}`,
    seed,
  )
export const decryptAccountSeed = (c: Context<AuthHonoEnv>, seed: string) =>
  decryptIntegrationToken(
    key(c),
    `:account-security:${deployment(c)}:${c.get("user").id}`,
    seed,
  )
export async function securityAttempt(c: Context<AuthHonoEnv>) {
  const row = await c.env.AQUILLA_PG.prepare(
    `INSERT INTO account_security_attempts(user_id,deployment,started_at,attempts) VALUES(?,?,now(),1)
 ON CONFLICT(user_id,deployment) DO UPDATE SET attempts=CASE WHEN account_security_attempts.started_at<now()-interval '5 minutes' THEN 1 ELSE account_security_attempts.attempts+1 END,
 started_at=CASE WHEN account_security_attempts.started_at<now()-interval '5 minutes' THEN now() ELSE account_security_attempts.started_at END
 WHERE account_security_attempts.attempts<10 OR account_security_attempts.started_at<now()-interval '5 minutes' RETURNING attempts`,
  )
    .bind(c.get("user").id, deployment(c))
    .first()
  if (!row) throw new Error("rate_limited")
}
export async function grant(
  c: Context<AuthHonoEnv>,
  db: AquillaDb,
  kind: "primary" | "google" | "factor",
  generation: string,
) {
  await db
    .prepare(
      `INSERT INTO account_security_grants(user_id,deployment,session_key,kind,generation,expires_at) VALUES(?,?,?,?,?,now()+interval '5 minutes')
 ON CONFLICT(user_id,deployment,session_key,kind) DO UPDATE SET generation=EXCLUDED.generation,expires_at=EXCLUDED.expires_at`,
    )
    .bind(
      c.get("user").id,
      deployment(c),
      c.get("sessionKey"),
      kind,
      generation,
    )
    .run()
}
export async function hasGrant(
  c: Context<AuthHonoEnv>,
  db: AquillaDb,
  kind: string,
  generation?: string,
) {
  if (kind === "primary") {
    const row = await db
      .prepare("SELECT password_hash FROM users WHERE id=?")
      .bind(c.get("user").id)
      .first<{ password_hash: string | null }>()
    if (!row?.password_hash) return false
    generation = await sha256Hex(row.password_hash)
  }
  if (kind === "google") {
    const row = await db
      .prepare(
        "SELECT subject FROM provider_identities WHERE user_id=? AND provider='google'",
      )
      .bind(c.get("user").id)
      .first<{ subject: string }>()
    if (!row) return false
    generation = row.subject
  }
  return !!(await db
    .prepare(
      `SELECT 1 FROM account_security_grants WHERE user_id=? AND deployment=? AND session_key=? AND kind=? AND expires_at>now() AND (?::text IS NULL OR generation=?)`,
    )
    .bind(
      c.get("user").id,
      deployment(c),
      c.get("sessionKey"),
      kind,
      generation ?? null,
      generation ?? null,
    )
    .first())
}
export async function requireCurrentSecuritySession(
  c: Context<AuthHonoEnv>,
  db: AquillaDb = c.env.AQUILLA_PG,
) {
  const current = await db
    .prepare("SELECT session_version FROM users WHERE id=?")
    .bind(c.get("user").id)
    .first<{ session_version: number }>()
  if (
    !current ||
    current.session_version !== (c.get("user").session_version ?? 0)
  )
    throw new Error("fresh_verification_required")
}
export async function requireSettingsProof(
  c: Context<AuthHonoEnv>,
  db: AquillaDb = c.env.AQUILLA_PG,
) {
  await requireCurrentSecuritySession(c, db)
  const factor = await securityFactor(db, c.get("user").id, deployment(c))
  if (factor?.enabled && !(await hasGrant(c, db, "factor", factor.generation)))
    throw new Error("settings_verification_required")
}
export async function consumeFactor(
  c: Context<AuthHonoEnv>,
  db: AquillaDb,
  code: string,
  recovery: boolean,
  issueGrant = true,
) {
  const row = await securityFactor(db, c.get("user").id, deployment(c))
  if (!row?.enabled) throw new Error("not_enrolled")
  const value = recovery
    ? await sha256Hex(code.trim().toUpperCase().replace(/[ -]/g, ""))
    : await matchingStep(await decryptAccountSeed(c, row.secret_enc), code)
  if (value === null) throw new Error("invalid_code")
  const used = await db
    .prepare(
      `UPDATE account_security SET ${recovery ? "recovery_hashes=recovery_hashes - ?" : "last_step=?"}
 WHERE user_id=? AND deployment=? AND generation=? AND enabled AND ${recovery ? "recovery_hashes @> ?::text::jsonb" : "last_step < ?"} RETURNING generation`,
    )
    .bind(
      value,
      c.get("user").id,
      deployment(c),
      row.generation,
      recovery ? JSON.stringify([value]) : value,
    )
    .first()
  if (!used) throw new Error("invalid_code")
  if (issueGrant) await grant(c, db, "factor", row.generation)
}
