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
import { resolveRoleName, type RoleT } from "@/lib/frontier/roles"

export { ROLE }

/**
 * Event kinds the agent ProposalCard knows how to Apply in v1.
 *
 * AQU-890: the two `*.cell.create` kinds are genesis events — they mint a new
 * row rather than advancing an existing chain. They carry no extra gate here:
 * `canApply` reads their floors straight out of the shared role-policy mirror
 * (source.cell.create → commenter since AQU-1068's review round widened the
 * `cellEditingFloor` tier list, target.cell.create → contributor), which is
 * the same floor the native add-row affordance answers to. That mirror is the
 * LOWEST reachable floor, not the operative one: whether this project admits
 * the caller at all is the `cellEditingFloor` tier, and auth-worker asks that
 * question when it STAGES the proposal (lib/agent/emit-stage.ts), so a card
 * the tier would refuse never reaches this button. Since 2026-09-09 that
 * staging check is the only place the tier is enforced for the agent — the
 * sync perimeter no longer checks it (see sync-worker authorize.ts).
 */
export const SUPPORTED_APPLY_KINDS = [
  "target.cell.commit",
  "source.cell.create",
  "target.cell.create",
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
export function canApply(t: RoleT, kind: string, roleLevel: number | null | undefined): CanApplyResult {
  if (roleLevel == null) return { allowed: true }
  const required = requiredRoleFor(kind)
  if (required == null) return { allowed: true }
  if (roleLevel >= required) return { allowed: true }
  return {
    allowed: false,
    requiredLevel: required,
    reason: `Requires ${resolveRoleName(t, required)} role or higher`,
  }
}

/**
 * AQU-1630: the self-validation half of the Apply gate.
 *
 * SOURCE OF TRUTH: sync-worker/src/events/route.ts, the FRO-189 check #3 —
 * `allowSelfValidation === false` + the caller IS the cell's `last_editor`
 * → 403 `self-validation is not allowed on this project`. The role floor
 * above can't see this: `cell.validate` only needs REVIEWER, so a translator
 * who may validate in general is still refused on the line they just wrote.
 * Without this the agent's prepared validation looked applicable, the Apply
 * click sent it, and the user got the red rejection banner.
 *
 * `allowSelfValidation` is `project.allowSelfValidation` (useProject) and
 * `resolveLastEditor` reads `CellData.lastEditor` from the live useCells
 * projection — the same column the server compares.
 */
export interface SelfValidationGate {
  /** Project setting. Undefined/true = validating your own work is allowed. */
  allowSelfValidation?: boolean
  /** Current user — the author the applied event would carry. */
  username?: string | null
  /** The cell's last target editor, from the live projection. */
  resolveLastEditor?: (cellId: string) => string | null | undefined
}

/**
 * Whether a user may apply one staged event: the role floor first, then the
 * self-validation rule for `cell.validate`.
 *
 * Same fail-open posture as `canApply` — we block only when the refusal is
 * provable from what the client knows (the setting is OFF *and* the live
 * projection names this user as the line's last editor). An unknown setting,
 * an unloaded cell or an unknown user leaves the server authoritative.
 */
export function canApplyStagedEvent(
  t: RoleT,
  ev: { kind: string; cellId?: string },
  roleLevel: number | null | undefined,
  gate?: SelfValidationGate,
): CanApplyResult {
  const role = canApply(t, ev.kind, roleLevel)
  if (!role.allowed) return role
  if (ev.kind !== "cell.validate") return role
  if (gate?.allowSelfValidation !== false) return role
  if (!ev.cellId || !gate.username) return role
  const lastEditor = gate.resolveLastEditor?.(ev.cellId)
  if (!lastEditor || lastEditor !== gate.username) return role
  return { allowed: false, reason: t("agent.validation.selfValidationBlocked") }
}
