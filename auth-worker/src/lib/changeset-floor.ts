// Approval authority floor for a staged changeset (AQU-CMDREG-P1 §2.1).
//
// The approval surface used to gate on IDENTITY (created_by_user_id === the
// session user). It now gates on AUTHORITY: the caller's LIVE project role
// must be at or above the floor the plan was staged against. The floor is
// recomputed from the stored `commands` on every call — never read from a
// column — so a creator whose role has since dropped loses approval rights,
// and a colleague who holds the floor gains them.
//
// The floor NUMBERS are not redeclared here. `requiredRoleForCommand`
// (sync-worker/src/external/commands.ts) is the single source of truth that
// prepare and commit already enforce, so auth-worker imports it across the
// package boundary rather than mirroring it. Its transitive graph is pure TS
// (role-policy, the command modules, db/shared) — no sync-worker binding, R2,
// or Durable Object type reaches auth-worker through it.
//
// Org-configurable floors are resolved here before the command walk:
// assignment EmitEvents use assignmentMinRole exactly (so lowering and raising
// both work), while terminology PatchSettings retains its existing
// raise-only mirror of sync-worker's private requiredRoleForOps arithmetic.
//
// SWARM-TODO(AQU-CMDREG-P1): once sync-worker's external/authority.ts
// (§2.3, built in parallel) has landed, collapse the max-over-commands walk and
// the CreateProject carve-out below onto its requiredFloorForChangeset /
// isProjectCreation, and export requiredRoleForOps so the termbase raise above
// can become an exact match instead of a ceiling.

import {
  commandsContainAssignmentEvents,
  requiredRoleForCommand,
  type Command,
} from "../../../sync-worker/src/external/commands"
import { describeCommand } from "../../../db/shared/command-catalog"
import {
  getAssignmentMinRoleForProject,
  getTermbaseEditMinRoleForProject,
} from "../services/org-permissions"
import { ROLE, type Env } from "../types"

/** Floor for a plan whose stored commands cannot be read as the known command
 *  union (corrupt row, or a kind this deployment predates). An authority gate
 *  must fail CLOSED: an unreadable plan is approvable by an owner only. */
export const UNREADABLE_PLAN_FLOOR: number = ROLE.OWNER

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Stored JSONB reads back as a value or (shim-dependent) as a JSON string. */
function parseCommandList(raw: unknown): unknown[] | null {
  let value = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return null
    }
  }
  return Array.isArray(value) ? value : null
}

/** Narrow one stored command far enough to hand it to requiredRoleForCommand.
 *  Only the fields that function READS are checked — PatchSettings.ops and
 *  EmitEvents.events, whose floors are computed from their contents; every
 *  other kind's floor is field-invariant. A command that fails the check is
 *  not "floor 400", it is unreadable — the caller fails closed. */
function asFloorCommand(raw: unknown): Command | null {
  if (!isRecord(raw)) return null
  const kind = raw.kind
  if (typeof kind !== "string" || !describeCommand(kind)) return null
  if (kind === "PatchSettings") {
    const ops = raw.ops
    if (!Array.isArray(ops)) return null
    if (!ops.every((op) => isRecord(op) && typeof op.key === "string")) return null
  }
  if (kind === "EmitEvents") {
    const events = raw.events
    if (!Array.isArray(events)) return null
    if (!events.every((e) => isRecord(e) && typeof e.kind === "string")) return null
  }
  return raw as unknown as Command
}

/**
 * True when the plan CREATES a project. Such a plan keeps the creator rule:
 * its authority is org-level (re-checked at commit) and the project it names
 * does not exist until commit, so no project role can resolve against it —
 * a role floor would deny everyone, including the person who staged it.
 *
 * Mirrors the same carve-out in sync-worker/src/external/authority.ts. Both
 * copies exist only because the rule has to be applied on two different
 * principal shapes (browser session here, credential context there); the FLOOR
 * itself is imported, never restated.
 */
export function planCreatesProject(commandsRaw: unknown): boolean {
  const rawList = parseCommandList(commandsRaw)
  if (!rawList) return false
  return rawList.some((raw) => isRecord(raw) && raw.kind === "CreateProject")
}

/** True when the plan patches the `terminology` settings key — the one op
 *  whose floor is an ORG setting rather than a constant. */
function touchesTerminology(commands: readonly Command[]): boolean {
  return commands.some(
    (c) => c.kind === "PatchSettings" && c.ops.some((op) => op.key === "terminology"),
  )
}

/**
 * The project role a caller must hold to view / approve / reject this
 * changeset: `max` over its stored commands' floors.
 *
 * @param commandsRaw the changesets.commands JSONB, as read from the row.
 */
export async function requiredRoleForChangeset(
  env: Env,
  projectId: string,
  commandsRaw: unknown,
): Promise<number> {
  const rawList = parseCommandList(commandsRaw)
  if (!rawList || rawList.length === 0) return UNREADABLE_PLAN_FLOOR

  const commands: Command[] = []
  for (const raw of rawList) {
    const cmd = asFloorCommand(raw)
    if (!cmd) return UNREADABLE_PLAN_FLOOR
    commands.push(cmd)
  }

  let floor: number
  try {
    const assignmentMinRole = commandsContainAssignmentEvents(commands)
      ? await getAssignmentMinRoleForProject(env, projectId)
      : undefined
    floor = Math.max(
      ...commands.map((command) => requiredRoleForCommand(command, assignmentMinRole)),
    )
  } catch {
    return UNREADABLE_PLAN_FLOOR
  }
  if (!Number.isFinite(floor)) return UNREADABLE_PLAN_FLOOR

  // Costs an extra read only when the plan actually touches terminology.
  if (touchesTerminology(commands)) {
    floor = Math.max(floor, await getTermbaseEditMinRoleForProject(env, projectId))
  }
  return floor
}
