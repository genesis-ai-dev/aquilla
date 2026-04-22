import type { ProjectRecord, HealthConfig, DeepPartial } from "@/lib/parsers/types"
import { HEALTH_DEFAULTS } from "./defaults"

export function resolveHealthConfig(project: ProjectRecord | null | undefined): HealthConfig {
  const s = project?.healthSettings
  if (!s || s.followDefaults) return HEALTH_DEFAULTS
  return deepMerge(HEALTH_DEFAULTS, s.overrides ?? {})
}

function deepMerge<T extends object>(base: T, override: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue
    if (
      v !== null && typeof v === "object" && !Array.isArray(v)
      && out[k] !== null && typeof out[k] === "object" && !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k] as object, v as DeepPartial<object>)
    } else {
      out[k] = v
    }
  }
  return out as T
}
