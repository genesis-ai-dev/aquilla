// schema-card.ts — the SFL "situation bounds meaning" property (design §2):
// an event kind a role cannot emit must be ABSENT from that role's prompt,
// not merely rejected later. These tests pin the role-filtered event card
// and the mirror of sync-worker/src/events/role-policy.ts — if the source
// table changes, the mirror (and these pins) must change with it.

import { describe, it, expect } from "vitest"
import {
  buildSystemPrompt,
  allowedKindsForRole,
  AGENT_REQUIRED_ROLE,
  AGENT_ROLE,
} from "../lib/agent/schema-card"

const baseCtx = { projectId: "p1", username: "tester" }

describe("buildSystemPrompt — role filtering", () => {
  it("REVIEWER (300): contains cell.validate but NOT target.cell.commit", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: AGENT_ROLE.REVIEWER })
    expect(prompt).toContain("cell.validate")
    expect(prompt).not.toContain("target.cell.commit")
    expect(prompt).not.toContain("target.cell.create")
    // Commenting is below reviewer, so it stays available.
    expect(prompt).toContain("comment.create")
  })

  it("CONTRIBUTOR (400): contains target.cell.commit but no source.* or assignment.*", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: AGENT_ROLE.CONTRIBUTOR })
    expect(prompt).toContain("target.cell.commit")
    expect(prompt).not.toContain("source.cell.create")
    expect(prompt).not.toContain("source.cell.commit")
    expect(prompt).not.toContain("assignment.create")
    expect(prompt).not.toContain("file.delete")
  })

  it("VIEWER (100): read-only — no emit-able kinds, explicit do-not-emit line", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: AGENT_ROLE.VIEWER })
    expect(prompt).toContain("read-only")
    expect(prompt).not.toContain("comment.create {")
    expect(allowedKindsForRole(AGENT_ROLE.VIEWER)).toEqual([])
  })

  it("PROJECT_LEAD (500): assignments and source-side appear", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: AGENT_ROLE.PROJECT_LEAD })
    expect(prompt).toContain("assignment.create")
    expect(prompt).toContain("source.cell.commit")
  })

  it("documents the dynamic variables, including focus vars only when bound", () => {
    const unfocused = buildSystemPrompt({ ...baseCtx, roleLevel: 400 })
    expect(unfocused).toContain(":project")
    expect(unfocused).toContain(":user")
    expect(unfocused).not.toContain(":file = the focused")

    const focused = buildSystemPrompt({ ...baseCtx, roleLevel: 400, fileId: "f1", cellId: "c1" })
    expect(focused).toContain(":file = the focused")
    expect(focused).toContain(":cell = the focused")
  })

  it("stays within the L1 budget (≤250 lines of prompt text)", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: AGENT_ROLE.OWNER })
    expect(prompt.split("\n").length).toBeLessThanOrEqual(250)
  })
})

describe("AGENT_REQUIRED_ROLE — mirror of sync-worker role-policy.ts", () => {
  it("pins the floors the agent's safety depends on", () => {
    expect(AGENT_REQUIRED_ROLE["target.cell.commit"]).toBe(400)
    expect(AGENT_REQUIRED_ROLE["cell.validate"]).toBe(300)
    expect(AGENT_REQUIRED_ROLE["comment.create"]).toBe(200)
    expect(AGENT_REQUIRED_ROLE["source.cell.commit"]).toBe(500)
    expect(AGENT_REQUIRED_ROLE["assignment.create"]).toBe(500)
    expect(AGENT_REQUIRED_ROLE["file.delete"]).toBe(500)
  })

  it("covers all 28 event kinds from sync-worker/src/events/types.ts", () => {
    expect(Object.keys(AGENT_REQUIRED_ROLE)).toHaveLength(28)
  })
})
