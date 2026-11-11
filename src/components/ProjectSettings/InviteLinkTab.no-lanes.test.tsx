// AQU-2358 — an invite link that grants no language lane: the lane boxes are
// there, a one-lane project pre-checks its lane, and creating a link with
// nothing checked warns before it mints anything.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { NO_LANE_SCOPE } from "@/lib/lanes/no-lane-access"
import { InviteLinkTab } from "./InviteLinkTab"

const lanes = vi.hoisted(() => ({
  current: [] as { id: string; label: string }[],
}))

vi.mock("@/hooks/useCurrentTargetLanes", () => ({
  useCurrentTargetLanes: () => ({ lanes: lanes.current, ready: true }),
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

function renderInvite() {
  return render(
    <MemoryRouter>
      <InviteLinkTab projectId="proj-1" />
    </MemoryRouter>,
  )
}

function clickCreate() {
  const buttons = screen.getAllByRole("button", { name: /create invite link/i })
  fireEvent.click(buttons[buttons.length - 1]!)
}

describe("InviteLinkTab — no language lanes (AQU-2358)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lanes.current = [
      { id: "ln-es", label: "Spanish" },
      { id: "ln-fr", label: "French" },
      { id: "ln-sw", label: "Swahili" },
    ]
  })

  it("warns instead of minting a link when no lane is checked", async () => {
    const { createServerInvite } = await import("@/lib/sync/invites")
    renderInvite()
    fireEvent.click(screen.getByRole("radio", { name: /only selected language lanes/i }))
    clickCreate()

    await waitFor(() => expect(screen.getByTestId("no-lanes-confirm")).toBeInTheDocument())
    expect(screen.getByText(/will not be able to see any translation/i)).toBeInTheDocument()
    expect(createServerInvite).not.toHaveBeenCalled()
  })

  it("mints nothing when the lead goes back to choose lanes", async () => {
    const { createServerInvite } = await import("@/lib/sync/invites")
    renderInvite()
    fireEvent.click(screen.getByRole("radio", { name: /only selected language lanes/i }))
    clickCreate()
    await waitFor(() => expect(screen.getByTestId("no-lanes-confirm")).toBeInTheDocument())

    fireEvent.click(screen.getByTestId("no-lanes-confirm-back"))
    expect(createServerInvite).not.toHaveBeenCalled()
  })

  it("mints a link carrying the reserved no-lane scope once confirmed", async () => {
    const { createServerInvite } = await import("@/lib/sync/invites")
    renderInvite()
    fireEvent.click(screen.getByRole("radio", { name: /only selected language lanes/i }))
    clickCreate()
    await waitFor(() => expect(screen.getByTestId("no-lanes-confirm")).toBeInTheDocument())

    fireEvent.click(screen.getByTestId("no-lanes-confirm-proceed"))
    await waitFor(() => {
      expect(createServerInvite).toHaveBeenCalledWith(
        "test-jwt",
        "proj-1",
        400,
        undefined,
        undefined,
        7,
        [NO_LANE_SCOPE],
      )
    })
  })

  it("pre-checks the only lane of a one-lane project and needs no confirmation", async () => {
    lanes.current = [{ id: "ln-es", label: "Spanish" }]
    const { createServerInvite } = await import("@/lib/sync/invites")
    renderInvite()
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Spanish" })).toBeChecked(),
    )

    clickCreate()
    await waitFor(() => {
      expect(createServerInvite).toHaveBeenCalledWith(
        "test-jwt",
        "proj-1",
        400,
        undefined,
        undefined,
        7,
        ["ln-es"],
      )
    })
    expect(screen.queryByTestId("no-lanes-confirm")).toBeNull()
  })

  it("warns when the pre-checked lane of a one-lane project is unchecked", async () => {
    lanes.current = [{ id: "ln-es", label: "Spanish" }]
    const { createServerInvite } = await import("@/lib/sync/invites")
    renderInvite()
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Spanish" })).toBeChecked(),
    )

    fireEvent.click(screen.getByRole("checkbox", { name: "Spanish" }))
    clickCreate()
    await waitFor(() => expect(screen.getByTestId("no-lanes-confirm")).toBeInTheDocument())
    expect(createServerInvite).not.toHaveBeenCalled()
  })
})
