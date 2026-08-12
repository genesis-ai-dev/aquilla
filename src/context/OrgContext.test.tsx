import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import { MemoryRouter, useNavigate } from "react-router-dom"
import { OrgProvider, useActiveOrg } from "./OrgContext"

// This vitest/happy-dom env doesn't provide localStorage (the reason this
// suite was red before FRO-367 added the shim). OrgContext reads/writes it
// synchronously, so install a minimal in-memory Storage — the browser always
// has one.
if (typeof globalThis.localStorage === "undefined") {
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => { map.set(k, String(v)) },
      removeItem: (k: string) => { map.delete(k) },
      clear: () => { map.clear() },
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() { return map.size },
    },
  })
}

const sessionState = {
  session: { jwt: "jwt", username: "anna", createdAt: "x" },
  loading: false,
}
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => sessionState,
}))
const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: (...a: unknown[]) => listMyOrgs(...a) }))

const fetchAccessibleProjects = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchAccessibleProjects: (...a: unknown[]) => fetchAccessibleProjects(...a),
}))

function Probe() {
  const { orgs, activeOrg, activeGuestOrg, isAllOrgs, guestOrgs, setActiveOrg, setAllOrgs } = useActiveOrg()
  return (
    <div>
      <span data-testid="count">{orgs.length}</span>
      <span data-testid="active">{activeOrg?.id ?? "none"}</span>
      <span data-testid="guest-active">{activeGuestOrg?.id ?? "none"}</span>
      <span data-testid="all">{isAllOrgs ? "yes" : "no"}</span>
      <span data-testid="guest-count">{guestOrgs.length}</span>
      <span data-testid="guest-names">{guestOrgs.map((g) => g.name ?? `#${g.id}`).join(",")}</span>
      <button onClick={() => setActiveOrg(2)}>switch</button>
      <button onClick={() => setAllOrgs()}>all</button>
    </div>
  )
}

function RouteProbe() {
  const navigate = useNavigate()
  const { isLoading } = useActiveOrg()
  return (
    <div>
      <span data-testid="loading">{isLoading ? "yes" : "no"}</span>
      <button onClick={() => navigate("/orgs/1/settings")}>settings</button>
    </div>
  )
}

beforeEach(() => {
  localStorage.clear()
  sessionState.loading = false
  listMyOrgs.mockReset()
  fetchAccessibleProjects.mockReset()
  fetchAccessibleProjects.mockResolvedValue([])
})
afterEach(() => vi.restoreAllMocks())

