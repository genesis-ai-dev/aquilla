import { beforeEach, describe, expect, it } from "vitest"
import {
  AGENT_WORKBENCH_LAYOUTS,
  agentWorkbenchLayoutKey,
  matchingAgentWorkbenchPreset,
  readAgentWorkbenchLayout,
  writeAgentWorkbenchLayout,
} from "./workbench-layout"

describe("agent workbench layout persistence", () => {
  beforeEach(() => window.localStorage.clear())

  it("defaults to the balanced three-pane layout", () => {
    expect(readAgentWorkbenchLayout("p1")).toEqual(AGENT_WORKBENCH_LAYOUTS.balanced)
  })

  it("round-trips a custom layout per project", () => {
    const layout = { source: 21, luna: 51, target: 28 }
    writeAgentWorkbenchLayout("p1", layout)
    expect(readAgentWorkbenchLayout("p1")).toEqual(layout)
    expect(readAgentWorkbenchLayout("p2")).toEqual(AGENT_WORKBENCH_LAYOUTS.balanced)
  })

  it("ignores malformed stored layouts", () => {
    window.localStorage.setItem(agentWorkbenchLayoutKey("p1"), JSON.stringify({ source: 100 }))
    expect(readAgentWorkbenchLayout("p1")).toEqual(AGENT_WORKBENCH_LAYOUTS.balanced)
  })

  it("recognizes presets but treats a dragged layout as custom", () => {
    expect(matchingAgentWorkbenchPreset({ source: 27.7, luna: 44.4, target: 27.9 })).toBe("balanced")
    expect(matchingAgentWorkbenchPreset({ source: 22, luna: 51, target: 27 })).toBeNull()
  })
})
