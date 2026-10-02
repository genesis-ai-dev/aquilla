import { beforeEach, describe, expect, it } from "vitest"
import { readAgentWorkbenchLayout, writeAgentWorkbenchLayout } from "./workbench-layout"

const projectId = "layout-navigation-test"
const key = `aquilla:agent-workbench-layout:${projectId}`
beforeEach(() => window.localStorage.removeItem(key))

describe("workbench layout compatibility", () => {
  it("does not restore a legacy zero-width chat pane", () => {
    window.localStorage.setItem(key, JSON.stringify({ source: 50, agent: 0, target: 50 }))
    expect(readAgentWorkbenchLayout(projectId)).toEqual({ source: 28, agent: 44, target: 28 })
  })

  it("preserves a usable saved layout rather than overwriting it with zero width", () => {
    const layout = { source: 34, agent: 32, target: 34 }
    writeAgentWorkbenchLayout(projectId, layout)
    writeAgentWorkbenchLayout(projectId, { source: 50, agent: 0, target: 50 })
    expect(readAgentWorkbenchLayout(projectId)).toEqual(layout)
  })
})
