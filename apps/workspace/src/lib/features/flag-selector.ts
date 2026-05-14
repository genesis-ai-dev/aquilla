import type { ProjectRecord } from "@/lib/parsers/types"
import { flagDefault, type FlagKey } from "./flags"

/**
 * Resolve a flag's effective value for a project. Returns the stored boolean
 * if present, else the registry default. Non-boolean stored values (should
 * be impossible through the typed API but can occur with legacy data) are
 * treated as absent.
 */
export function getFlagValue(project: ProjectRecord | null, key: FlagKey): boolean {
  if (!project) return flagDefault(key)
  const stored = project.experimentalFlags?.[key]
  return typeof stored === "boolean" ? stored : flagDefault(key)
}
