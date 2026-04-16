import type { ProjectPermissions } from "@/lib/parsers/types";
import type { GitlabProject, FrontierSession } from "@/lib/frontier/types";

// Best access level from the explicit permissions payload. Returns undefined
// if the server didn't include either — common when the listing used
// `?simple=true`, in which case callers should either re-fetch or use the
// owner/namespace fallback via `resolveAccessLevel`.
export function bestAccessLevel(project: GitlabProject): number | undefined {
  const pa = project.permissions?.project_access?.access_level;
  const ga = project.permissions?.group_access?.access_level;
  if (pa == null && ga == null) return undefined;
  return Math.max(pa ?? 0, ga ?? 0);
}

// Access level with an owner-heuristic fallback. If the project is owned by
// the current user (personal namespace or explicit owner), treat it as owner
// (50). Otherwise fall back to bestAccessLevel, then to 0.
export function resolveAccessLevel(
  project: GitlabProject, session: FrontierSession | null
): number | undefined {
  const explicit = bestAccessLevel(project);
  if (explicit !== undefined) return explicit;
  if (session) {
    if (project.owner?.username === session.username) return 50;
    if (project.namespace?.kind === "user" && project.namespace.path === session.username) return 50;
  }
  return undefined;
}

export function mapGitlabAccessLevel(level: number | undefined): ProjectPermissions {
  const lvl = level ?? 0;
  return {
    source: "gitlab",
    canEditContent: lvl >= 30,
    canEditComments: lvl >= 20,
    canResolveComments: lvl >= 30,
    canPush: lvl >= 30,
    accessLevel: level,
  };
}
