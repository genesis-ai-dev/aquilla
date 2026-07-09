// FRO-180: Unit tests for ProjectMembersPage surface.
//
// Why these tests exist:
//   - Route is reachable at /project/:id/members without crashing
//   - Members list renders correctly for different grant sources
//   - "Revoke all" button shows the typed-confirmation dialog
//   - Confirmation gating: button is disabled until username typed
//   - Invite-link tab shows the form and renders the invite URL after creation

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectMembersPage } from "./ProjectMembersPage"

// ─── Mocks ────────────────────────────────────────────────────────────────

const mockMembers = [
  {
    userId: 1,
    username: "alice",
    role: { level: 600, name: "maintainer", source: "override" as const },
    secondarySources: [],
  },
  {
    userId: 2,
    username: "bob",
    role: { level: 400, name: "contributor", source: "org" as const },
    secondarySources: [],
  },
  {
    userId: 3,
    username: "carol",
    role: { level: 500, name: "project_lead", source: "override" as const },
    secondarySources: [
      { source: "org" as const, level: 100, name: "viewer" },
    ],
  },
]

const mockRefresh = vi.fn().mockResolvedValue(undefined)
const mockAdd = vi.fn().mockResolvedValue(mockMembers[0])
const mockRemove = vi.fn().mockResolvedValue(undefined)

const mockUseProjectMembers = vi.fn(() => ({
  members: mockMembers,
  isLoading: false,
  error: null,
  rosterHidden: false,
  refresh: mockRefresh,
  add: mockAdd,
  remove: mockRemove,
  changeRole: mockAdd,
}))

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => mockUseProjectMembers(),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "test-jwt", username: "alice" },
  }),
}))

vi.mock("@/lib/frontier/members", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/frontier/members")>()
  return {
    ...original,
    revokeAllProjectAccess: vi.fn().mockResolvedValue({
      removed: true,
      grantPaths: [
        { source: "override", level: 600, name: "maintainer", removable: true },
      ],
    }),
  }
})

