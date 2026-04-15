import type { ProjectPermissions } from "@/lib/parsers/types";
import type { GitlabProject } from "@/lib/frontier/types";

export function bestAccessLevel(project: GitlabProject): number | undefined {
  const pa = project.permissions?.project_access?.access_level;
  const ga = project.permissions?.group_access?.access_level;
  if (pa == null && ga == null) return undefined;
  return Math.max(pa ?? 0, ga ?? 0);
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
