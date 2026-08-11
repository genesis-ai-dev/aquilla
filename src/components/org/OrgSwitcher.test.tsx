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
    const switcher = screen.getByRole("combobox", { name: "Organization switcher: All organizations" })
    expect(switcher).toBeInTheDocument()
    await act(async () => { switcher.click() })
    expect(screen.getByText("Come and See")).toBeInTheDocument()
    expect(screen.getByText(/maintainer/i)).toBeInTheDocument()
    // Check is in-flow only on the selected row — no reserved empty slot on others.
    const selected = screen.getByRole("option", { name: /all organizations/i })
    expect(selected.querySelector(".lucide-check")).not.toBeNull()
    const unselected = screen.getByRole("option", { name: /come and see/i })
    expect(unselected.querySelector(".lucide-check")).toBeNull()
    // Selecting an org makes it the active scope and persists it.
    await act(async () => { screen.getByRole("option", { name: /side org/i }).click() })
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

    const trigger = screen.getByRole("combobox", { name: "Organization switcher: All organizations" })
    await act(async () => {
      trigger.click()
    })

    const search = screen.getByRole("combobox", { name: /find an organization/i })
    expect(search).toBeInTheDocument()
    // Empty query: no clear (X) control — Base UI would otherwise show it for the selection.
    expect(document.querySelector('[data-slot="combobox-clear"]')).toBeNull()

    fireEvent.change(search, { target: { value: "zebra" } })
    expect(document.querySelector('[data-slot="combobox-clear"]')).not.toBeNull()

    expect(screen.getByText("Zebra Corp")).toBeInTheDocument()
    expect(screen.queryByText("Come and See")).not.toBeInTheDocument()
    expect(screen.queryByText("Side Org")).not.toBeInTheDocument()
    // All-orgs scope is a navigation shortcut, not a searchable org — hide while typing.
    expect(screen.queryByRole("option", { name: /all organizations/i })).not.toBeInTheDocument()
    // Create stays pinned below the scrollable org list.
    expect(screen.getByRole("button", { name: /^create$/i })).toBeInTheDocument()

    // Close keeps the query; reopen clears it so the next session starts fresh.
    fireEvent.keyDown(search, { key: "Escape" })
    await waitFor(() => {
      expect(screen.queryByRole("combobox", { name: /find an organization/i })).not.toBeInTheDocument()
    })
    await act(async () => {
      trigger.click()
    })
    const reopened = await screen.findByRole("combobox", { name: /find an organization/i })
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

    await act(async () => { screen.getByRole("combobox", { name: /acme/i }).click() })
    const search = await screen.findByRole("combobox", { name: /find an organization/i })
    expect(screen.getByRole("button", { name: /^create$/i })).toBeInTheDocument()

    fireEvent.keyDown(search, { key: "Escape" })

    await waitFor(() => {
      expect(screen.queryByRole("combobox", { name: /find an organization/i })).not.toBeInTheDocument()
    })
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
    await act(async () => { screen.getByRole("combobox", { name: /acme/i }).click() })

    // Click Create in the footer (action, not a combobox option)
    const createItem = await screen.findByRole("button", { name: /^create$/i })
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

    await act(async () => { screen.getByRole("combobox", { name: /acme/i }).click() })

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

    await act(async () => { screen.getByRole("combobox", { name: /acme/i }).click() })

    await waitFor(() => expect(screen.getByTestId("guest-orgs")).toBeInTheDocument())
    expect(screen.getByText("Guest Org")).toBeInTheDocument()
    expect(screen.getByText("guest")).toBeInTheDocument()
    // Member block above guests → separator between the two sections.
    expect(screen.getByTestId("guest-orgs-separator")).toBeInTheDocument()
  })

  it("guest-only user: no separator above the guest list", async () => {
    listMyOrgs.mockResolvedValue([])
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p2", name: "Proj 2", orgId: 2, orgName: "Guest Org", role: { level: 100, name: "viewer", source: "override" } },
    ])

    render(<MemoryRouter><OrgProvider><OrgSwitcher /></OrgProvider></MemoryRouter>)
    const trigger = await screen.findByRole("combobox", { name: /organization switcher/i })
    await act(async () => { trigger.click() })

    await waitFor(() => expect(screen.getByTestId("guest-orgs")).toBeInTheDocument())
    expect(screen.getByText("Guest Org")).toBeInTheDocument()
    expect(screen.queryByTestId("guest-orgs-separator")).not.toBeInTheDocument()
  })

  // AQU-790: clicking a guest org switches to it using the SAME path convention
  // as an owned org (`/orgs/<id>`, not the divergent `/shared?org=<id>`), and
  // reflects the selection (checkmark + trigger label).
  it("guest org: click navigates to its /orgs/:id overview and marks it selected", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Acme", role: { level: 700, name: "owner" } },
    ])
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p1", name: "Proj 1", orgId: 1, role: { level: 100, name: "viewer", source: "org" } },
      { id: "p2", name: "Proj 2", orgId: 2, orgName: "Guest Org", role: { level: 100, name: "viewer", source: "override" } },
    ])

    render(<MemoryRouter><OrgProvider><OrgSwitcher /><LocationProbe /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument())

    await act(async () => { screen.getByRole("combobox", { name: /acme/i }).click() })
    await waitFor(() => expect(screen.getByTestId("guest-orgs")).toBeInTheDocument())
    await act(async () => { screen.getByRole("option", { name: /guest org/i }).click() })

    // Lands on the guest org's path overview — same shape as an owned org…
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/orgs/2"))
    // …and the trigger now names the guest org as the current scope.
    expect(screen.getByRole("combobox", { name: /guest org/i })).toBeInTheDocument()

    // Reopening shows the checkmark on the guest row and no member/all-orgs check.
    await act(async () => { screen.getByRole("combobox", { name: /guest org/i }).click() })
    const guestSection = screen.getByTestId("guest-orgs")
    expect(guestSection.querySelector(".lucide-check")).not.toBeNull()
  })

  // AQU-759: the search box filters the list as you type, and the list stays
  // alphabetical regardless of API order.
  it("many orgs: filters as you type, keeps the list alphabetical", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Zulu Org", role: { level: 700, name: "owner" } },
      { id: 2, name: "Alpha Org", role: { level: 700, name: "owner" } },
      { id: 3, name: "Mike Org", role: { level: 700, name: "owner" } },
      { id: 4, name: "Bravo Org", role: { level: 700, name: "owner" } },
      { id: 5, name: "Yankee Org", role: { level: 700, name: "owner" } },
      { id: 6, name: "Charlie Org", role: { level: 700, name: "owner" } },
    ])
    render(<MemoryRouter><OrgProvider><OrgSwitcher /></OrgProvider></MemoryRouter>)
    const trigger = await screen.findByRole("combobox", { name: /organization switcher/i })
    await act(async () => { trigger.click() })

    const search = await screen.findByLabelText(/find an organization/i)

    // Rendered alphabetically even though the API returned them out of order.
    const names = screen.getAllByRole("option").map((n) => n.textContent ?? "")
    const order = ["Alpha Org", "Bravo Org", "Charlie Org", "Mike Org", "Yankee Org", "Zulu Org"].map(
      (n) => names.findIndex((t) => t.includes(n)),
    )
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))

    // Typing filters the list to matching orgs only.
    fireEvent.change(search, { target: { value: "brav" } })
    await waitFor(() => expect(screen.getByText("Bravo Org")).toBeInTheDocument())
    expect(screen.queryByText("Alpha Org")).not.toBeInTheDocument()
    expect(screen.queryByText("Zulu Org")).not.toBeInTheDocument()

    // A query that matches nothing shows an empty state.
    fireEvent.change(search, { target: { value: "zzzzz" } })
    await waitFor(() => expect(screen.getByText(/no organizations found/i)).toBeInTheDocument())
  })

  // AQU-759 (regression guard for AQU-473): filtering also narrows guest orgs
  // while each surviving guest row keeps its "Guest" tag.
  it("search filters guest orgs and preserves the Guest tag", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Alpha Org", role: { level: 700, name: "owner" } },
      { id: 2, name: "Bravo Org", role: { level: 700, name: "owner" } },
      { id: 3, name: "Charlie Org", role: { level: 700, name: "owner" } },
      { id: 4, name: "Delta Org", role: { level: 700, name: "owner" } },
    ])
    fetchAccessibleProjects.mockResolvedValue([
      { id: "pg", name: "P", orgId: 9, orgName: "Golf Guest", role: { level: 100, name: "viewer", source: "override" } },
      { id: "ph", name: "P2", orgId: 8, orgName: "Hotel Guest", role: { level: 100, name: "viewer", source: "override" } },
    ])
    render(<MemoryRouter><OrgProvider><OrgSwitcher /></OrgProvider></MemoryRouter>)
    const trigger = await screen.findByRole("combobox", { name: /organization switcher/i })
    await act(async () => { trigger.click() })

    const search = await screen.findByLabelText(/find an organization/i)
    fireEvent.change(search, { target: { value: "golf" } })

    await waitFor(() => expect(screen.getByText("Golf Guest")).toBeInTheDocument())
    expect(screen.getByText("guest")).toBeInTheDocument()
    expect(screen.queryByText("Hotel Guest")).not.toBeInTheDocument()
    expect(screen.queryByText("Alpha Org")).not.toBeInTheDocument()
  })

  // AQU-790: returning to a member org from a guest org view is symmetric — from
  // the guest org's own path route (`/orgs/<guestId>`) it swaps to the member
  // org's overview, exactly like switching between two owned orgs.
  it("guest org → member org: selecting a member org navigates back to its overview", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Acme", role: { level: 700, name: "owner" } },
    ])
    fetchAccessibleProjects.mockResolvedValue([
      { id: "p2", name: "Proj 2", orgId: 2, orgName: "Guest Org", role: { level: 100, name: "viewer", source: "override" } },
    ])

    render(
      <MemoryRouter initialEntries={["/orgs/2"]}>
        <OrgProvider><OrgSwitcher /><LocationProbe /></OrgProvider>
      </MemoryRouter>,
    )
    // On the guest org's path route the trigger already reflects the guest org.
    await waitFor(() => expect(screen.getByRole("combobox", { name: /guest org/i })).toBeInTheDocument())

    await act(async () => { screen.getByRole("combobox", { name: /guest org/i }).click() })
    await act(async () => { screen.getByRole("option", { name: /acme/i }).click() })

    // Org scope is path-based for both, so the overview is `/orgs/1`.
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/orgs/1"))
  })
})
