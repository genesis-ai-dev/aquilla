// Members settings pane — DataTable roster + Add dialog (members / invite tabs).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { MembersSection } from "./MembersSection"
import type { ProjectMember } from "@/lib/frontier/members"

const mockMembers: ProjectMember[] = [
  {
    userId: 1,
    username: "alice",
    email: "alice@example.com",
    role: { level: 600, name: "maintainer", source: "override" },
    secondarySources: [],
  },
  {
    userId: 2,
    username: "bob",
    email: "bob@example.com",
    role: { level: 400, name: "contributor", source: "org" },
    secondarySources: [],
  },
  {
    userId: 3,
    username: "carol",
    email: "carol@example.com",
    role: { level: 500, name: "reviewer", source: "override" },
    secondarySources: [],
  },
]

const mockAddMany = vi.fn().mockResolvedValue([])
const mockRemove = vi.fn()
const mockAdd = vi.fn()
const mockRefresh = vi.fn()

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({
    members: mockMembers,
    isLoading: false,
    error: null,
    rosterHidden: false,
    refresh: mockRefresh,
    add: mockAdd,
    addMany: mockAddMany,
    remove: mockRemove,
    changeRole: mockAdd,
  }),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "tok", username: "alice" },
    loading: false,
  }),
}))

vi.mock("@/hooks/useProjectOrgId", () => ({
  useProjectOrgId: () => 1,
}))

vi.mock("@/context/OrgContext", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/context/OrgContext")>()
  return {
    ...original,
    useActiveOrgOptional: () => ({ activeOrgId: 1 }),
  }
})

vi.mock("@/lib/frontier/orgs", () => ({
  listOrgMembers: vi.fn().mockResolvedValue([
    { userId: 4, username: "dave", role: { level: 400, name: "contributor" } },
  ]),
}))

vi.mock("@/hooks/useUserSearch", () => ({
  useUserSearch: () => ({
    query: "",
    results: [],
    isLoading: false,
    needsMorePrefix: true,
    lastFetchOk: true,
  }),
}))

vi.mock("@/lib/sync/invites", () => ({
  createServerInvite: vi.fn(),
}))

function renderSection() {
  return render(
    <MemoryRouter>
      <MembersSection projectId="proj-1" />
    </MemoryRouter>,
  )
}

const bodyUsernames = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((tr) => {
      const nameCell = within(tr).getAllByRole("cell")[0]
      return nameCell?.querySelector(".font-medium")?.textContent ?? null
    })

describe("MembersSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders Name / Email / Role columns and member rows without a nested Team members card", () => {
    renderSection()
    const table = screen.getByTestId("settings-members-table")
    expect(within(table).getByRole("button", { name: /^Name$/i })).toBeTruthy()
    expect(within(table).getByRole("button", { name: /^Email$/i })).toBeTruthy()
    expect(within(table).getByRole("button", { name: /^Role$/i })).toBeTruthy()
    expect(screen.getByText("alice@example.com")).toBeTruthy()
    expect(screen.getByText("bob@example.com")).toBeTruthy()
    expect(screen.queryByText("Team members")).toBeNull()
    expect(screen.queryByRole("heading", { name: /invite link/i })).toBeNull()
    // Dense rows match admin people/projects DataTables.
    const cell = table.querySelector('[data-slot="table-cell"]')
    expect(cell?.className).toMatch(/py-1\.5/)
  })

  it("filters by search query", () => {
    renderSection()
    fireEvent.change(screen.getByLabelText(/search by name or email/i), {
      target: { value: "bob@" },
    })
    expect(screen.getByText("bob@example.com")).toBeTruthy()
    expect(screen.queryByText("alice@example.com")).toBeNull()
  })

  it("sorts via DataTable column headers", () => {
    renderSection()
    // Initial sort is name ascending.
    expect(bodyUsernames()).toEqual(["alice", "bob", "carol"])
    expect(screen.getByRole("button", { name: /^Name$/i })).toHaveAttribute(
      "aria-sort",
      "ascending",
    )

    // Email starts unsorted → asc → desc (strings auto asc-first).
    const emailHeader = screen.getByRole("button", { name: /^Email$/i })
    fireEvent.click(emailHeader)
    expect(bodyUsernames()).toEqual(["alice", "bob", "carol"])
    fireEvent.click(emailHeader)
    expect(bodyUsernames()).toEqual(["carol", "bob", "alice"])
  })

  it("opens Add a member dialog with members and invite-link tabs", () => {
    renderSection()
    fireEvent.click(screen.getByRole("button", { name: /add a member/i }))
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.getByRole("heading", { name: /add a member/i })).toBeTruthy()
    expect(screen.getByRole("tab", { name: /add members/i })).toBeTruthy()
    expect(screen.getByRole("tab", { name: /invite link/i })).toBeTruthy()
  })

  it("shows invite-link controls on the Invite link tab", () => {
    renderSection()
    fireEvent.click(screen.getByRole("button", { name: /add a member/i }))
    fireEvent.click(screen.getByRole("tab", { name: /invite link/i }))
    expect(screen.getByRole("button", { name: /create invite link/i })).toBeTruthy()
  })
})
