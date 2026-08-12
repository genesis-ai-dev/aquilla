import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useLocation } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgSwitcher } from "./OrgSwitcher"

// Surfaces the current router location so navigation assertions can read it.
function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname + loc.search}</div>
}

async function openOrgSwitcher(name: string | RegExp) {
  const trigger = screen.getByRole("button", { name })
  await userEvent.click(trigger)
  await screen.findByRole("textbox", { name: /find an organization/i })
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
    await openOrgSwitcher("Organization switcher: All organizations")
    expect(screen.getByText("Come and See")).toBeInTheDocument()
    expect(screen.getByText(/maintainer/i)).toBeInTheDocument()
    // Selecting an org makes it the active scope and persists it.
    fireEvent.click(screen.getByRole("menuitem", { name: /side org/i }))
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

    await openOrgSwitcher("Organization switcher: All organizations")

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
    await openOrgSwitcher("Organization switcher: All organizations")
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

    await openOrgSwitcher(/acme/i)
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

    await openOrgSwitcher("Organization switcher: All organizations")
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
    await openOrgSwitcher(/acme/i)

    // Click Create in the menu
    const createItem = await screen.findByRole("menuitem", { name: /^create$/i })
    fireEvent.click(createItem)

    // Dialog opens with name field
    const input = await screen.findByLabelText(/organization name/i)
    fireEvent.change(input, { target: { value: "New Org" } })

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /create organization/i }))

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

    await openOrgSwitcher(/acme/i)

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

    await openOrgSwitcher(/acme/i)

    await waitFor(() => expect(screen.getByTestId("guest-orgs")).toBeInTheDocument())
    expect(screen.getByText("Guest Org")).toBeInTheDocument()
    expect(screen.getByText("guest")).toBeInTheDocument()
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

    await openOrgSwitcher(/acme/i)
    await waitFor(() => expect(screen.getByTestId("guest-orgs")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("menuitem", { name: /guest org/i }))

    // Lands on the guest org's path overview — same shape as an owned org…
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/orgs/2"))
    // …and the trigger now names the guest org as the current scope.
    expect(screen.getByRole("button", { name: /guest org/i })).toBeInTheDocument()

    // Reopening shows the checkmark on the guest row and no member/all-orgs check.
    await openOrgSwitcher(/guest org/i)
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
    await screen.findByRole("button", { name: /organization switcher/i })
    await openOrgSwitcher(/organization switcher/i)

    const search = await screen.findByLabelText(/find an organization/i)

    // Rendered alphabetically even though the API returned them out of order.
    const names = screen.getAllByRole("menuitem").map((n) => n.textContent ?? "")
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
    await screen.findByRole("button", { name: /organization switcher/i })
    await openOrgSwitcher(/organization switcher/i)

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
    await waitFor(() => expect(screen.getByRole("button", { name: /guest org/i })).toBeInTheDocument())

    await openOrgSwitcher(/guest org/i)
    const acmeItem = await screen.findByRole("menuitem", { name: /acme/i })
    fireEvent.click(acmeItem)

    // Org scope is path-based for both, so the overview is `/orgs/1`.
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/orgs/1"))
  })

  // AQU-882: a failed org load leaves no activeOrg, no all-orgs scope and no
  // guest orgs — exactly the shape that unmounted the switcher entirely, so the
  // user had no in-app affordance to re-issue the fetch.
  describe("organization load failure (AQU-882)", () => {
    it("stays mounted with a retry affordance instead of unmounting", async () => {
      listMyOrgs.mockRejectedValue(new Error("network down"))
      render(<MemoryRouter><OrgProvider><OrgSwitcher /></OrgProvider></MemoryRouter>)

      const retry = await screen.findByTestId("org-switcher-error")
      expect(retry).toHaveAccessibleName("Retry loading organizations")
      expect(screen.getByText(/couldn’t load organizations/i)).toBeInTheDocument()
    })

    it("reloads organizations in place when the retry affordance is clicked", async () => {
      listMyOrgs.mockRejectedValueOnce(new Error("network down"))
      render(<MemoryRouter><OrgProvider><OrgSwitcher /></OrgProvider></MemoryRouter>)
      const retry = await screen.findByTestId("org-switcher-error")

      // Backend is reachable again.
      listMyOrgs.mockResolvedValue([
        { id: 1, name: "Come and See", role: { level: 600, name: "maintainer" } },
        { id: 2, name: "Side Org", role: { level: 700, name: "owner" } },
      ])
      fireEvent.click(retry)

      // Same mount: the real switcher replaces the error affordance.
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Organization switcher: All organizations" }),
        ).toBeInTheDocument(),
      )
      expect(screen.queryByTestId("org-switcher-error")).not.toBeInTheDocument()
    })

    it("still hides itself for a successful load with no member or guest orgs", async () => {
      // Negative case: zero orgs is not a failure — the pre-AQU-882 hide
      // behavior must survive for a genuinely empty (successful) load.
      listMyOrgs.mockResolvedValue([])
      const { container } = render(
        <MemoryRouter><OrgProvider><OrgSwitcher /></OrgProvider></MemoryRouter>,
      )
      await waitFor(() => expect(listMyOrgs).toHaveBeenCalled())
      expect(screen.queryByTestId("org-switcher-error")).not.toBeInTheDocument()
      expect(container).toBeEmptyDOMElement()
    })
  })
})
