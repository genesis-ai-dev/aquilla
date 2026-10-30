// Project settings → Members → Add member → invite link (AQU-2259: moved out
// of the unrouted ProjectMembersPage with the tab).
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { InviteLinkTab } from "./InviteLinkTab"

vi.mock("@/hooks/useCurrentTargetLanes", () => ({
  useCurrentTargetLanes: () => ({ lanes: [], ready: true }),
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "test-jwt", username: "alice" } }),
}))
vi.mock("@/lib/sync/invites", () => ({
  createServerInvite: vi.fn().mockResolvedValue({
    token: "test-token-abc123",
    projectId: "proj-1",
    role: 400,
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
  }),
}))

function renderInvite(projectId = "proj-1") {
  return render(
    <MemoryRouter>
      <InviteLinkTab projectId={projectId} />
    </MemoryRouter>,
  )
}

describe("InviteLinkTab", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("shows the invite form", () => {
    renderInvite()
    expect(screen.getAllByText("Create invite link").length).toBeGreaterThan(0)
  })

  it("creates an invite link and shows the URL", async () => {
    const { createServerInvite } = await import("@/lib/sync/invites")
    renderInvite()
    const createButtons = screen.getAllByRole("button", { name: /create invite link/i })
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
})
