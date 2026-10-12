import { describe, expect, it } from "vitest"
import { planGrantRepair, type GrantRepairLane, type GrantRepairMember } from "./grant-repair"

const lanes: GrantRepairLane[] = [
  { id: "lane-es", name: "Spanish", archived: false },
  { id: "lane-fr", name: "French", archived: false },
  { id: "lane-old", name: "Old French", archived: true },
]

function member(overrides: Partial<GrantRepairMember> = {}): GrantRepairMember {
  return {
    userId: "7",
    roleLevel: 400,
    laneScopes: [],
    grantLaneIds: ["lane-es"],
    ...overrides,
  }
}

describe("planGrantRepair", () => {
  it("gives an unscoped member the one current lane they are missing, at their role", () => {
    const plan = planGrantRepair({ members: [member()], lanes })
    expect(plan.deletions).toEqual([])
    expect(plan.inserts).toEqual([
      {
        userId: "7",
        laneId: "lane-fr",
        laneName: "French",
        level: 400,
        priorGrantCount: 1,
      },
    ])
  })

  it("leaves a member with an explicit lane scope untouched", () => {
    const plan = planGrantRepair({
      members: [member({ laneScopes: ["lane-es"], grantLaneIds: ["lane-es"] })],
      lanes,
    })
    expect(plan.inserts).toEqual([])
    expect(plan.deletions).toEqual([])
    expect(plan.scopedMembersUntouched).toBe(1)
  })

  it("skips an archived lane, a Maintainer, and a role below Viewer", () => {
    const plan = planGrantRepair({
      members: [
        member({ userId: "lead", roleLevel: 600, grantLaneIds: [] }),
        member({ userId: "guest", roleLevel: 50, grantLaneIds: [] }),
        member({ userId: "contributor", roleLevel: 400, grantLaneIds: [] }),
      ],
      lanes,
    })
    expect(plan.skippedArchivedLanes).toBe(1)
    expect(plan.skippedMaintainer).toBe(1)
    expect(plan.skippedBelowViewer).toBe(1)
    expect(plan.inserts.map((row) => row.laneId).sort()).toEqual(["lane-es", "lane-fr"])
    expect(plan.inserts.every((row) => row.userId === "contributor" && row.level === 400)).toBe(true)
    expect(plan.inserts.some((row) => row.laneId === "lane-old")).toBe(false)
  })

  it("inserts nothing on a second run once the planned grants are held", () => {
    const first = planGrantRepair({ members: [member({ grantLaneIds: [] })], lanes })
    expect(first.inserts).toHaveLength(2)
    const second = planGrantRepair({
      members: [member({ grantLaneIds: first.inserts.map((row) => row.laneId) })],
      lanes,
    })
    expect(second.inserts).toEqual([])
    expect(second.alreadyPresent).toBe(2)
    expect(second.deletions).toEqual([])
  })

  it("does not grant a platform operator", () => {
    const plan = planGrantRepair({
      members: [member({ platform: true, grantLaneIds: [] })],
      lanes,
    })
    expect(plan.inserts).toEqual([])
    expect(plan.skippedPlatform).toBe(1)
  })
})
