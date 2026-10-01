/**
 * agent-mode tests — the autonomy dial's invariants.
 *
 * Three of these encode WHY the shape is what it is, not merely what it does:
 *
 *  - the DEFAULT is all-off. A project that merges v3 without touching a
 *    switch must behave exactly as it did before; if this assertion ever goes
 *    green with `initiative: true`, every existing project silently acquired
 *    an agent that starts work nobody asked for.
 *  - a MALFORMED stored mode reads DOWN, never up. A half-written settings row
 *    or an older server must never be interpreted as more autonomy than was
 *    actually stored.
 *  - presets are derived, never stored. `presetFor` has to recognise a mode
 *    that arrived by moving the individual switches, because that is the only
 *    thing keeping the trigger's label honest.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ProjectSettingsResponse } from "@/lib/sync/project-settings"

vi.mock("@/lib/sync/project-settings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sync/project-settings")>(
    "@/lib/sync/project-settings",
  )
  return {
    ...actual,
    fetchProjectSettingsResult: vi.fn(),
    patchProjectSettings: vi.fn(),
  }
})

const settings = await import("@/lib/sync/project-settings")
const fetchProjectSettingsResult = vi.mocked(settings.fetchProjectSettingsResult)
const patchProjectSettings = vi.mocked(settings.patchProjectSettings)

const {
  AGENT_MODE_PRESETS,
  DEFAULT_AGENT_MODE,
  agentModeDescriptionKey,
  agentModeEquals,
  agentModeNameKey,
  fetchAgentMode,
  normalizeAgentMode,
  patchAgentMode,
  presetFor,
} = await import("./agent-mode")

function settingsResponse(
  agentMode: unknown,
  version = 4,
): ProjectSettingsResponse {
  return {
    version,
    updatedAt: "2026-08-28T12:00:00Z",
    updatedBy: null,
    settings: { agentMode } as ProjectSettingsResponse["settings"],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("the default mode", () => {
  it("is everything off — merging v3 changes no project's behaviour", () => {
    expect(DEFAULT_AGENT_MODE).toEqual({ initiative: false, react: false, scope: "full" })
  })

  it("names itself Manual, not Custom", () => {
    expect(presetFor(DEFAULT_AGENT_MODE)).toBe("off")
    expect(agentModeNameKey(DEFAULT_AGENT_MODE)).toBe("agent.mode.preset.off")
  })
})

describe("presets", () => {
  it("covers the five combinations the design names, each with its own copy", () => {
    expect(AGENT_MODE_PRESETS.map((preset) => preset.id)).toEqual([
      "fullAutopilot",
      "reactOnly",
      "qaOnly",
      "draftOnly",
      "off",
    ])
    for (const preset of AGENT_MODE_PRESETS) {
      expect(preset.nameKey).toMatch(/^agent\.mode\.preset\./)
      expect(preset.descriptionKey).toMatch(/^agent\.mode\.preset\./)
    }
  })

  it("stores the switch combination the spec assigns each preset", () => {
    const byId = Object.fromEntries(AGENT_MODE_PRESETS.map((p) => [p.id, p.mode]))
    expect(byId.fullAutopilot).toEqual({ initiative: true, react: true, scope: "full" })
    expect(byId.reactOnly).toEqual({ initiative: false, react: true, scope: "full" })
    expect(byId.qaOnly).toEqual({ initiative: false, react: true, scope: "qa" })
    expect(byId.draftOnly).toEqual({ initiative: true, react: false, scope: "draft" })
    expect(byId.off).toEqual(DEFAULT_AGENT_MODE)
  })

  it("recognises a preset reached by moving the switches, not only by clicking a chip", () => {
    // Exactly what a user does when they flip React on from Manual.
    const built = { ...DEFAULT_AGENT_MODE, react: true }
    expect(presetFor(built)).toBe("reactOnly")
    expect(agentModeNameKey(built)).toBe("agent.mode.preset.reactOnly")
  })

  it("reports an unnamed combination as custom rather than mislabelling it", () => {
    const unnamed = { initiative: true, react: true, scope: "qa" as const }
    expect(presetFor(unnamed)).toBe("custom")
    expect(agentModeNameKey(unnamed)).toBe("agent.mode.preset.custom")
    expect(agentModeDescriptionKey(unnamed)).toBe("agent.mode.preset.customDescription")
  })

  it("compares all three fields — scope alone distinguishes two presets", () => {
    expect(
      agentModeEquals(
        { initiative: false, react: true, scope: "full" },
        { initiative: false, react: true, scope: "qa" },
      ),
    ).toBe(false)
  })
})

describe("normalizeAgentMode", () => {
  it("reads a well-formed stored mode back verbatim", () => {
    expect(normalizeAgentMode({ initiative: true, react: false, scope: "draft" })).toEqual({
      initiative: true,
      react: false,
      scope: "draft",
    })
  })

  it("never reads garbage as MORE autonomy than was stored", () => {
    // A truthy-but-not-true value, an unknown scope, a missing key, and a
    // non-object row all have to land on the safe side of the dial.
    expect(normalizeAgentMode({ initiative: "yes", react: 1, scope: "everything" })).toEqual(
      DEFAULT_AGENT_MODE,
    )
    expect(normalizeAgentMode({ react: true })).toEqual({
      initiative: false,
      react: true,
      scope: "full",
    })
    expect(normalizeAgentMode(undefined)).toEqual(DEFAULT_AGENT_MODE)
    expect(normalizeAgentMode("full")).toEqual(DEFAULT_AGENT_MODE)
  })
})

describe("fetchAgentMode", () => {
  it("reads the mode and the settings version the patch will need", async () => {
    fetchProjectSettingsResult.mockResolvedValue({
      ok: true,
      value: settingsResponse({ initiative: false, react: true, scope: "qa" }, 7),
    })
    await expect(fetchAgentMode("jwt", "p1")).resolves.toEqual({
      mode: { initiative: false, react: true, scope: "qa" },
      version: 7,
    })
  })

  it("treats a definitive 'no settings row' as the default mode", async () => {
    fetchProjectSettingsResult.mockResolvedValue({ ok: true, value: null })
    await expect(fetchAgentMode("jwt", "p1")).resolves.toEqual({
      mode: DEFAULT_AGENT_MODE,
      version: 0,
    })
  })

  it("reports a failed request as UNKNOWN, never as 'everything is off'", async () => {
    // The distinction is the point: rendering a failed read as all-off would
    // tell a user the agent is idle when it may be running.
    fetchProjectSettingsResult.mockResolvedValue({ ok: false, status: 500, message: "boom" })
    await expect(fetchAgentMode("jwt", "p1")).resolves.toBeNull()
  })
})

describe("patchAgentMode", () => {
  const next = { initiative: true, react: true, scope: "full" as const }

  it("sends only the agentMode key, at the version it read", async () => {
    patchProjectSettings.mockResolvedValue({ kind: "ok", value: settingsResponse(next, 8) })
    const outcome = await patchAgentMode("jwt", "p1", next, 7)
    expect(patchProjectSettings).toHaveBeenCalledWith("jwt", "p1", { agentMode: next }, 7)
    expect(outcome).toEqual({ kind: "ok", state: { mode: next, version: 8 } })
  })

  it("retries once against the version a concurrent write left behind", async () => {
    // The settings row is shared; a collaborator saving an unrelated key
    // between our read and our write is ordinary, not an error to show.
    patchProjectSettings
      .mockResolvedValueOnce({ kind: "conflict", latest: settingsResponse(DEFAULT_AGENT_MODE, 9) })
      .mockResolvedValueOnce({ kind: "ok", value: settingsResponse(next, 10) })
    const outcome = await patchAgentMode("jwt", "p1", next, 7)
    expect(patchProjectSettings).toHaveBeenNthCalledWith(2, "jwt", "p1", { agentMode: next }, 9)
    expect(outcome).toEqual({ kind: "ok", state: { mode: next, version: 10 } })
  })

  it("reports a role refusal distinctly, so the UI can explain instead of retrying", async () => {
    patchProjectSettings.mockResolvedValue({ kind: "forbidden", required: 500, role: 400 })
    await expect(patchAgentMode("jwt", "p1", next, 7)).resolves.toEqual({ kind: "forbidden" })
    expect(patchProjectSettings).toHaveBeenCalledTimes(1)
  })

  it("gives up after a second conflict rather than looping on the row", async () => {
    patchProjectSettings.mockResolvedValue({
      kind: "conflict",
      latest: settingsResponse(DEFAULT_AGENT_MODE, 9),
    })
    const outcome = await patchAgentMode("jwt", "p1", next, 7)
    expect(patchProjectSettings).toHaveBeenCalledTimes(2)
    expect(outcome.kind).toBe("error")
  })
})
