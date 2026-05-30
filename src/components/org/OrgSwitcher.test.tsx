import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import { OrgProvider } from "@/context/OrgContext"
import { OrgSwitcher } from "./OrgSwitcher"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }),
}))
const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: (...a: unknown[]) => listMyOrgs(...a) }))

beforeEach(() => { localStorage.clear(); listMyOrgs.mockReset() })
afterEach(() => vi.restoreAllMocks())

describe("OrgSwitcher", () => {
  it("shows the active org and its role, and switches on select", async () => {
    listMyOrgs.mockResolvedValue([
      { id: 1, name: "Come and See", role: { level: 600, name: "maintainer" } },
      { id: 2, name: "Side Org", role: { level: 700, name: "owner" } },
    ])
    render(<OrgProvider><OrgSwitcher /></OrgProvider>)
    await waitFor(() => expect(screen.getByText("Come and See")).toBeInTheDocument())
    expect(screen.getByText(/maintainer/i)).toBeInTheDocument()
    await act(async () => { screen.getByRole("button", { name: /come and see/i }).click() })
    await act(async () => { screen.getByText("Side Org").click() })
    await waitFor(() => expect(localStorage.getItem("org:active")).toBe("2"))
  })
})
