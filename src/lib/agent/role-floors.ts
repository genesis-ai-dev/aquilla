/**
 * role-floors.ts — event-kind → minimum role-level floors for the agent
 * proposal Apply gate.
 *
 * SOURCE OF TRUTH: sync-worker/src/events/role-policy.ts (REQUIRED_ROLE).
 * The client already mirrors that table as data in
 * src/lib/sync/role-policy.ts — this module reuses that single mirror rather
 * than forking a third copy that could drift. The server re-validates the
 * role on every staged event; this gate only prevents a guaranteed-403 from
 * entering the durable outbox (and gives the Apply button an honest disabled
 * reason).
 *
 * The current user's project role reaches components as
 * `project.syncRole?.level` (useProject → ProjectWorkspace
 * `currentRoleLevel`); pass that value as `roleLevel` here.
 */

import { requiredRoleFor, ROLE } from "@/lib/sync/role-policy"
import { roleDisplayLabel } from "@/lib/frontier/roles"

export { ROLE }

/** Event kinds the agent ProposalCard knows how to Apply in v1. */
export const SUPPORTED_APPLY_KINDS = [
  "target.cell.commit",
  "comment.create",
  "cell.validate",
] as const

export type SupportedApplyKind = (typeof SUPPORTED_APPLY_KINDS)[number]

export function isSupportedApplyKind(kind: string): kind is SupportedApplyKind {
  return (SUPPORTED_APPLY_KINDS as readonly string[]).includes(kind)
}

export interface CanApplyResult {
  allowed: boolean
  /** Human reason when blocked, e.g. "Requires contributor role or higher". */
  reason?: string
  /** The floor that blocked the apply (for tests / telemetry). */
  requiredLevel?: number
}

/**
 * Whether a user at `roleLevel` may apply a staged event of `kind`.
 *
 * Mirrors the fail-open posture of the rest of the client write path
 * (events-emit.ts enqueueEvent): we only block when the role is KNOWN and
 * provably below a KNOWN floor — the server stays authoritative for
 * everything else. Unsupported kinds are handled separately by the card
 * (Apply disabled with a "not supported yet" note), not here.
 */
export function canApply(kind: string, roleLevel: number | null | undefined): CanApplyResult {
  if (roleLevel == null) return { allowed: true }
  const required = requiredRoleFor(kind)
  if (required == null) return { allowed: true }
  if (roleLevel >= required) return { allowed: true }
  return {
    allowed: false,
    requiredLevel: required,
    reason: `Requires ${roleDisplayLabel(required)} role or higher`,
  }
}
