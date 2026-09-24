// Members settings pane — DataTable roster + Add dialog (members / invite tabs).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { MembersSection } from "./MembersSection"
import type { ProjectMember } from "@/lib/frontier/members"

const DEFAULT_MEMBERS: ProjectMember[] = [
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

// AQU-853: the caller's own roster entry now decides what the pane offers, so
// both the roster and the signed-in username are per-test state. The gating
// roster adds a directly-granted contributor ("dave") — the below-floor caller
// the ticket's reproduction is about, and a legal grant target for carol.
const GATING_MEMBERS: ProjectMember[] = [
  ...DEFAULT_MEMBERS,
  {
    userId: 4,
    username: "dave",
    email: "dave@example.com",
    role: { level: 400, name: "contributor", source: "override" },
    secondarySources: [],
  },
]

let mockMembers: ProjectMember[] = DEFAULT_MEMBERS
let mockSessionUsername = "alice"

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
    session: { jwt: "tok", username: mockSessionUsername },
    loading: false,
  }),
}))

vi.mock("@/hooks/useProjectOrgId", () => ({
  useProjectOrgId: () => ({ orgId: 1, isLoading: false, error: null }),
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
    mockMembers = DEFAULT_MEMBERS
    mockSessionUsername = "alice"
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

// AQU-853 — the in-project role control is present (this pane IS the "inside
// the project" surface the ticket asked for), but it used to assume every
// reader was a Maintainer: `callerMaxRole = ROLE.MAINTAINER` was hardcoded, so
// a contributor was offered role grants the server answers 403 to, with no
// explanation. These pin the caller-role derivation and the stated reasons.
describe("MembersSection — caller-role gating (AQU-853)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMembers = GATING_MEMBERS
    mockSessionUsername = "alice"
  })

  const openRowMenu = (username: string) =>
    fireEvent.click(screen.getByRole("button", { name: `Actions for ${username}` }))

  it("offers the role picker to a maintainer, capped at their own level", () => {
    renderSection() // alice is maintainer (600)
    openRowMenu("carol")
    fireEvent.click(screen.getByRole("menuitem", { name: /change role/i }))
    expect(screen.getByRole("menuitem", { name: /maintainer/i })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: /contributor/i })).toBeTruthy()
  })

  it("never offers a role above the caller's own level", () => {
    mockSessionUsername = "carol" // project_lead (500)
    renderSection()
    openRowMenu("dave")
    fireEvent.click(screen.getByRole("menuitem", { name: /change role/i }))
    expect(screen.getByRole("menuitem", { name: /project lead/i })).toBeTruthy()
    expect(screen.queryByRole("menuitem", { name: /maintainer/i })).toBeNull()
  })

  it("tells a below-floor caller which role is required instead of offering a doomed picker", () => {
    mockSessionUsername = "dave" // contributor (400)
    renderSection()
    openRowMenu("carol")
    expect(screen.queryByRole("menuitem", { name: /change role/i })).toBeNull()
    expect(
      screen.getByText(/project lead or higher can change member roles/i),
    ).toBeTruthy()
  })

  it("disables Add a member for a below-floor caller and says why", () => {
    mockSessionUsername = "dave" // contributor (400)
    renderSection()
    const addButton = screen.getByRole("button", { name: /add a member/i })
    expect(addButton).toBeDisabled()
    expect(addButton.getAttribute("title")).toMatch(
      /project lead or higher can change member roles/i,
    )
  })

  it("explains that a member at or above the caller's own role can't be changed", () => {
    mockSessionUsername = "carol" // project_lead (500)
    renderSection()
    openRowMenu("alice") // maintainer (600) — outranks carol
    expect(screen.queryByRole("menuitem", { name: /change role/i })).toBeNull()
    expect(
      screen.getByText(/can't change a member whose role is at or above your own/i),
    ).toBeTruthy()
  })
})