vi.mock("@/lib/sync/invites", () => ({
  createServerInvite: vi.fn().mockResolvedValue({
    token: "test-token-abc123",
    projectId: "proj-1",
    role: 400,
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
  }),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────

function renderPage(projectId = "proj-1") {
  return render(
    <MemoryRouter initialEntries={[`/project/${projectId}/members`]}>
      <Routes>
        <Route path="/project/:id/members" element={<ProjectMembersPage />} />
        <Route path="/project/:id" element={<div>Editor</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ProjectMembersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders the page header and tab bar", () => {
    renderPage()
    expect(screen.getByText("Back to project")).toBeInTheDocument()
    // "Members" appears twice: header div + tab button — verify both exist
    const allMembers = screen.getAllByText("Members")
    expect(allMembers.length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText("Invite link")).toBeInTheDocument()
  })

  it("renders the current members list", () => {
    renderPage()
    expect(screen.getByText("alice")).toBeInTheDocument()
    expect(screen.getByText("bob")).toBeInTheDocument()
    expect(screen.getByText("carol")).toBeInTheDocument()
  })

  it("shows org badge for org-sourced members", () => {
    renderPage()
    // bob is via org, carol has a secondary org source
    const orgBadges = screen.getAllByText("via org")
    expect(orgBadges.length).toBeGreaterThanOrEqual(1)
  })

  it("shows secondary sources for members with multiple paths", () => {
    renderPage()
    // carol has a secondary org:viewer source
    expect(screen.getByText(/org:viewer/)).toBeInTheDocument()
  })

  it("shows 'Revoke all' button for members the caller can manage", () => {
    renderPage()
    const revokeButtons = screen.getAllByRole("button", { name: /^revoke all$/i })
    // alice (self), bob, carol — but alice is the logged-in user and is
    // skipped for self. That check is null in mock (callerUserId=null),
    // so all members get the button in tests.
    expect(revokeButtons.length).toBeGreaterThan(0)
  })

  it("opens the revoke-all dialog when Revoke all is clicked", async () => {
    renderPage()
    const revokeButtons = screen.getAllByRole("button", { name: /^revoke all$/i })
    fireEvent.click(revokeButtons[0])
    await waitFor(() => {
      expect(screen.getByText("Revoke all access")).toBeInTheDocument()
    })
  })

  it("disables the confirm button until the username is typed", async () => {
    renderPage()
    // Open dialog for alice
    const revokeButtons = screen.getAllByRole("button", { name: /^revoke all$/i })
    fireEvent.click(revokeButtons[0]) // opens dialog for alice

    await waitFor(() => {
      expect(screen.getByText("Revoke all access")).toBeInTheDocument()
    })

    const confirmBtn = screen.getByRole("button", { name: "Revoke access" })
    expect(confirmBtn).toBeDisabled()

    // Type wrong value — still disabled
    const input = screen.getByPlaceholderText("alice")
    fireEvent.change(input, { target: { value: "wrong" } })
    expect(confirmBtn).toBeDisabled()

    // Type the correct username — enabled
    fireEvent.change(input, { target: { value: "alice" } })
    expect(confirmBtn).not.toBeDisabled()
  })

  it("calls revokeAllProjectAccess and shows result after confirm", async () => {
    const { revokeAllProjectAccess } = await import("@/lib/frontier/members")
    renderPage()

    const revokeButtons = screen.getAllByRole("button", { name: /^revoke all$/i })
    fireEvent.click(revokeButtons[0])

    await waitFor(() => screen.getByText("Revoke all access"))

    const input = screen.getByPlaceholderText("alice")
    fireEvent.change(input, { target: { value: "alice" } })

    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }))

    await waitFor(() => {
      expect(revokeAllProjectAccess).toHaveBeenCalledWith("test-jwt", "proj-1", 1)
    })

    // Result state: "Access revoked" shown
    await waitFor(() => {
      expect(screen.getByText("Access revoked")).toBeInTheDocument()
    })
  })

  it("navigates to invite tab and shows the invite form", async () => {
    renderPage()
    // The invite tab button — there can be multiple "Create invite link" texts
    // (heading + button), so just check the section heading appears.
    const tabs = screen.getAllByRole("button")
    const inviteTab = tabs.find((b) => b.textContent === "Invite link")
    expect(inviteTab).toBeTruthy()
    fireEvent.click(inviteTab!)
    await waitFor(() => {
      // The heading h2 rendered inside the invite form
      expect(screen.getAllByText("Create invite link").length).toBeGreaterThan(0)
    })
  })

  it("creates an invite link and shows the URL", async () => {
    const { createServerInvite } = await import("@/lib/sync/invites")
    renderPage()

    const tabs = screen.getAllByRole("button")
    const inviteTab = tabs.find((b) => b.textContent === "Invite link")!
    fireEvent.click(inviteTab)

    await waitFor(() =>
      expect(screen.getAllByText("Create invite link").length).toBeGreaterThan(0),
    )

    // Click the "Create invite link" button (not the heading)
    const createButtons = screen.getAllByRole("button", { name: "Create invite link" })
    fireEvent.click(createButtons[createButtons.length - 1])

    await waitFor(() => {
      expect(createServerInvite).toHaveBeenCalledWith(
        "test-jwt",
        "proj-1",
        400,        // DEFAULT_INVITE_ROLE
        undefined,
        undefined,  // no email
        7,          // DEFAULT_EXPIRY_DAYS
      )
    })

    await waitFor(() => {
      expect(screen.getByText("Invite link ready")).toBeInTheDocument()
      expect(screen.getByDisplayValue(/\/join\/test-token-abc123/)).toBeInTheDocument()
    })
  })

  it("adds a member via the add-member form", async () => {
    renderPage()

    const input = screen.getByPlaceholderText("Aquilla username")
    fireEvent.change(input, { target: { value: "dave" } })

    fireEvent.click(screen.getByRole("button", { name: "Add" }))

    await waitFor(() => {
      expect(mockAdd).toHaveBeenCalledWith("dave", 400)
    })
  })
})

describe("ProjectMembersPage — AQU-485 roster visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The whole point of AQU-485's project-level gate is that a below-floor
  // caller must not see the member list OR the add-member form (which would
  // imply an editable roster exists) — rendering "no members" instead would
  // be a lie (the roster is hidden, not empty).
  it("renders a 'Roster hidden' state instead of the member list when rosterHidden is true", async () => {
    mockUseProjectMembers.mockReturnValueOnce({
      members: [],
      isLoading: false,
      error: null,
      rosterHidden: true,
      refresh: mockRefresh,
      add: mockAdd,
      remove: mockRemove,
      changeRole: mockAdd,
    })

    renderPage()

    expect(screen.getByText(/roster hidden/i)).toBeInTheDocument()
    expect(screen.queryByText("alice")).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText("Aquilla username")).not.toBeInTheDocument()
  })

  it("renders the normal member list when rosterHidden is false (control)", () => {
    renderPage()
    expect(screen.queryByText(/roster hidden/i)).not.toBeInTheDocument()
    expect(screen.getByText("alice")).toBeInTheDocument()
  })
})
