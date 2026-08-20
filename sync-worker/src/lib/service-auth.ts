// OPS-11 — one place that decides whether a request carries the
// service-to-service bearer.
//
// Background. `SYNC_SECRET_KEY` is the sync-token *signing* key, and it doubles
// as the shared bearer on every internal call the identity Worker makes into
// this one: `/admin/projects/:id/archive`, `.../member-removed`,
// `.../settings-changed`, `.../contextual-activity`, plus the DO's
// `__broadcast` / `__link-sync` / `__member-removed`.
//
// OPS-2 (docs/OPSEC-REVIEW-2026-08-13.md) gave the *operator* routes a
// dedicated credential and, more importantly, a single place to decide the
// question — `lib/admin-secret.ts`. The *service* routes got neither, so every
// new endpoint has re-implemented the same four lines by hand. That is not a
// style complaint: `contextual-activity-notify.ts` landed with
//
//     request.headers.get('Authorization') !== expected
//
// i.e. a short-circuiting compare on attacker-supplied input against the
// signing key — the exact bug `audio.ts` had already been fixed for, and the
// reason `lib/secure-compare.ts` exists at all. The first fix had nowhere to
// live, so it did not travel.
//
// Every service gate now calls `serviceBearerMatches`, and
// `service-auth.test.ts` fails the build if a new one hand-rolls the
// comparison again.
//
// Deliberately NOT doing what admin-secret.ts does:
//
//   * No dedicated `SERVICE_SECRET` yet. admin-secret.ts can prefer
//     `ADMIN_SECRET` unilaterally because the caller is a human running
//     `pnpm admin:request`. These callers are another Worker, so the sender and
//     the receiver have to change in one step — that is the "move the
//     service-to-service callers to their own credential" half of OPS-2's
//     remaining work, and it wants a deploy-ordering plan this module is only
//     the precondition for. See §5 of the 2026-08-17 review.
//   * No `.trim()`. admin-secret.ts trims both candidates because it also
//     controls its senders. Here the sender builds `Bearer ${SYNC_SECRET_KEY}`
//     from its own binding; trimming on one side only would turn a secret
//     stored with a trailing newline from "works" into "401s in production".
//     Trim both sides together or neither.

import { secureCompare } from "./secure-compare"

export interface ServiceAuthEnv {
  /** Token-signing key, currently doubling as the service bearer. */
  SYNC_SECRET_KEY?: string
}

/**
 * Constant-time check of an `Authorization` header against the service bearer.
 *
 * Returns false when no secret is bound — an unconfigured environment must
 * reject service calls rather than accept `Bearer undefined`.
 */
export function serviceBearerMatches(
  authHeader: string | null | undefined,
  env: ServiceAuthEnv,
): boolean {
  const secret = env.SYNC_SECRET_KEY
  if (!secret) return false
  return secureCompare(authHeader ?? "", `Bearer ${secret}`)
}
