// AQU-1571: one answer to "may this viewer add a TEXT vote here?", mirroring
// the server's FRO-189 checks in sync-worker/src/events/route.ts.
//
// The server enforces three project rules on every `cell.validate`: the
// minimum role, the named-validator list, and "Allow self-validation". The
// client mirrored none of them for text (audio has had its twin since
// AQU-490), so a click the server was about to refuse went out anyway: the
// control flipped, the 403 came back, and the red "1 failed" banner was the
// first the reader heard of the rule. Every surface that offers a text vote —
// the gutter control, the agent pane, both bulk paths and auto-validate-on-
// edit — now asks here first.
//
// The server stays the authority. Where the two could disagree, this module
// errs towards letting the click through (an unknown editor never matches, a
// project with no roles skips the floor), because a wrong refusal here would
// lock a reader out of a vote the server would have accepted.
//
// Pure and free of i18n, so every rule is a fast unit test.
import type { ProjectRecord } from "@/lib/parsers/types"
import { ROLE } from "@/lib/sync/role-policy"

/**
 * The role a project's "minimum role to validate" names, as a level. Shared
 * by the text and audio rules — the server reads both against the same table.
 */
export const VALIDATION_ROLE_FLOOR: Record<string, number> = {
  reviewer: ROLE.REVIEWER,
  project_lead: ROLE.PROJECT_LEAD,
  maintainer: ROLE.MAINTAINER,
}

export interface TextValidationPolicy {
  /** The viewer's project role level, or null for a local/git project. */
  roleLevel: number | null
  username: string
}

export interface TextValidationScope {
  /** May the viewer validate text anywhere in this project? */
  canValidate: boolean
  reason: "role" | "allowlist" | null
}

/**
 * The project-wide half: role floor, then the named-validator list, in the
 * server's order. Neither depends on the line, so callers resolve it once.
 */
export function textValidationScope(
  project: Pick<ProjectRecord, "validationRoleFloor" | "validationNamedUsers">,
  policy: TextValidationPolicy,
): TextValidationScope {
  // A local or git project has no role ladder; the server never sees it.
  if (policy.roleLevel !== null) {
    const floorName = project.validationRoleFloor
    const floor = floorName ? VALIDATION_ROLE_FLOOR[floorName] : undefined
    if (floor !== undefined && policy.roleLevel < floor) {
      return { canValidate: false, reason: "role" }
    }
  }
  const allowlist = project.validationNamedUsers
  if (allowlist && allowlist.length > 0 && !allowlist.includes(policy.username)) {
    return { canValidate: false, reason: "allowlist" }
  }
  return { canValidate: true, reason: null }
}

/**
 * Did the viewer make the latest change to this line's text, on a project
 * that forbids validating your own change?
 *
 * `lastEditor` is the ACTIVE lane's target row's (`cells.last_editor`), with
 * the viewer stamped in while an edit of theirs is still unsynced. Absent or
 * empty is UNKNOWN — old imported rows carry none — and never matches, or
 * turning the setting off would lock everybody out of exactly the oldest text
 * (the same rule as `canValidateTake` for recordings). Exact match, as the
 * server compares.
 */
export function isOwnTextEdit(
  cell: { lastEditor?: string | null },
  username: string,
  allowSelfValidation: boolean | undefined,
): boolean {
  if (allowSelfValidation !== false) return false
  const editor = cell.lastEditor
  return editor != null && editor !== "" && editor === username
}

/** Why the viewer may not add a text vote on a line: a project rule about who
 *  validates ("policy"), or the line is their own latest change ("self"). */
export type TextValidationBlock = "policy" | "self"

/**
 * The line-level answer: the project rules first, then self-validation —
 * the server's order, so the reason shown is the one the server would give.
 */
export function textValidationBlock(
  cell: { lastEditor?: string | null },
  project: Pick<ProjectRecord, "validationRoleFloor" | "validationNamedUsers" | "allowSelfValidation">,
  policy: TextValidationPolicy,
): TextValidationBlock | null {
  if (!textValidationScope(project, policy).canValidate) return "policy"
  if (isOwnTextEdit(cell, policy.username, project.allowSelfValidation)) return "self"
  return null
}
