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
}))

vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => ({
    ...orgContext,
    activeOrg: orgContext.orgs.find((org) => org.id === orgContext.activeOrgId) ?? null,
    guestOrgs: orgContext.guestOrgs,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
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

    renderBreadcrumb(<OrgBreadcrumb section="Projects" />, "/orgs/all")

    expect(screen.queryByRole("link", { name: "All organizations" })).not.toBeInTheDocument()
    expect(screen.getByText("All organizations")).toHaveAttribute("aria-current", "page")
  })

  // AQU-790: viewing a guest org (`/orgs/:guestId`), the guest org is a sibling
  // of "All organizations" — NOT nested under one of the caller's owned orgs.
  it("renders a guest org as its own crumb, not a descendant of an owned org", () => {
    orgContext.activeOrgId = 2
    orgContext.orgs = [{ id: 7, name: "Dev Org" }]
    orgContext.guestOrgs = [{ id: 2, name: "Guest Org" }]

    renderBreadcrumb(<OrgBreadcrumb section="Projects" />, "/orgs/2")

    // The guest org is the current page, directly under All organizations.
    expect(screen.getByRole("link", { name: "All organizations" })).toHaveAttribute("href", "/orgs/all")
    expect(screen.getByText("Guest Org")).toHaveAttribute("aria-current", "page")
    // The caller's owned org never appears as an ancestor of the guest org.
    expect(screen.queryByText("Dev Org")).not.toBeInTheDocument()
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
