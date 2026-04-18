import { useMemo } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { getProject, updateProject } from "@/lib/store/project-index"
import { getFlagValue } from "@/lib/features/flag-selector"
import type { FlagKey } from "@/lib/features/flags"

/**
 * Resolve a feature flag's current value for a project. The hook re-evaluates
 * whenever the project identity changes; consumers should already be reading
 * the project via `useProject` and passing it in (same pattern as
 * `useProjectPermissions`).
 */
export function useFeatureFlag(key: FlagKey, project: ProjectRecord | null): boolean {
  return useMemo(() => getFlagValue(project, key), [project, key])
}

/**
 * Persist a flag change to a project. Merges into any existing flags and is
 * a no-op when the project record is missing. Callers should treat this as
 * fire-and-forget; Yjs propagation handles the live update.
 */
export async function setFeatureFlag(
  projectId: string,
  key: FlagKey,
  value: boolean,
): Promise<void> {
  const p = await getProject(projectId)
  if (!p) return
  await updateProject({
    ...p,
    experimentalFlags: { ...(p.experimentalFlags ?? {}), [key]: value },
  })
}
