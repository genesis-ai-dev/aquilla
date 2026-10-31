/**
 * AQU-2289: the one list of roles for each level, and the cap that keeps it to
 * what the person choosing may grant.
 *
 * Every "Change role" and "Add member" door reads its choices from here, so
 * two doors can no longer offer different roles for the same level. Before
 * this, the Team page's Change role set a person's ORGANIZATION role from all
 * seven rungs, the project-only Commenter and Reviewer included, while the
 * org Members table offered five.
 *
 * - Organization: Viewer, Contributor, Project lead, Maintainer, plus Owner
 *   when an owner changes an existing member's role. Owner is never offered
 *   when adding or inviting (AQU-952): handing over a workspace is a change of
 *   someone already in it, and the email-invite route caps at Maintainer.
 * - Project: Viewer, Commenter, Reviewer, Contributor, Project lead,
 *   Maintainer. Ownership comes with creating a project; it is never picked.
 * - Team-scope roles are a different thing and are not here: their own three
 *   (`TEAM_ROLE_LEVELS`), set in a team's Team role column.
 *
 * The cap mirrors the server, which refuses a grant above the granter's own
 * level (`role_above_caller` on project members, "invalid or too-high role
 * level" on a team's project grant). A `null` caller level (not loaded yet)
 * keeps the whole list: the server stays the boundary, and a moment of null
 * must not hide choices from an owner.
 */
import {
  ORG_ROLE_CHANGE_OPTIONS,
  ORG_ROLE_OPTIONS,
  PROJECT_ROLE_OPTIONS,
  type RoleOption,
} from "./roles"

/** Which level a role applies to. */
export type RoleChoiceLevel = "org" | "project"

export interface RoleChoiceContext {
  /** The chooser's own role at that level. `null` while unknown. */
  callerLevel: number | null
  /**
   * `change` for Change role, `add` for Add member and invites. Only the
   * organization list differs: Owner is a change-only rung.
   */
  purpose?: "add" | "change"
}

export function roleChoices(
  level: RoleChoiceLevel,
  { callerLevel, purpose = "add" }: RoleChoiceContext,
): RoleOption[] {
  const list =
    level === "org"
      ? purpose === "change" ? ORG_ROLE_CHANGE_OPTIONS : ORG_ROLE_OPTIONS
      : PROJECT_ROLE_OPTIONS
  if (callerLevel === null) return [...list]
  return list.filter((r) => r.level <= callerLevel)
}
