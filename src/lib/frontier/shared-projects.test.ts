import { describe, it, expect } from "vitest"
import { partitionSharedProjects } from "./shared-projects"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

// FRO-335: a magic-link invite accept grants project_members on a project in
// the INVITER's org. The invitee is not an org member, so org-scoped lists
// hid the project entirely — URL-accessible, dashboard-invisible. These tests
// encode the contract that such projects must surface as "shared with me".

function proj(id: string, orgId: number | null): CloudProjectSummary {
  return {
    id,
    name: id,
    gitlabProjectId: null,
    orgId,
    role: { level: 400, name: "contributor", source: "override" },
  } as CloudProjectSummary
}

const MY_ORGS = [{ id: 7 }, { id: 9 }]

describe("partitionSharedProjects", () => {
  it("puts active-org projects in inActiveOrg and foreign-org projects in sharedWithMe", () => {
    const { inActiveOrg, sharedWithMe } = partitionSharedProjects(
      [proj("mine", 7), proj("joined-via-invite", 503)],
      MY_ORGS,
      7,
    )
    expect(inActiveOrg.map((p) => p.id)).toEqual(["mine"])
    expect(sharedWithMe.map((p) => p.id)).toEqual(["joined-via-invite"])
  })

  it("hides projects from my OTHER orgs (reachable via org switcher, not shared)", () => {
    const { inActiveOrg, sharedWithMe } = partitionSharedProjects(
      [proj("other-org-of-mine", 9)],
      MY_ORGS,
      7,
    )
    expect(inActiveOrg).toEqual([])
    expect(sharedWithMe).toEqual([])
  })

  it("treats org-less projects as shared so they are never unreachable", () => {
    const { sharedWithMe } = partitionSharedProjects([proj("no-org", null)], MY_ORGS, 7)
    expect(sharedWithMe.map((p) => p.id)).toEqual(["no-org"])
  })

  it("shared projects surface regardless of which org is active", () => {
    for (const active of [7, 9, null]) {
      const { sharedWithMe } = partitionSharedProjects(
        [proj("joined-via-invite", 503)],
        MY_ORGS,
        active,
      )
      expect(sharedWithMe.map((p) => p.id)).toEqual(["joined-via-invite"])
    }
  })
})
