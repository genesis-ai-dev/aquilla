import { useMemo } from "react";
import type { ProjectRecord, ProjectPermissions } from "@/lib/parsers/types";

export const defaultLocalPermissions: ProjectPermissions = {
  source: "local",
  canEditContent: true,
  canEditComments: true,
  canResolveComments: true,
  canPush: false,
};

export function resolvePermissions(project: ProjectRecord | null | undefined): ProjectPermissions {
  return project?.permissions ?? defaultLocalPermissions;
}

export function useProjectPermissions(project: ProjectRecord | null | undefined): ProjectPermissions {
  return useMemo(() => resolvePermissions(project), [project]);
}
