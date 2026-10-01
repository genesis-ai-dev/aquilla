/**
 * AgentModeControl tests — the autonomy dial's presentation contract.
 *
 * What these pin is trust, not layout. An autonomy control that shows one
 * state while the server holds another is worse than no control at all, so:
 *
 *  - the trigger says what the STORED mode is, in the preset's own words;
 *  - a flip lands immediately AND reverts visibly when the write is refused,
 *    with the reason inline — optimism that never un-does itself would leave
 *    the UI claiming autonomy the project does not have;
 *  - a preset chip sets all three fields at once, which is the only reason
 *    presets exist over the raw switches;
 *  - a viewer who cannot write sees the dial and the reason, not a mystery.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { ROLE } from "@/lib/frontier/roles"
import type { AgentMode, AgentModeState } from "@/lib/agent/agent-mode"

vi.mock("@/lib/agent/agent-mode", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/agent-mode")>(
    "@/lib/agent/agent-mode",
  )
  return { ...actual, fetchAgentMode: vi.fn(), patchAgentMode: vi.fn() }
})

vi.mock("@/lib/contextual/transport", () => ({ requestReactCheck: vi.fn() }))

const agentMode = await import("@/lib/agent/agent-mode")
const fetchAgentMode = vi.mocked(agentMode.fetchAgentMode)
const patchAgentMode = vi.mocked(agentMode.patchAgentMode)
const transport = await import("@/lib/contextual/transport")
const requestReactCheck = vi.mocked(transport.requestReactCheck)

const { AgentModeControl } = await import("./AgentModeControl")

const OFF: AgentMode = { initiative: false, react: false, scope: "full" }

function state(mode: AgentMode, version = 3): AgentModeState {
  return { mode, version }
}

function renderControl(roleLevel: number = ROLE.PROJECT_LEAD) {
  return render(<AgentModeControl projectId="p1" jwt="test-jwt" roleLevel={roleLevel} />)
}

async function openPopover(roleLevel?: number) {
  const view = renderControl(roleLevel)
  fireEvent.click(await screen.findByTestId("agent-mode-trigger"))
  await screen.findByTestId("agent-mode-popover")
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchAgentMode.mockResolvedValue(state(OFF))
  requestReactCheck.mockResolvedValue({ reactions: [], skipped: [] })
})

describe("AgentModeControl", () => {
  it("labels the trigger with the stored mode's preset name", async () => {
    fetchAgentMode.mockResolvedValue(state({ initiative: true, react: true, scope: "full" }))
    renderControl()
    expect(await screen.findByTestId("agent-mode-trigger")).toHaveTextContent("Autopilot")
  })

  it("says Manual when nothing is switched on", async () => {
    renderControl()
    expect(await screen.findByTestId("agent-mode-trigger")).toHaveTextContent("Manual")
  })

  it("saves a switch immediately and shows the new mode without waiting for the server", async () => {
    let resolvePatch: (value: { kind: "ok"; state: AgentModeState }) => void = () => {}
    patchAgentMode.mockImplementation(
      () => new Promise((resolve) => { resolvePatch = resolve }),
    )
    await openPopover()

    fireEvent.click(screen.getByRole("switch", { name: "React loop" }))

    // Optimistic: the label already reads the new mode while the write is
    // still in flight — a dial that lagged the server would feel broken.
    await waitFor(() =>
      expect(screen.getByTestId("agent-mode-trigger")).toHaveTextContent("Reacting"),
    )
    expect(patchAgentMode).toHaveBeenCalledWith(
      "test-jwt",
      "p1",
      { initiative: false, react: true, scope: "full" },
      3,
    )
    resolvePatch({ kind: "ok", state: state({ ...OFF, react: true }, 4) })
  })

  it("reverts the switch and says why when the write is refused", async () => {
    patchAgentMode.mockResolvedValue({ kind: "forbidden" })
    await openPopover()

    fireEvent.click(screen.getByRole("switch", { name: "React loop" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only a project lead can change the agent mode.",
    )
    // The UI must not keep claiming an autonomy the project does not have.
    expect(screen.getByRole("switch", { name: "React loop" })).toHaveAttribute(
      "aria-checked",
      "false",
    )
    expect(screen.getByTestId("agent-mode-trigger")).toHaveTextContent("Manual")
  })

  it("keeps the second version the server hands back, so the next save is not a conflict", async () => {
    patchAgentMode.mockResolvedValue({
      kind: "ok",
      state: state({ ...OFF, react: true }, 9),
    })
    await openPopover()

    fireEvent.click(screen.getByRole("switch", { name: "React loop" }))
    await waitFor(() => expect(patchAgentMode).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole("switch", { name: "Initiative loop" }))
    await waitFor(() =>
      expect(patchAgentMode).toHaveBeenNthCalledWith(
        2,
        "test-jwt",
        "p1",
        { initiative: true, react: true, scope: "full" },
        9,
      ),
    )
  })

  it("sets both switches AND the scope from one preset chip", async () => {
    patchAgentMode.mockResolvedValue({
      kind: "ok",
      state: state({ initiative: false, react: true, scope: "qa" }, 4),
    })
    await openPopover()

    fireEvent.click(screen.getByRole("button", { name: "QA only" }))

    await waitFor(() =>
      expect(patchAgentMode).toHaveBeenCalledWith(
        "test-jwt",
        "p1",
        { initiative: false, react: true, scope: "qa" },
        3,
      ),
    )
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "React loop" })).toHaveAttribute(
        "aria-checked",
        "true",
      )
      expect(screen.getByRole("switch", { name: "Initiative loop" })).toHaveAttribute(
        "aria-checked",
        "false",
      )
      expect(screen.getByRole("radio", { name: "Checks only" })).toHaveAttribute(
        "aria-checked",
        "true",
      )
    })
  })

  it("moves only the scope when the scope control is used", async () => {
    patchAgentMode.mockResolvedValue({
      kind: "ok",
      state: state({ ...OFF, scope: "draft" }, 4),
    })
    await openPopover()

    fireEvent.click(screen.getByRole("radio", { name: "Drafts only" }))

    await waitFor(() =>
      expect(patchAgentMode).toHaveBeenCalledWith(
        "test-jwt",
        "p1",
        { initiative: false, react: false, scope: "draft" },
        3,
      ),
    )
  })

  it("checks for updates on demand and reports what it started", async () => {
    requestReactCheck.mockResolvedValue({
      reactions: [{ fileId: "file-1", runId: "run-9" }],
      skipped: [],
    })
    await openPopover()

    fireEvent.click(screen.getByRole("button", { name: /Check for updates now/ }))

    expect(requestReactCheck).toHaveBeenCalledWith("p1")
    expect(await screen.findByText("Started 1 follow-up.")).toBeInTheDocument()
  })

  it("says nothing was found rather than leaving the click unanswered", async () => {
    await openPopover()
    fireEvent.click(screen.getByRole("button", { name: /Check for updates now/ }))
    expect(await screen.findByText("Nothing new to follow up on.")).toBeInTheDocument()
  })

  it("disables the check with an explanation on a server that predates the route", async () => {
    // requestReactCheck resolves null for 404/501 — an older backend must not
    // make the whole dial look broken.
    requestReactCheck.mockResolvedValue(null)
    await openPopover()

    const button = screen.getByRole("button", { name: /Check for updates now/ })
    fireEvent.click(button)

    expect(
      await screen.findByText("This project's server can't check for updates yet."),
    ).toBeInTheDocument()
    await waitFor(() => expect(button).toBeDisabled())
  })

  it("shows a contributor the dial, the reason it is read-only, and still lets them check", async () => {
    await openPopover(ROLE.CONTRIBUTOR)

    const popover = screen.getByTestId("agent-mode-popover")
    expect(within(popover).getByText("Only a project lead can change the agent mode."))
      .toBeInTheDocument()
    const reactSwitch = screen.getByRole("switch", { name: "React loop" })
    expect(reactSwitch).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("button", { name: "QA only" })).toBeDisabled()
    // Read-only must actually be read-only, not merely styled that way.
    fireEvent.click(reactSwitch)
    fireEvent.click(screen.getByRole("button", { name: "QA only" }))
    expect(patchAgentMode).not.toHaveBeenCalled()
    // Asking for a check is CONTRIBUTOR+, unlike changing the standing mode.
    expect(screen.getByRole("button", { name: /Check for updates now/ })).toBeEnabled()
  })

  it("hides the check entirely from a viewer who may not start runs", async () => {
    await openPopover(ROLE.VIEWER)
    expect(screen.queryByRole("button", { name: /Check for updates now/ })).toBeNull()
  })

  it("says the mode is unavailable rather than drawing it as all-off when the read fails", async () => {
    // A failed read is UNKNOWN. Painting it as Manual would tell the user the
    // agent is idle when it may be running.
    fetchAgentMode.mockResolvedValue(null)
    await openPopover()

    expect(screen.getByText("Agent mode is unavailable right now.")).toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: "React loop" })).toBeNull()
  })
})
