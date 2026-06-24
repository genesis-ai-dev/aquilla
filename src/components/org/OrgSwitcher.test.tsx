import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgSwitcher } from "./OrgSwitcher"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }),
}))
const listMyOrgs = vi.fn()
const createOrg = vi.fn()
const renameOrg = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: (...a: unknown[]) => listMyOrgs(...a),
  createOrg: (...a: unknown[]) => createOrg(...a),
  renameOrg: (...a: unknown[]) => renameOrg(...a),
}))

beforeEach(() => { localStorage.clear(); listMyOrgs.mockReset(); createOrg.mockReset(); renameOrg.mockReset() })
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
    await act(async () => { screen.getByRole("button", { name: /all organizations/i }).click() })
    expect(screen.getByText("Come and See")).toBeInTheDocument()
    expect(screen.getByText(/maintainer/i)).toBeInTheDocument()
    // Selecting an org makes it the active scope and persists it.
    await act(async () => { screen.getByText("Side Org").click() })
    await waitFor(() => expect(localStorage.getItem("org:active")).toBe("2"))
  })

  it("create org: opens input, types name, clicks Create, calls createOrg", async () => {
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

    // Click "+ Create org"
    await act(async () => { screen.getByRole("button", { name: /\+ create org/i }).click() })

    // Type a name
    const input = screen.getByRole("textbox", { name: /new org name/i })
    fireEvent.change(input, { target: { value: "New Org" } })

    // Click Create
    await act(async () => { screen.getByRole("button", { name: /^create$/i }).click() })

    await waitFor(() => expect(createOrg).toHaveBeenCalledWith("jwt", "New Org"))
  })

  it("rename org: owner sees Rename, changes name, Save calls renameOrg", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Acme", role: { level: 700, name: "owner" } },
    ])
    renameOrg.mockResolvedValue(undefined)

    render(<MemoryRouter><OrgProvider><OrgSwitcher /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument())

    // Open the switcher
    await act(async () => { screen.getByRole("button", { name: /acme/i }).click() })

    // Click "Rename"
    await act(async () => { screen.getByRole("button", { name: /^rename$/i }).click() })

    // Change the name (input is prefilled with "Acme")
    const input = screen.getByRole("textbox", { name: /rename org/i })
    fireEvent.change(input, { target: { value: "Acme Renamed" } })

    // Click Save
    await act(async () => { screen.getByRole("button", { name: /^save$/i }).click() })

    await waitFor(() => expect(renameOrg).toHaveBeenCalledWith("jwt", 1, "Acme Renamed"))
  })
})
