import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgSwitcher } from "./OrgSwitcher"

// Surfaces the current router location so navigation assertions can read it.
function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname + loc.search}</div>
}

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }),
}))
const listMyOrgs = vi.fn()
const createOrg = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: (...a: unknown[]) => listMyOrgs(...a),
  createOrg: (...a: unknown[]) => createOrg(...a),
}))

const fetchAccessibleProjects = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchAccessibleProjects: (...a: unknown[]) => fetchAccessibleProjects(...a),
}))

beforeEach(() => {
  localStorage.clear()
  listMyOrgs.mockReset()
  createOrg.mockReset()
  fetchAccessibleProjects.mockReset()
  fetchAccessibleProjects.mockResolvedValue([])
})
afterEach(() => vi.restoreAllMocks())

describe("OrgSwitcher", () => {
  it("shows the active org and its role, and switches on select", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Come and See", role: { level: 600, name: "maintainer" } },
      { id: 2, name: "Side Org", role: { level: 700, name: "owner" } },
    ])
    render(<MemoryRouter><OrgProvider><OrgSwitcher /></OrgProvider></MemoryRouter>)
    // Multiple orgs → the switcher defaults to the all-organizations scope.
    await waitFor(() => expect(screen.getByText("All organizations")).toBeInTheDocument())
    // Open the switcher; each org is listed with its role.
    const switcher = screen.getByRole("button", { name: "Organization switcher: All organizations" })
    expect(switcher).toBeInTheDocument()
    await act(async () => { switcher.click() })
    expect(screen.getByText("Come and See")).toBeInTheDocument()
    expect(screen.getByText(/maintainer/i)).toBeInTheDocument()
    // Selecting an org makes it the active scope and persists it.
    await act(async () => { screen.getByRole("menuitem", { name: /side org/i }).click() })
    await waitFor(() => expect(localStorage.getItem("org:active")).toBe("2"))
  })

  it("search filters orgs and keeps Create outside the scroll list", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Come and See", role: { level: 600, name: "maintainer" } },
      { id: 2, name: "Side Org", role: { level: 700, name: "owner" } },
      { id: 3, name: "Zebra Corp", role: { level: 100, name: "viewer" } },
    ])
    render(<MemoryRouter><OrgProvider><OrgSwitcher /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("All organizations")).toBeInTheDocument())

    const trigger = screen.getByRole("button", { name: "Organization switcher: All organizations" })
    await act(async () => {
      trigger.click()
    })

    const search = screen.getByRole("textbox", { name: /find an organization/i })
    expect(search).toBeInTheDocument()
    fireEvent.change(search, { target: { value: "zebra" } })

    expect(screen.getByText("Zebra Corp")).toBeInTheDocument()
    expect(screen.queryByText("Come and See")).not.toBeInTheDocument()
    expect(screen.queryByText("Side Org")).not.toBeInTheDocument()
    // All-orgs scope is a navigation shortcut, not a searchable org — hide while typing.
    expect(screen.queryByRole("menuitem", { name: /all organizations/i })).not.toBeInTheDocument()
    // Create stays pinned below the scrollable org list.
    expect(screen.getByRole("menuitem", { name: /^create$/i })).toBeInTheDocument()

    // Close keeps the query; reopen clears it so the next session starts fresh.
    fireEvent.keyDown(search, { key: "Escape" })
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: /find an organization/i })).not.toBeInTheDocument()
    })
    await act(async () => {
      trigger.click()
    })
    const reopened = await screen.findByRole("textbox", { name: /find an organization/i })
    expect(reopened).toHaveValue("")
    expect(screen.getByText("Come and See")).toBeInTheDocument()
    expect(screen.getByText("Zebra Corp")).toBeInTheDocument()
  })

  it("Escape while focusing the search input closes the popover", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Acme", role: { level: 700, name: "owner" } },
    ])
    render(<MemoryRouter><OrgProvider><OrgSwitcher /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument())

    await act(async () => { screen.getByRole("button", { name: /acme/i }).click() })
    const search = await screen.findByRole("textbox", { name: /find an organization/i })
    expect(screen.getByRole("menuitem", { name: /^create$/i })).toBeInTheDocument()

    fireEvent.keyDown(search, { key: "Escape" })

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: /find an organization/i })).not.toBeInTheDocument()
    })
  })

  it("hovering an org row does not steal focus from the search input", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Acme", role: { level: 700, name: "owner" } },
      { id: 2, name: "Side Org", role: { level: 700, name: "owner" } },
    ])
    render(<MemoryRouter><OrgProvider><OrgSwitcher /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("All organizations")).toBeInTheDocument())

    await act(async () => {
      screen.getByRole("button", { name: "Organization switcher: All organizations" }).click()
    })
    const search = await screen.findByRole("textbox", { name: /find an organization/i })
    await waitFor(() => expect(search).toHaveFocus())

    fireEvent.pointerMove(screen.getByRole("menuitem", { name: /side org/i }))

    expect(search).toHaveFocus()
  })

  it("create org: opens dialog, types name, submits, calls createOrg", async () => {
    listMyOrgs
      .mockResolvedValueOnce([{ id: 1, name: "Acme", role: { level: 700, name: "owner" } }])
      .mockResolvedValue([
        { id: 1, name: "Acme", role: { level: 700, name: "owner" } },
        { id: 99, name: "New Org", role: { level: 700, name: "owner" } },
      ])
    createOrg.mockResolvedValue({ id: 99, name: "New Org", role: { level: 700, name: "owner" } })

    render(<MemoryRouter><OrgProvider><OrgSwitcher /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument())

    // Open the switcher
    await act(async () => { screen.getByRole("button", { name: /acme/i }).click() })

    // Click Create in the menu
    const createItem = await screen.findByRole("menuitem", { name: /^create$/i })
    await act(async () => { createItem.click() })

    // Dialog opens with name field
    const input = await screen.findByLabelText(/organization name/i)
    fireEvent.change(input, { target: { value: "New Org" } })

    // Submit
    await act(async () => { screen.getByRole("button", { name: /create organization/i }).click() })

    await waitFor(() => expect(createOrg).toHaveBeenCalledWith("jwt", "New Org"))
  })

  it("member-only user sees no guest section", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Acme", role: { level: 700, name: "owner" } },
    ])
    // Accessible projects are all in orgs the caller is already a member of.
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p1", name: "Proj 1", orgId: 1, role: { level: 100, name: "viewer", source: "org" } },
    ])

    render(<MemoryRouter><OrgProvider><OrgSwitcher /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument())

    await act(async () => { screen.getByRole("button", { name: /acme/i }).click() })

    expect(screen.queryByTestId("guest-orgs")).not.toBeInTheDocument()
    expect(screen.queryByText("guest")).not.toBeInTheDocument()
  })

  it("guest entry visible with Guest tag below member orgs", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Acme", role: { level: 700, name: "owner" } },
    ])
    // A project in an org (id 2) the caller is not a member of.
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p1", name: "Proj 1", orgId: 1, role: { level: 100, name: "viewer", source: "org" } },
      { id: "p2", name: "Proj 2", orgId: 2, orgName: "Guest Org", role: { level: 100, name: "viewer", source: "override" } },
    ])

    render(<MemoryRouter><OrgProvider><OrgSwitcher /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument())

    await act(async () => { screen.getByRole("button", { name: /acme/i }).click() })

    await waitFor(() => expect(screen.getByTestId("guest-orgs")).toBeInTheDocument())
    expect(screen.getByText("Guest Org")).toBeInTheDocument()
    expect(screen.getByText("guest")).toBeInTheDocument()
  })

  // AQU-624: clicking a guest org must actually switch — navigate to that org's
  // scoped shared-projects overview and reflect the selection (checkmark +
  // trigger label), instead of silently doing nothing.
  it("guest org: click navigates to its scoped /shared overview and marks it selected", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Acme", role: { level: 700, name: "owner" } },
    ])
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p1", name: "Proj 1", orgId: 1, role: { level: 100, name: "viewer", source: "org" } },
      { id: "p2", name: "Proj 2", orgId: 2, orgName: "Guest Org", role: { level: 100, name: "viewer", source: "override" } },
    ])

    render(<MemoryRouter><OrgProvider><OrgSwitcher /><LocationProbe /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument())

    await act(async () => { screen.getByRole("button", { name: /acme/i }).click() })
    await waitFor(() => expect(screen.getByTestId("guest-orgs")).toBeInTheDocument())
    await act(async () => { screen.getByRole("menuitem", { name: /guest org/i }).click() })

    // Lands on the guest org's scoped shared view…
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/shared?org=2"))
    // …and the trigger now names the guest org as the current scope.
    expect(screen.getByRole("button", { name: /guest org/i })).toBeInTheDocument()

    // Reopening shows the checkmark on the guest row and no member/all-orgs check.
    await act(async () => { screen.getByRole("button", { name: /guest org/i }).click() })
    const guestSection = screen.getByTestId("guest-orgs")
    expect(guestSection.querySelector(".lucide-check")).not.toBeNull()
  })

  // AQU-624: returning to a member org from a guest's scoped view is symmetric —
  // it navigates to that member org's overview.
  it("guest org → member org: selecting a member org navigates back to its overview", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Acme", role: { level: 700, name: "owner" } },
    ])
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p2", name: "Proj 2", orgId: 2, orgName: "Guest Org", role: { level: 100, name: "viewer", source: "override" } },
    ])

    render(
      <MemoryRouter initialEntries={["/shared?org=2"]}>
        <OrgProvider><OrgSwitcher /><LocationProbe /></OrgProvider>
      </MemoryRouter>,
    )
    // On the guest-scoped route the trigger already reflects the guest org.
    await waitFor(() => expect(screen.getByRole("button", { name: /guest org/i })).toBeInTheDocument())

    await act(async () => { screen.getByRole("button", { name: /guest org/i }).click() })
    await act(async () => { screen.getByRole("menuitem", { name: /acme/i }).click() })

    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/?org=1"))
  })
})
