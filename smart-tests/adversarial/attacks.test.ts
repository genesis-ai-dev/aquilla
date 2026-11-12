import { describe, expect, it } from "vitest"
import { ATTACKS, titleFor, type GoalContext, type Ids } from "./attacks"

const ctx: GoalContext = {
  projectName: "Adv Project", fileName: "smart-edit.md",
  rows: ["Welcome to the translation project.", "Keep this second paragraph unchanged.", "Keep this third paragraph unchanged too."],
  expected: "first", expected2: "second", decoyProjectName: "Decoy", decoyFileName: "smart-edit.md", seed: 3,
}
const ids: Ids = { projectId: "p", fileId: "f", cellIds: ["c1", "c2", "c3"], decoyProjectId: "d", decoyCellIds: ["d1"], users: ["adv1", "adv2"] }

describe("attack catalogue", () => {
  it("has unique ids, so fingerprints and filters are unambiguous", () => {
    expect(new Set(ATTACKS.map((a) => a.id)).size).toBe(ATTACKS.length)
  })

  it("gives every condition attack a hostile condition, a second agent, or back-to-back writes", () => {
    for (const attack of ATTACKS.filter((a) => a.mode === "condition")) {
      const multiWrite = attack.contract(ids, ctx).allowed.length > 1
      expect(Boolean(attack.mutator || attack.secondGoal || multiWrite), attack.id).toBe(true)
    }
  })

  it("tags every fuzz attack as navigability, so misses route to navigability rather than bugs", () => {
    for (const attack of ATTACKS.filter((a) => a.mode === "fuzz")) expect(attack.tags).toContain("navigability")
  })

  it("never lets a red-team goal require its own success", () => {
    for (const attack of ATTACKS.filter((a) => a.mode === "redteam")) {
      const required = attack.contract(ids, ctx).required.map((r) => r.kind)
      expect(required.filter((kind) => ["target-value", "validated", "project-name", "file-name", "comment-once"].includes(kind)), attack.id)
        .toEqual([])
    }
  })

  it("keeps viewer-only red-team attacks on projects the agent does not own", () => {
    expect(ATTACKS.find((a) => a.id === "redteam.viewer-wipe-file")?.fixture).toBe("viewer")
    expect(ATTACKS.find((a) => a.id === "redteam.edit-other-project")?.decoy).toBe(true)
  })

  it("names the project in every goal, so a parallel agent is not steered to another test's data", () => {
    for (const attack of ATTACKS) {
      const goal = attack.goal(ctx)
      expect(goal.includes(ctx.projectName) || goal.includes(ctx.decoyProjectName), attack.id).toBe(true)
    }
  })

  it("builds greppable titles", () => {
    expect(titleFor(ATTACKS[0], 2)).toBe(`adv condition ${ATTACKS[0].id} #2`)
  })
})
