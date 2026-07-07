import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider, useActiveOrg } from "./OrgContext"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }),
}))
const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: (...a: unknown[]) => listMyOrgs(...a) }))

const fetchAccessibleProjects = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchAccessibleProjects: (...a: unknown[]) => fetchAccessibleProjects(...a),
}))

function Probe() {
  const { orgs, activeOrg, isAllOrgs, guestOrgs, setActiveOrg, setAllOrgs } = useActiveOrg()
  return (
    <div>
      <span data-testid="count">{orgs.length}</span>
      <span data-testid="active">{activeOrg?.id ?? "none"}</span>
      <span data-testid="all">{isAllOrgs ? "yes" : "no"}</span>
      <span data-testid="guest-count">{guestOrgs.length}</span>
      <span data-testid="guest-names">{guestOrgs.map((g) => g.name ?? `#${g.id}`).join(",")}</span>
      <button onClick={() => setActiveOrg(2)}>switch</button>
      <button onClick={() => setAllOrgs()}>all</button>
    </div>
  )
}

beforeEach(() => {
  localStorage.clear()
  listMyOrgs.mockReset()
  fetchAccessibleProjects.mockReset()
  fetchAccessibleProjects.mockResolvedValue([])
})
afterEach(() => vi.restoreAllMocks())

describe("OrgProvider", () => {
  it("loads multiple orgs and defaults to all organizations", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }, { id: 2, name: "B", role: { level: 600, name: "maintainer" } }])
    render(<MemoryRouter><OrgProvider><Probe /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"))
    expect(screen.getByTestId("active").textContent).toBe("none")
    expect(screen.getByTestId("all").textContent).toBe("yes")
  })
  it("loads one org and defaults active to that org", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }])
    render(<MemoryRouter><OrgProvider><Probe /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"))
    expect(screen.getByTestId("active").textContent).toBe("1")
    expect(screen.getByTestId("all").textContent).toBe("no")
  })
  it("honors a persisted activeOrgId and re-persists on switch", async () => {
    localStorage.setItem("org:active", "2")
    listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }, { id: 2, name: "B", role: { level: 600, name: "maintainer" } }])
    render(<MemoryRouter><OrgProvider><Probe /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("2"))
    await act(async () => { screen.getByText("switch").click() })
    expect(localStorage.getItem("org:active")).toBe("2")
  })
  it("persists all organizations as the active scope", async () => {
    localStorage.setItem("org:active", "2")
    listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }, { id: 2, name: "B", role: { level: 600, name: "maintainer" } }])
    render(<MemoryRouter><OrgProvider><Probe /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("2"))
    await act(async () => { screen.getByText("all").click() })
    expect(localStorage.getItem("org:active")).toBe("all")
    expect(screen.getByTestId("all").textContent).toBe("yes")
  })
  it("falls back to first org when the persisted id is stale", async () => {
    localStorage.setItem("org:active", "999")
    listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }])
    render(<MemoryRouter><OrgProvider><Probe /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("1"))
  })

  describe("guestOrgs (FRO-473)", () => {
    it("is empty when every accessible project's org is a member org", async () => {
      listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }])
      fetchAccessibleProjects.mockResolvedValue([
        { id: "p1", name: "Proj 1", orgId: 1, role: { level: 100, name: "viewer", source: "org" } },
      ])
      render(<MemoryRouter><OrgProvider><Probe /></OrgProvider></MemoryRouter>)
      await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"))
      await waitFor(() => expect(screen.getByTestId("guest-count").textContent).toBe("0"))
    })

    it("classifies accessible-project orgs the caller doesn't belong to as guest orgs", async () => {
      listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }])
      fetchAccessibleProjects.mockResolvedValue([
        { id: "p1", name: "Proj 1", orgId: 1, role: { level: 100, name: "viewer", source: "org" } },
        { id: "p2", name: "Proj 2", orgId: 2, orgName: "Guest Org", role: { level: 100, name: "viewer", source: "override" } },
      ])
      render(<MemoryRouter><OrgProvider><Probe /></OrgProvider></MemoryRouter>)
      await waitFor(() => expect(screen.getByTestId("guest-count").textContent).toBe("1"))
      expect(screen.getByTestId("guest-names").textContent).toBe("Guest Org")
    })

    it("dedupes multiple accessible projects sharing the same guest org", async () => {
      listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }])
      fetchAccessibleProjects.mockResolvedValue([
        { id: "p2", name: "Proj 2", orgId: 2, orgName: "Guest Org", role: { level: 100, name: "viewer", source: "override" } },
        { id: "p3", name: "Proj 3", orgId: 2, orgName: "Guest Org", role: { level: 100, name: "viewer", source: "override" } },
      ])
      render(<MemoryRouter><OrgProvider><Probe /></OrgProvider></MemoryRouter>)
      await waitFor(() => expect(screen.getByTestId("guest-count").textContent).toBe("1"))
    })

    it("never adds a guest org id into the member orgs array", async () => {
      listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }])
      fetchAccessibleProjects.mockResolvedValue([
        { id: "p2", name: "Proj 2", orgId: 2, orgName: "Guest Org", role: { level: 100, name: "viewer", source: "override" } },
      ])
      render(<MemoryRouter><OrgProvider><Probe /></OrgProvider></MemoryRouter>)
      await waitFor(() => expect(screen.getByTestId("guest-count").textContent).toBe("1"))
      expect(screen.getByTestId("count").textContent).toBe("1")
    })
  })
})
