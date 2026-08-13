// Authorization for the operator-facing admin and migration routes.
//
// Why this exists (docs/OPSEC-REVIEW-2026-08-10.md, OPS-2): every one of these
// routes gated on `Authorization: Bearer ${SYNC_SECRET_KEY}` — the *token
// signing key*. Which meant that running an R2 cleanup, an FTS rebuild, or any
// migration step put the key that mints sync tokens for every project into a
// shell history, a terminal scrollback, and whatever log an intermediary keeps.
// The code was fine; the credential was wrong.
//
// `ADMIN_SECRET` is a dedicated operator credential. It is optional, and this
// module accepts EITHER secret, deliberately:
//
//   - The service-to-service callers (auth-worker → sync-worker, and
//     sync-worker → its own DO broadcast routes) still send SYNC_SECRET_KEY.
//     They are machine calls over TLS and never touch a shell, so they are not
//     the exposure OPS-2 is about — and leaving them alone means provisioning
//     ADMIN_SECRET cannot lock anyone out, in any order, on any environment.
//   - Once `ADMIN_SECRET` is provisioned, operators use it and stop handling
//     the signing key. That is the whole win, and it lands the moment the
//     secret exists — no deploy, no coordination.
//
// Closing OPS-2 completely means dropping the SYNC_SECRET_KEY branch below,
// which is a one-line change *after* the service-to-service callers have moved
// to their own credential. Until then this is a reduction in exposure, not an
// authorization boundary: anyone holding SYNC_SECRET_KEY can mint tokens for
// any project anyway, so admin access is the least of what they have.
import { secureCompare } from "./secure-compare"

export interface AdminAuthEnv {
  /** Dedicated operator credential. Preferred; provision per environment with
   *  `wrangler secret put ADMIN_SECRET --env <env>`. */
  ADMIN_SECRET?: string
  /** Token-signing key. Accepted as a legacy admin bearer — see the note above. */
  SYNC_SECRET_KEY?: string
}

/**
 * True when `authHeader` carries a bearer token that authorizes an admin or
 * migration route. Both comparisons always run and both are constant-time, so
 * a caller cannot learn *which* secret it got wrong from the response timing.
 */
export function isAuthorizedAdminBearer(authHeader: string, env: AdminAuthEnv): boolean {
  const adminMatch = env.ADMIN_SECRET
    ? secureCompare(authHeader, `Bearer ${env.ADMIN_SECRET}`)
    : false
  const legacyMatch = env.SYNC_SECRET_KEY
    ? secureCompare(authHeader, `Bearer ${env.SYNC_SECRET_KEY}`)
    : false
  return adminMatch || legacyMatch
}

/** True when at least one admin-capable secret is bound. Routes 500 otherwise —
 *  an unauthenticated admin surface must fail closed, not open. */
export function hasAdminSecretConfigured(env: AdminAuthEnv): boolean {
  return Boolean(env.ADMIN_SECRET || env.SYNC_SECRET_KEY)
}
