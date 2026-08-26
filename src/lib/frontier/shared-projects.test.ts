import { describe, it, expect } from "vitest"
import { hasForeignOrgGrants, partitionSharedProjects, toSharedPortfolioRow } from "./shared-projects"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

// AQU-335: a magic-link invite accept grants project_members on a project in
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

// AQU-475: the all-orgs aggregate overview builds its project list from
// getPortfolios(orgs the caller is a MEMBER of) — a project reached purely
// via a project-level grant (zero org memberships, or a grant in an org the
// caller doesn't belong to) never appears there. The "all-orgs" scope must
// classify by org membership alone, with no activeOrgId to compare against.
describe("partitionSharedProjects (all-orgs scope)", () => {
  it("a zero-org user's project grants are entirely 'shared with me'", () => {
    const { inActiveOrg, sharedWithMe } = partitionSharedProjects(
      [proj("guest-project-a", 503), proj("guest-project-b", null)],
      [],
      null,
      "all-orgs",
    )
    expect(inActiveOrg).toEqual([])
    expect(sharedWithMe.map((p) => p.id)).toEqual(["guest-project-a", "guest-project-b"])
  })

  it("a mixed member+guest user splits by org membership, not activeOrgId", () => {
    const { inActiveOrg, sharedWithMe } = partitionSharedProjects(
      [proj("mine-7", 7), proj("mine-9", 9), proj("guest", 503), proj("no-org", null)],
      MY_ORGS,
      null,
      "all-orgs",
    )
    expect(inActiveOrg.map((p) => p.id).sort()).toEqual(["mine-7", "mine-9"])
    expect(sharedWithMe.map((p) => p.id).sort()).toEqual(["guest", "no-org"])
  })

  it("a pure member user (no foreign grants) has an empty shared list", () => {
    const { inActiveOrg, sharedWithMe } = partitionSharedProjects(
      [proj("mine-7", 7), proj("mine-9", 9)],
      MY_ORGS,
      null,
      "all-orgs",
    )
    expect(inActiveOrg.map((p) => p.id).sort()).toEqual(["mine-7", "mine-9"])
    expect(sharedWithMe).toEqual([])
  })
})

describe("hasForeignOrgGrants", () => {
  it("is false when every project sits in a member org", () => {
    expect(hasForeignOrgGrants([proj("mine", 7), proj("other", 9)], MY_ORGS)).toBe(false)
  })

  it("is true for a foreign-org grant or an org-less project", () => {
    expect(hasForeignOrgGrants([proj("mine", 7), proj("guest", 503)], MY_ORGS)).toBe(true)
    expect(hasForeignOrgGrants([proj("no-org", null)], MY_ORGS)).toBe(true)
  })
})

describe("toSharedPortfolioRow", () => {
  it("keeps identity and host-org labels and leaves progress empty", () => {
    const row = toSharedPortfolioRow({
      ...proj("p503", 503),
      name: "Guest Gospel",
      orgName: "Host Org",
      grantedAt: "2026-07-20T00:00:00Z",
      files: [{ id: "f1", name: "John", type: "usfm", cellCount: 40, sourceLanguage: "en", targetLanguage: "fr" }],
    })
    expect(row).toMatchObject({
      id: "p503",
      name: "Guest Gospel",
      orgId: 503,
      orgName: "Host Org",
      origin: "shared",
      grantedAt: "2026-07-20T00:00:00Z",
      sourceLanguage: "en",
      targetLanguage: "fr",
      totalCells: 0,
      filledCells: 0,
    })
  })
})
