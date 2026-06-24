import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider, useActiveOrg } from "./OrgContext"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }),
}))
const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: (...a: unknown[]) => listMyOrgs(...a) }))

function Probe() {
  const { orgs, activeOrg, isAllOrgs, setActiveOrg, setAllOrgs } = useActiveOrg()
  return (
    <div>
      <span data-testid="count">{orgs.length}</span>
      <span data-testid="active">{activeOrg?.id ?? "none"}</span>
      <span data-testid="all">{isAllOrgs ? "yes" : "no"}</span>
      <button onClick={() => setActiveOrg(2)}>switch</button>
      <button onClick={() => setAllOrgs()}>all</button>
    </div>
  )
}

beforeEach(() => { localStorage.clear(); listMyOrgs.mockReset() })
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
})
