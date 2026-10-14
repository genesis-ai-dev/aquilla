import { describe, it, expect, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useRules } from "./useRules"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

/**
 * Built-in check overrides (enable toggle / severity) MUST be written through
 * the shared settings channel (`patchShared` → project_settings in D1), not
 * only the device-local IDB projection. Under AD-3 the thin client reads the
 * ProjectRecord from the server with synced settings overlaid, so an IDB-only
 * patchProject write is invisible to the read path — the Rules page toggle
 * appears dead (the original bug). These tests encode that contract.
 */

vi.mock("@/lib/store/project-index", () => ({
  patchProject: vi.fn(
    async (_id: string, updater: (p: ProjectRecord) => ProjectRecord) =>
      updater(baseProject()),
  ),
}))

function baseProject(): ProjectRecord {
  return {
    id: "p1",
    name: "P",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00.000Z",
    files: [],
    members: [],
    algorithmicChecks: {
      "empty-target": { enabled: true, severity: "major" },
    },
  }
}

const noop = () => {}

describe("useRules — setBuiltinOverride syncs to shared settings", () => {
  it("pushes the override through patchShared so other devices / the server read path see it", async () => {
    const patchShared = vi.fn(async (_partial: ProjectWideSettings) => ({ kind: "ok" as const }))
    const { result } = renderHook(() =>
      useRules(baseProject(), noop, patchShared),
    )

    await act(async () => {
      await result.current.setBuiltinOverride("double-space", { enabled: false })
    })

    expect(patchShared).toHaveBeenCalledTimes(1)
    const sent = patchShared.mock.calls[0][0]
    expect(sent.algorithmicChecks?.["double-space"]).toEqual({ enabled: false })
  })

  it("merges with existing overrides instead of clobbering them (top-level settings keys replace wholesale)", async () => {
    const patchShared = vi.fn(async (_partial: ProjectWideSettings) => ({ kind: "ok" as const }))
    const { result } = renderHook(() =>
      useRules(baseProject(), noop, patchShared),
    )

    await act(async () => {
      await result.current.setBuiltinOverride("double-space", {
        enabled: true,
        severity: "minor",
      })
    })

    const sent = patchShared.mock.calls[0][0]
    // The pre-existing override must survive: project_settings PATCH replaces
    // the whole `algorithmicChecks` key, so dropping it here would silently
    // re-enable / reset every other check.
    expect(sent.algorithmicChecks?.["empty-target"]).toEqual({
      enabled: true,
      severity: "major",
    })
    expect(sent.algorithmicChecks?.["double-space"]).toEqual({
      enabled: true,
      severity: "minor",
    })
  })
})

/**
 * AQU-1688 / AQU-1685: Rules → Built-in checks lists the Bible data checks only
 * on a device with the Bible data experiment on. The project's own choices
 * (Bible data on, checks enrichment on by default) are shared, so a
 * collaborator who switched the experiment on must not make the rows, their
 * counts or their findings appear for everyone else.
 */
describe("useRules — Bible data checks follow the device's Bible data experiment", () => {
  const scriptureProject = (experimentalFlags?: Record<string, boolean>): ProjectRecord => ({
    ...baseProject(),
    files: [{ id: "f1", name: "JHN.usfm", type: "usfm", createdAt: "", cellCount: 1 }] as ProjectRecord["files"],
    bibleResourcesEnabled: true,
    experimentalFlags,
  })
  const bibleRuleIds = (rules: { id: string }[]) => rules.map((r) => r.id).filter((id) => id.startsWith("builtin:bkp:"))

  it("has no Bible data check rules with the experiment off", () => {
    const { result } = renderHook(() => useRules(scriptureProject(), noop))
    expect(bibleRuleIds(result.current.builtinRules)).toEqual([])
    expect(bibleRuleIds(result.current.rules)).toEqual([])
  })

  it("lists them with the experiment on", () => {
    const { result } = renderHook(() => useRules(scriptureProject({ bibleData: true }), noop))
    expect(bibleRuleIds(result.current.builtinRules)).toContain("builtin:bkp:V1")
  })
})
