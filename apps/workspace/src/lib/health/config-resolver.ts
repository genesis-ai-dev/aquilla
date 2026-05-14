import type { ProjectRecord, HealthConfig, DeepPartial } from "@/lib/parsers/types"
import { HEALTH_DEFAULTS } from "./defaults"

export function resolveHealthConfig(project: ProjectRecord | null | undefined): HealthConfig {
  const s = project?.healthSettings
  const base: HealthConfig = !s || s.followDefaults
    ? HEALTH_DEFAULTS
    : deepMerge(HEALTH_DEFAULTS, s.overrides ?? {})

  // `project.rulePenalties` is the field the RulesPage's "Penalty
  // Configuration" card writes to. Treat it as the authoritative override
  // for major/minor penalties — without this, edits in that card would
  // only affect the legacy engine and silently bounce off composite.
  if (project?.rulePenalties) {
    return { ...base, rulePenalties: project.rulePenalties }
  }
  return base
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
