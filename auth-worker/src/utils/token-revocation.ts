// [Pen test] Auth & session mgmt (2026-08-03): server-side logout. Access
// tokens are stateless JWTs with no revocation path other than a password
// reset (see middleware/auth.ts, migration 0066) — logging out only ever
// deleted the token client-side, so a stolen token kept authenticating for
// up to ACCESS_TOKEN_EXPIRE_MINUTES (30 days by default) after the user
// logged out. This is a denylist keyed by the JWT `jti` claim, backed by
// revoked_tokens (migration 0073).
//
// Tokens minted before this change carry no `jti` and simply can't be
// revoked individually — callers should skip the check entirely when
// `jti` is absent rather than treat it as "revoked".

import { evictSessionByJti } from "../lib/session-cache"

function scopedError(prefix: string, err: unknown): void {
  console.warn(`[token-revocation] ${prefix}:`, err)
}

/** Denylists a token so authMiddleware rejects it on every future request
 *  until it would have expired naturally anyway. Idempotent — logging out
 *  twice with the same token is a no-op the second time. */
export async function revokeToken(
  db: AquillaDb,
  jti: string,
  userId: number,
  expSeconds: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO revoked_tokens (jti, user_id, expires_at)
       VALUES (?, ?, to_timestamp(?))
       ON CONFLICT (jti) DO NOTHING`,
    )
    .bind(jti, userId, expSeconds)
    .run()
  // Same-isolate eviction; other isolates age the entry out within
  // SESSION_CACHE_TTL_MS (see lib/session-cache.ts).
  evictSessionByJti(jti)
}

/**
 * Fail open on a DB error, matching this codebase's established posture for
 * auth-adjacent infra checks (see utils/rate-limit.ts `countRecentEvents`):
 * a throttling/revocation-infrastructure outage must not take down every
 * authenticated request. The primary defenses against a stolen token
 * (30-day expiry ceiling, password-reset invalidation) are unaffected by
 * this check failing open.
 */
export async function isTokenRevoked(db: AquillaDb, jti: string): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT 1 AS present FROM revoked_tokens WHERE jti = ?")
      .bind(jti)
      .first<{ present: number }>()
    return row != null
  } catch (err) {
    scopedError("revocation check failed, failing open", err)
    return false
  }
}

/** Prunes rows past their natural token expiry so the table stays bounded.
 *  Called from the 5-minute cron in index.ts (`scheduled`) — it used to run
 *  on ~2% of logouts inline, on the request path. Non-throwing. */
export async function pruneExpiredRevokedTokens(db: AquillaDb): Promise<void> {
  try {
    await db.prepare("DELETE FROM revoked_tokens WHERE expires_at < now()").bind().run()
  } catch (err) {
    scopedError("prune failed (non-fatal)", err)
  }
}
