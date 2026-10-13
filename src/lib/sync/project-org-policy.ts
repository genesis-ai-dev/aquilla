// AQU-1771: the org policy a PROJECT's own surfaces apply — the workspace,
// the project overview, project settings.
//
// These surfaces used to read the org's settings directly (useOrgSettings). A
// member who is in the project but not in its org cannot read those (the org
// settings route answers 403), so the browser fell back to built-in defaults:
// the wrong visibility floors, the wrong assignment authority, and repetition
// copying switched ON in a project whose org had turned it off — after which
// the browser wrote the copies. The project's settings response now carries
// the org's values (`orgPolicy`) and the floors the project enforces
// (`visibilityFloors`, its own stricter values included).
//
// Project-scoped surfaces ALWAYS prefer those carried values, for every
// member, not only when the org read is refused: they are resolved by the
// server for this exact project (its own org, never whichever org happens to
// be active in the switcher), they include the project's stricter floors, and
// the settings response is the one an open editor re-reads on a remote change
// and on focus. The org read is only the fallback for a server that predates
// the fields.

import { ROLE } from "@/lib/frontier/roles"

/** The org values carried on the project's settings response. */
export interface ProjectOrgPolicy {
  /** The org's floors, defaults applied. */
  rosterViewMinRole: number
  memberProgressViewMinRole: number
  allowSelfAssignment: boolean
  allowScopedLaneAssignment: boolean
  assignmentMinRole: number
  autoPropagateRepetitions: boolean
  /** Null when the org set none: no client export gate. */
  exportMinRole: number | null
}

/** One visibility floor: the org's, the project's own (null = follows the org), and the one enforced. */
export interface VisibilityFloorView {
  org: number
  project: number | null
  effective: number
}

export interface ProjectVisibilityFloors {
  rosterViewMinRole: VisibilityFloorView
  memberProgressViewMinRole: VisibilityFloorView
}

/** What the fallback needs from useOrgSettings. */
export interface OrgSettingsFallback {
  hasFetched: boolean
  /** Null when the org's settings were never read (refused, or not yet). */
  version: number | null
  rosterViewMinRole: number
  memberProgressViewMinRole: number
  allowSelfAssignment: boolean
  allowScopedLaneAssignment: boolean
  assignmentMinRole: number
  autoPropagateRepetitions: boolean
  exportMinRole: number | null
  canExport: boolean
}

export interface ResolvedProjectPolicy {
  /** True once the floors below are known — before it, gates render nothing. */
  ready: boolean
  /** True when the values came from the project's own settings response. */
  carried: boolean
  rosterViewMinRole: VisibilityFloorView
  memberProgressViewMinRole: VisibilityFloorView
  allowSelfAssignment: boolean
  allowScopedLaneAssignment: boolean
  assignmentMinRole: number
  /** The ORG's repetition default; the project's own setting is applied by the caller. */
  autoPropagateRepetitions: boolean
  exportMinRole: number | null
  /** Whether the caller's project role meets the export floor (see useOrgSettings.canExport). */
  canExport: boolean
}

const LADDER: readonly number[] = Object.values(ROLE)

/** A project's own floor where stricter than the org's — the server's reading. */
function stricter(org: number, raw: unknown): number | null {
  return typeof raw === "number" && LADDER.includes(raw) && raw > org ? raw : null
}

function floorView(org: number, raw: unknown): VisibilityFloorView {
  const project = stricter(org, raw)
  return { org, project, effective: project ?? org }
}

export function resolveProjectPolicy(input: {
  orgPolicy: ProjectOrgPolicy | null | undefined
  visibilityFloors: ProjectVisibilityFloors | null | undefined
  /** The project's own settings (for the fallback's floors). */
  projectSettings: { rosterViewMinRole?: unknown; memberProgressViewMinRole?: unknown } | null | undefined
  org: OrgSettingsFallback
  /** The caller's project-resolved role. */
  roleLevel: number | null | undefined
  /**
   * Whether the project's settings response has arrived. Surfaces that gate
   * on the floors pass it for a synced project: the project's own stricter
   * value comes only with that response, so treating the org's floor alone as
   * known would show a Members or Team frame to a maintainer for a moment
   * before an Owners-only project hides it. Omitted, nothing waits on it.
   */
  projectSettingsFetched?: boolean
}): ResolvedProjectPolicy {
  const { orgPolicy, visibilityFloors, projectSettings, org, roleLevel } = input
  const projectSettingsFetched = input.projectSettingsFetched ?? true
  if (orgPolicy && visibilityFloors) {
    const exportMinRole = orgPolicy.exportMinRole
    return {
      ready: true,
      carried: true,
      rosterViewMinRole: visibilityFloors.rosterViewMinRole,
      memberProgressViewMinRole: visibilityFloors.memberProgressViewMinRole,
      allowSelfAssignment: orgPolicy.allowSelfAssignment,
      allowScopedLaneAssignment: orgPolicy.allowScopedLaneAssignment,
      assignmentMinRole: orgPolicy.assignmentMinRole,
      autoPropagateRepetitions: orgPolicy.autoPropagateRepetitions,
      exportMinRole,
      canExport: exportMinRole == null || roleLevel == null || roleLevel >= exportMinRole,
    }
  }
  return {
    ready: org.hasFetched && projectSettingsFetched,
    carried: false,
    rosterViewMinRole: floorView(org.rosterViewMinRole, projectSettings?.rosterViewMinRole),
    memberProgressViewMinRole: floorView(
      org.memberProgressViewMinRole, projectSettings?.memberProgressViewMinRole,
    ),
    allowSelfAssignment: org.allowSelfAssignment,
    allowScopedLaneAssignment: org.allowScopedLaneAssignment,
    assignmentMinRole: org.assignmentMinRole,
    // Fail safe: without a real org answer (refused, or not read yet) repetition
    // copying stays OFF. The built-in default is ON, and reading a refusal as
    // that default is how a project-only member's browser wrote copies the
    // org had turned off.
    autoPropagateRepetitions: org.version != null ? org.autoPropagateRepetitions : false,
    exportMinRole: org.exportMinRole,
    canExport: org.canExport,
  }
}

/**
 * AQU-1391 / AQU-1771: does validating a cell copy its translation into the
 * file's repetitions? The project's own answer, else its org's (from
 * `resolveProjectPolicy`, which is OFF until the org's answer is known). The
 * workspace writes the copies itself, so OFF here is the whole guard.
 */
export function effectiveRepetitionPropagation(
  projectOwn: boolean | null | undefined,
  policy: Pick<ResolvedProjectPolicy, "autoPropagateRepetitions">,
): boolean {
  return projectOwn ?? policy.autoPropagateRepetitions
}
