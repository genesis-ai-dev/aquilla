import { describe, it, expect } from "vitest"
import { deriveNavIcon, navIconForLabel, NAV_PAGE_ICONS } from "./page-icons"

describe("navIconForLabel", () => {
  it("maps sidebar page labels", () => {
    expect(navIconForLabel("Overview")).toBe(NAV_PAGE_ICONS.overview)
    expect(navIconForLabel("Projects")).toBe(NAV_PAGE_ICONS.projects)
    expect(navIconForLabel("Teams")).toBe(NAV_PAGE_ICONS.teams)
    expect(navIconForLabel("Assigned to me")).toBe(NAV_PAGE_ICONS.assigned)
    expect(navIconForLabel("Members")).toBe(NAV_PAGE_ICONS.members)
    expect(navIconForLabel("Archived")).toBe(NAV_PAGE_ICONS.archived)
    expect(navIconForLabel("Recently deleted")).toBe(NAV_PAGE_ICONS.file)
    expect(navIconForLabel("Settings")).toBe(NAV_PAGE_ICONS.settings)
    expect(navIconForLabel("Admin")).toBe(NAV_PAGE_ICONS.admin)
    expect(navIconForLabel("Shared with you")).toBe(NAV_PAGE_ICONS.shared)
  })
})

describe("deriveNavIcon", () => {
  it("mirrors org-shell routes used by the sidebar", () => {
    expect(deriveNavIcon("/orgs/all")).toBe(NAV_PAGE_ICONS.overview)
    expect(deriveNavIcon("/orgs/7")).toBe(NAV_PAGE_ICONS.projects)
    expect(deriveNavIcon("/orgs/7/overview")).toBe(NAV_PAGE_ICONS.overview)
    expect(deriveNavIcon("/orgs/7/teams")).toBe(NAV_PAGE_ICONS.teams)
    expect(deriveNavIcon("/orgs/7/assigned")).toBe(NAV_PAGE_ICONS.assigned)
    expect(deriveNavIcon("/orgs/7/members")).toBe(NAV_PAGE_ICONS.members)
    expect(deriveNavIcon("/orgs/7/archived")).toBe(NAV_PAGE_ICONS.archived)
    expect(deriveNavIcon("/orgs/7/archived/files")).toBe(NAV_PAGE_ICONS.archived)
    expect(deriveNavIcon("/orgs/7/settings")).toBe(NAV_PAGE_ICONS.settings)
    expect(deriveNavIcon("/admin")).toBe(NAV_PAGE_ICONS.admin)
    expect(deriveNavIcon("/shared")).toBe(NAV_PAGE_ICONS.shared)
  })

  it("maps project workspace surfaces", () => {
    expect(deriveNavIcon("/project/abc/editor")).toBe(navIconForLabel("Editor"))
    expect(deriveNavIcon("/project/abc/settings")).toBe(NAV_PAGE_ICONS.settings)
    expect(deriveNavIcon("/project/abc/settings/rules")).toBe(navIconForLabel("Checks & rules"))
    expect(deriveNavIcon("/project/abc/settings/memory")).toBe(navIconForLabel("Project memory"))
    expect(deriveNavIcon("/project/abc/comments")).toBe(navIconForLabel("Comments"))
    expect(deriveNavIcon("/project/abc/terminology")).toBe(navIconForLabel("Terminology"))
    expect(deriveNavIcon("/project/abc/memory")).toBe(navIconForLabel("Project memory"))
  })
})
