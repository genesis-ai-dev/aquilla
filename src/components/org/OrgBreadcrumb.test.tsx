import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { OrgBreadcrumb } from "./OrgBreadcrumb"

const orgContext = vi.hoisted(() => ({
  activeOrgId: 7 as number | null,
  isAllOrgs: false,
  orgs: [{ id: 7, name: "Dev Org" }],
  guestOrgs: [] as { id: number; name: string | null }[],
  setActiveOrg: vi.fn(),
  setAllOrgs: vi.fn(),
  isLoading: false,
  accessibleProjectsLoading: false,
  // Answers to by-id lookups: absent = not in yet, null = refused.
  lookups: new Map<number, { id: number; name: string | null } | null>(),
  requestOrgLookup: vi.fn(),
}))

vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => ({
    ...orgContext,
    activeOrg: orgContext.orgs.find((org) => org.id === orgContext.activeOrgId) ?? null,
    guestOrgs: orgContext.guestOrgs,
    isLoading: orgContext.isLoading,
    error: null,
    refresh: vi.fn(),
    lookedUpOrg: (id: number) => orgContext.lookups.get(id),
  }),
}))

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

function renderBreadcrumb(ui: React.ReactNode, initialEntry = "/project/project-1/editor") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      {ui}
      <LocationProbe />
    </MemoryRouter>,
  )
}

