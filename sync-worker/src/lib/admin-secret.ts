// OPS-2 — one place that decides what counts as an admin bearer.
//
// Two routes are admin-gated (`/admin/files/*` in admin.ts, `DELETE /audio/*`
// in audio.ts). Both historically accepted `SYNC_SECRET_KEY` — the key that
// signs sync tokens — as their bearer, which meant every ad-hoc ops call put a
// project-minting key into shell history and terminal scrollback. `ADMIN_SECRET`
// is a dedicated credential whose blast radius is just those routes.
//
// The precedence rule is deliberately "one or the other, never both": once an
// environment has `ADMIN_SECRET`, the signing key stops being accepted there.
// If both were accepted, provisioning the new secret would *widen* the accepted
// set and the old habit would never die. The fallback exists only so the
// rollout can go one environment at a time without locking ops out.

import { secureCompare } from "./secure-compare"

export interface AdminSecretEnv {
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
}

/**
 * The single secret this environment accepts on admin routes, or null when
 * neither is configured (in which case admin routes must fail closed).
 */
export function resolveAdminSecret(env: AdminSecretEnv): string | null {
  const dedicated = env.ADMIN_SECRET?.trim()
  if (dedicated) return dedicated
  const fallback = env.SYNC_SECRET_KEY?.trim()
  return fallback ? fallback : null
}

/**
 * Constant-time check of an `Authorization` header against the admin secret.
 * Returns false when no secret is configured — an unconfigured environment
 * denies admin access rather than accepting `Bearer undefined`.
 */
export function adminBearerMatches(authHeader: string, env: AdminSecretEnv): boolean {
  const secret = resolveAdminSecret(env)
  if (!secret) return false
  return secureCompare(authHeader, `Bearer ${secret}`)
}
