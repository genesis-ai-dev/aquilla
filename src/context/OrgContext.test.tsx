import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import { OrgProvider, useActiveOrg } from "./OrgContext"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }),
}))
const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: (...a: unknown[]) => listMyOrgs(...a) }))

function Probe() {
  const { orgs, activeOrg, setActiveOrg } = useActiveOrg()
  return (
    <div>
      <span data-testid="count">{orgs.length}</span>
      <span data-testid="active">{activeOrg?.id ?? "none"}</span>
      <button onClick={() => setActiveOrg(2)}>switch</button>
    </div>
  )
}

beforeEach(() => { localStorage.clear(); listMyOrgs.mockReset() })
afterEach(() => vi.restoreAllMocks())

describe("OrgProvider", () => {
  it("loads orgs and defaults active to the first", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }, { id: 2, name: "B", role: { level: 600, name: "maintainer" } }])
    render(<OrgProvider><Probe /></OrgProvider>)
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"))
    expect(screen.getByTestId("active").textContent).toBe("1")
  })
  it("honors a persisted activeOrgId and re-persists on switch", async () => {
    localStorage.setItem("org:active", "2")
    listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }, { id: 2, name: "B", role: { level: 600, name: "maintainer" } }])
    render(<OrgProvider><Probe /></OrgProvider>)
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("2"))
    await act(async () => { screen.getByText("switch").click() })
    expect(localStorage.getItem("org:active")).toBe("2")
  })
  it("falls back to first org when the persisted id is stale", async () => {
    localStorage.setItem("org:active", "999")
    listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }])
    render(<OrgProvider><Probe /></OrgProvider>)
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("1"))
  })
})