describe("OrgBreadcrumb", () => {
  beforeEach(() => {
    orgContext.activeOrgId = 7
    orgContext.isAllOrgs = false
    orgContext.orgs = [{ id: 7, name: "Dev Org" }]
    orgContext.guestOrgs = []
    orgContext.isLoading = false
    orgContext.accessibleProjectsLoading = false
    orgContext.lookups.clear()
    orgContext.requestOrgLookup.mockClear()
    orgContext.setActiveOrg.mockClear()
    orgContext.setAllOrgs.mockClear()
  })

  it("renders the organization name as a navigable crumb without a logo", () => {
    renderBreadcrumb(<OrgBreadcrumb section="Teams" />, "/orgs/7/teams")

    const orgCrumb = screen.getByRole("link", { name: "Dev Org" })
    expect(orgCrumb).toHaveAttribute("href", "/orgs/7")
    expect(orgCrumb.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it("shows a complete, navigable hierarchy in the project workspace", () => {
    renderBreadcrumb(
      <OrgBreadcrumb
        orgId={7}
        section="Dev Project"
        sectionTo="/projects/project-1"
        trail={[{ label: "Editor" }]}
      />,
    )

    expect(screen.getByRole("link", { name: "All organizations" })).toHaveAttribute("href", "/orgs/all")
    expect(screen.getByRole("link", { name: "Dev Org" })).toHaveAttribute("href", "/orgs/7")
    expect(screen.getByRole("link", { name: "Dev Project" })).toHaveAttribute("href", "/projects/project-1")
    expect(screen.getByText("Editor")).toHaveAttribute("aria-current", "page")
  })

  it("always navigates All organizations from a project route", () => {
    renderBreadcrumb(<OrgBreadcrumb section="Dev Project" orgId={7} />)

    fireEvent.click(screen.getByRole("link", { name: "All organizations" }))

    expect(orgContext.setAllOrgs).toHaveBeenCalledOnce()
    expect(screen.getByTestId("location")).toHaveTextContent("/orgs/all")
  })

  it("renders the all-organizations landing crumb as the current page", () => {
    orgContext.activeOrgId = null
    orgContext.isAllOrgs = true

    renderBreadcrumb(<OrgBreadcrumb section="Overview" isProjectsLanding />, "/orgs/all")

    expect(screen.queryByRole("link", { name: "All organizations" })).not.toBeInTheDocument()
    expect(screen.getByText("All organizations")).toHaveAttribute("aria-current", "page")
    // Portfolio home omits a redundant Overview section crumb.
    expect(screen.queryByText("Overview")).not.toBeInTheDocument()
  })

  it("shows Projects as the current crumb on the member-org projects page", () => {
    renderBreadcrumb(<OrgBreadcrumb section="Projects" />, "/orgs/7/projects")

    expect(screen.getByRole("link", { name: "All organizations" })).toHaveAttribute("href", "/orgs/all")
    expect(screen.getByRole("link", { name: "Dev Org" })).toHaveAttribute("href", "/orgs/7")
    expect(screen.getByText("Projects")).toHaveAttribute("aria-current", "page")
  })

  // AQU-832: `isProjectsLanding` replaced an implicit `section === "Projects"`
  // string comparison — translating `section` must not silently duplicate a
  // crumb. A section whose ENGLISH TEXT happens to be "Projects" but that
  // isn't flagged as the landing page must still render its own crumb.
  it("does not infer the landing page from the section text — only from isProjectsLanding", () => {
    orgContext.activeOrgId = null
    orgContext.isAllOrgs = true

    renderBreadcrumb(<OrgBreadcrumb section="Projects" />, "/orgs/all")

    expect(screen.getByText("Projects")).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("link", { name: "All organizations" })).toBeInTheDocument()
  })

  // AQU-790: viewing a guest org (`/orgs/:guestId/projects`), the guest org is a
  // sibling of "All organizations" — NOT nested under one of the caller's owned
  // orgs. Same trail shape as a member org's projects page.
  it("holds the org's place with one cursor while its record is still loading", () => {
    orgContext.orgs = []
    orgContext.isLoading = true
    renderBreadcrumb(<OrgBreadcrumb section="Teams" />, "/orgs/7/teams")

    expect(screen.getByTestId("org-breadcrumb-pending")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "All organizations" })).toBeInTheDocument()
    expect(screen.queryByText("Organization")).toBeNull()
  })

  it("renders a guest org as its own crumb, not a descendant of an owned org", () => {
    orgContext.activeOrgId = 2
    orgContext.orgs = [{ id: 7, name: "Dev Org" }]
    orgContext.guestOrgs = [{ id: 2, name: "Guest Org" }]

    renderBreadcrumb(<OrgBreadcrumb section="Projects" />, "/orgs/2/projects")

    expect(screen.getByRole("link", { name: "All organizations" })).toHaveAttribute("href", "/orgs/all")
    expect(screen.getByRole("link", { name: "Guest Org" })).toHaveAttribute("href", "/orgs/2")
    expect(screen.getByText("Projects")).toHaveAttribute("aria-current", "page")
    // The caller's owned org never appears as an ancestor of the guest org.
    expect(screen.queryByText("Dev Org")).not.toBeInTheDocument()
  })

  it("never looks up a membership or a guest org", () => {
    orgContext.guestOrgs = [{ id: 2, name: "Guest Org" }]

    renderBreadcrumb(<OrgBreadcrumb section="Dev Project" orgId={7} />)
    renderBreadcrumb(<OrgBreadcrumb section="Guest Project" orgId={2} />)

    expect(orgContext.requestOrgLookup).not.toHaveBeenCalled()
  })

  // An org a platform admin opens from the switcher catalog is neither a
  // membership nor a guest org. Its crumb used to be skipped, leaving
  // "All organizations › Projects" under a switcher that named the org.
  describe("an org opened as a platform admin", () => {
    beforeEach(() => {
      orgContext.activeOrgId = 9
      orgContext.orgs = [{ id: 7, name: "Dev Org" }]
    })

    it("names the org on its own pages", () => {
      orgContext.lookups.set(9, { id: 9, name: "aaaaa" })

      renderBreadcrumb(<OrgBreadcrumb section="Projects" />, "/orgs/9/projects")

      expect(screen.getByRole("link", { name: "All organizations" })).toHaveAttribute("href", "/orgs/all")
      expect(screen.getByRole("link", { name: "aaaaa" })).toHaveAttribute("href", "/orgs/9")
      expect(screen.getByText("Projects")).toHaveAttribute("aria-current", "page")
      expect(screen.queryByText("Dev Org")).not.toBeInTheDocument()
    })

    it("names a project's org when that org is not the active one", () => {
      // Opening a project resets the active org to one of the caller's own.
      orgContext.activeOrgId = 7
      orgContext.lookups.set(9, { id: 9, name: "aaaaa" })

      renderBreadcrumb(<OrgBreadcrumb section="Their Project" orgId={9} />)

      expect(screen.getByRole("link", { name: "aaaaa" })).toHaveAttribute("href", "/orgs/9")
      expect(screen.queryByText("Dev Org")).not.toBeInTheDocument()
      expect(orgContext.requestOrgLookup).toHaveBeenCalledWith(9)
    })

    it("scopes to the org when its crumb is followed", () => {
      orgContext.activeOrgId = 7
      orgContext.lookups.set(9, { id: 9, name: "aaaaa" })
      renderBreadcrumb(<OrgBreadcrumb section="Their Project" orgId={9} />)

      fireEvent.click(screen.getByRole("link", { name: "aaaaa" }))

      expect(orgContext.setActiveOrg).toHaveBeenCalledWith(9)
      expect(screen.getByTestId("location")).toHaveTextContent("/orgs/9")
    })

    it("is the current page on the org's own landing page", () => {
      orgContext.lookups.set(9, { id: 9, name: "aaaaa" })

      renderBreadcrumb(<OrgBreadcrumb section="Overview" isProjectsLanding />, "/orgs/9/overview")

      expect(screen.getByText("aaaaa")).toHaveAttribute("aria-current", "page")
    })

    it("holds the org's place with one cursor until its lookup answers", () => {
      renderBreadcrumb(<OrgBreadcrumb section="Projects" />, "/orgs/9/projects")

      expect(screen.getAllByTestId("org-breadcrumb-pending")).toHaveLength(1)
      expect(orgContext.requestOrgLookup).toHaveBeenCalledWith(9)
    })

    it("does not ask until the project directory could have listed it as a guest org", () => {
      orgContext.accessibleProjectsLoading = true

      renderBreadcrumb(<OrgBreadcrumb section="Projects" />, "/orgs/9/projects")

      expect(screen.getAllByTestId("org-breadcrumb-pending")).toHaveLength(1)
      expect(orgContext.requestOrgLookup).not.toHaveBeenCalled()
    })

    it("leaves the level out when the lookup is refused", () => {
      orgContext.lookups.set(9, null)

      renderBreadcrumb(<OrgBreadcrumb section="Projects" />, "/orgs/9/projects")

      expect(screen.queryByTestId("org-breadcrumb-pending")).toBeNull()
      expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["All organizations"])
      expect(screen.getByText("Projects")).toHaveAttribute("aria-current", "page")
    })
  })

  it("keeps the breadcrumb on one line and scrolls horizontally instead of clipping", () => {
    const { container } = renderBreadcrumb(
      <OrgBreadcrumb section="A very long project name that still stays on one line" />,
    )

    const list = container.querySelector('[data-slot="breadcrumb-list"]')
    expect(list).toHaveClass(
      "scroll-fade-x",
      "scroll-fade-8",
      "flex-nowrap",
      "overflow-x-auto",
      "overscroll-x-contain",
      "whitespace-nowrap",
      "scrollbar-none",
    )
  })
})
