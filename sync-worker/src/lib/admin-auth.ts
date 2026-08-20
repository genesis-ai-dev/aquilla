// Authorization for the operator-facing admin and migration routes.
//
// Why this exists (docs/OPSEC-REVIEW-2026-08-10.md, OPS-2): every one of these
// routes gated on `Authorization: Bearer ${SYNC_SECRET_KEY}` — the *token
// signing key*. Which meant that running an R2 cleanup, an FTS rebuild, or any
// migration step put the key that mints sync tokens for every project into a
// shell history, a terminal scrollback, and whatever log an intermediary keeps.
// The code was fine; the credential was wrong.
//
// `ADMIN_SECRET` is the dedicated operator credential. This compatibility
// module lets migration routes share dev's established precedence contract:
// once ADMIN_SECRET is provisioned, SYNC_SECRET_KEY is no longer accepted on
// operator routes. Before provisioning, the signing key remains the rollout
// fallback so existing environments do not lock operators out.
import { adminBearerMatches, resolveAdminSecret } from "./admin-secret"

export interface AdminAuthEnv {
  /** Dedicated operator credential. Preferred; provision per environment with
   *  `wrangler secret put ADMIN_SECRET --env <env>`. */
  ADMIN_SECRET?: string
  /** Token-signing key. Accepted as a legacy admin bearer — see the note above. */
  SYNC_SECRET_KEY?: string
}

export function isAuthorizedAdminBearer(authHeader: string, env: AdminAuthEnv): boolean {
  return adminBearerMatches(authHeader, env)
}

/** True when at least one admin-capable secret is bound. Routes 500 otherwise —
 *  an unauthenticated admin surface must fail closed, not open. */
export function hasAdminSecretConfigured(env: AdminAuthEnv): boolean {
  return Boolean(resolveAdminSecret(env))
}
