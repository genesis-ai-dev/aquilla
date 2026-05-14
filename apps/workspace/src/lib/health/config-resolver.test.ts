import { describe, it, expect } from "vitest"
import { resolveHealthConfig } from "./config-resolver"
import { HEALTH_DEFAULTS } from "./defaults"
import type { ProjectRecord } from "@/lib/parsers/types"

function proj(partial: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "p", name: "", sourceLanguage: "", targetLanguage: "",
    createdAt: "", files: [], members: [],
    ...partial,
  }
}

describe("resolveHealthConfig", () => {
  it("returns defaults when healthSettings is absent", () => {
    expect(resolveHealthConfig(proj())).toEqual(HEALTH_DEFAULTS)
  })

  it("returns defaults when followDefaults is true, even with overrides", () => {
    const p = proj({
      healthSettings: {
        followDefaults: true,
        overrides: { caps: { rulePenalty: 99 } },
      },
    })
    expect(resolveHealthConfig(p).caps.rulePenalty).toBe(HEALTH_DEFAULTS.caps.rulePenalty)
  })

  it("applies overrides when followDefaults is false", () => {
    const p = proj({
      healthSettings: {
        followDefaults: false,
        overrides: { caps: { rulePenalty: 50 } },
      },
    })
    expect(resolveHealthConfig(p).caps.rulePenalty).toBe(50)
    expect(resolveHealthConfig(p).caps.validationGap).toBe(HEALTH_DEFAULTS.caps.validationGap)
  })

  it("returns defaults when followDefaults is false but overrides is empty", () => {
    const p = proj({ healthSettings: { followDefaults: false, overrides: {} } })
    expect(resolveHealthConfig(p)).toEqual(HEALTH_DEFAULTS)
  })

  it("deep-merges nested partial overrides without erasing sibling fields", () => {
    const p = proj({
      healthSettings: {
        followDefaults: false,
        overrides: { neighborhoodWeights: { idJaccard: 0.7 } },
      },
    })
    const r = resolveHealthConfig(p)
    expect(r.neighborhoodWeights.idJaccard).toBe(0.7)
    expect(r.neighborhoodWeights.tfidfTokenOverlap).toBe(
      HEALTH_DEFAULTS.neighborhoodWeights.tfidfTokenOverlap,
    )
  })

  it("project.rulePenalties wins over defaults (the RulesPage 'Penalty Configuration' card)", () => {
    const p = proj({ rulePenalties: { major: 25, minor: 8 } })
    const r = resolveHealthConfig(p)
    expect(r.rulePenalties).toEqual({ major: 25, minor: 8 })
    // Other dimensions untouched.
    expect(r.caps.rulePenalty).toBe(HEALTH_DEFAULTS.caps.rulePenalty)
  })

  it("project.rulePenalties wins over healthSettings.overrides.rulePenalties", () => {
    // If both UIs are used, the top-level field (the RulesPage UI) is the
    // authoritative one — it's the surface users actually interact with for
    // rule configuration. The HealthSettingsSection's rulePenalties override
    // becomes effectively dead in that case, which is fine.
    const p = proj({
      rulePenalties: { major: 30, minor: 10 },
      healthSettings: {
        followDefaults: false,
        overrides: { rulePenalties: { major: 99, minor: 99 } },
      },
    })
    expect(resolveHealthConfig(p).rulePenalties).toEqual({ major: 30, minor: 10 })
  })

  it("project.rulePenalties absent → falls back to healthSettings override", () => {
    const p = proj({
      healthSettings: {
        followDefaults: false,
        overrides: { rulePenalties: { major: 22, minor: 7 } },
      },
    })
    expect(resolveHealthConfig(p).rulePenalties).toEqual({ major: 22, minor: 7 })
  })
})