describe("OrgProvider", () => {
  it("keeps resolved organization state across client-side route changes", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "A", role: { level: 700, name: "owner" } },
    ])

    render(
      <MemoryRouter initialEntries={["/orgs/1"]}>
        <OrgProvider><RouteProbe /></OrgProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("no"))
    expect(listMyOrgs).toHaveBeenCalledTimes(1)

    await act(async () => { screen.getByText("settings").click() })

    expect(screen.getByTestId("loading").textContent).toBe("no")
    expect(listMyOrgs).toHaveBeenCalledTimes(1)
  })

  it("loads the shared project directory once while organization state resolves", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "A", role: { level: 700, name: "owner" } },
      { id: 2, name: "B", role: { level: 600, name: "maintainer" } },
    ])
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p1", name: "Proj 1", orgId: 1, role: { level: 700, name: "owner", source: "org" } },
    ])

    render(<MemoryRouter><OrgProvider><Probe /></OrgProvider></MemoryRouter>)

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"))
    await waitFor(() => expect(fetchAccessibleProjects).toHaveBeenCalledTimes(1))
  })

  it("reuses an in-flight project directory request across same-account hydration bounces", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "A", role: { level: 700, name: "owner" } },
    ])
    let resolveProjects!: (projects: unknown[]) => void
    fetchAccessibleProjects.mockImplementation(
      () => new Promise((resolve) => { resolveProjects = resolve }),
    )

    const tree = () => <MemoryRouter><OrgProvider><Probe /></OrgProvider></MemoryRouter>
    const view = render(tree())
    await waitFor(() => expect(fetchAccessibleProjects).toHaveBeenCalledTimes(1))

    sessionState.loading = true
    view.rerender(tree())
    sessionState.loading = false
    view.rerender(tree())

    expect(fetchAccessibleProjects).toHaveBeenCalledTimes(1)
    await act(async () => { resolveProjects([]) })
    await waitFor(() => expect(fetchAccessibleProjects).toHaveBeenCalledTimes(1))
  })

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

  describe("guestOrgs (AQU-473)", () => {
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

  // AQU-790: a guest org uses the same path convention as an owned org
  // (`/orgs/:guestId`). The context surfaces it as `activeGuestOrg` (never as a
  // membership `activeOrg`), so chrome can describe the guest org without
  // misrepresenting the caller's role — and a reload keeps them in it.
  describe("activeGuestOrg (AQU-790)", () => {
    it("resolves the guest org named by the path without making it a membership", async () => {
      listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }])
      fetchAccessibleProjects.mockResolvedValue([
        { id: "p2", name: "Proj 2", orgId: 2, orgName: "Guest Org", role: { level: 100, name: "viewer", source: "override" } },
      ])
      render(
        <MemoryRouter initialEntries={["/orgs/2"]}>
          <OrgProvider><Probe /></OrgProvider>
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByTestId("guest-active").textContent).toBe("2"))
      // Not a membership: activeOrg stays null and isAllOrgs is false.
      expect(screen.getByTestId("active").textContent).toBe("none")
      expect(screen.getByTestId("all").textContent).toBe("no")
      // Persisted, so a reload keeps the caller in the guest org.
      expect(localStorage.getItem("org:active")).toBe("2")
    })

    it("stays null when the active path org is a real membership", async () => {
      listMyOrgs.mockResolvedValue([
        { id: 1, name: "A", role: { level: 700, name: "owner" } },
        { id: 2, name: "B", role: { level: 600, name: "maintainer" } },
      ])
      render(
        <MemoryRouter initialEntries={["/orgs/2"]}>
          <OrgProvider><Probe /></OrgProvider>
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("2"))
      expect(screen.getByTestId("guest-active").textContent).toBe("none")
    })
  })

  // A single-org auto-selection is a default, not a user choice — it must NOT
  // be persisted. If it were, a user who later joins a second org would stay
  // silently scoped to their original org instead of getting the all-orgs
  // default (orgs/members.smoke covers the journey end-to-end).
  it("does not persist an auto-selected single org, so joining a second org restores the all-orgs default", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "A", role: { level: 700, name: "owner" } }])
    const first = render(<MemoryRouter><OrgProvider><Probe /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("1"))
    expect(localStorage.getItem("org:active")).not.toBe("1")
    first.unmount()

    // Same client, next load: the user was added to org 2 in the meantime.
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "A", role: { level: 700, name: "owner" } },
      { id: 2, name: "B", role: { level: 400, name: "contributor" } },
    ])
    render(<MemoryRouter><OrgProvider><Probe /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"))
    expect(screen.getByTestId("all").textContent).toBe("yes")
    expect(screen.getByTestId("active").textContent).toBe("none")
  })

  // FRO-367: when a cross-tab account switch leaves a persisted org id the new
  // account can't see, the clamp must ALSO rewrite localStorage — otherwise a
  // reload resurrects the stale id and hits a "no access to org" 403.
  it("re-persists to all-orgs when the persisted id vanishes from a multi-org list", async () => {
    localStorage.setItem("org:active", "2")
    listMyOrgs.mockResolvedValue([
      { id: 3, name: "C", role: { level: 700, name: "owner" } },
      { id: 4, name: "D", role: { level: 600, name: "maintainer" } },
    ])
    render(<MemoryRouter><OrgProvider><Probe /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId("all").textContent).toBe("yes"))
    expect(screen.getByTestId("active").textContent).toBe("none")
    expect(localStorage.getItem("org:active")).toBe("all")
  })
})
