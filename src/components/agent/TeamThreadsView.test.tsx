/**
 * TeamThreadsView tests — the Team tab is ONE project channel (v2 of the
 * 2026-08-28 social-workspace design), so these assert the presentation
 * contract that makes that legible:
 *
 *  - the channel is time-ordered and carries every voice at top level:
 *    Coordinator dispatches, questions addressed to the human, and the live
 *    chat session underneath;
 *  - opening a thread never costs the user their place — main collapses to a
 *    spine of the SAME messages in the SAME order, with the open thread's
 *    parent highlighted, and closing restores the channel;
 *  - the one composer says where it sends. In a thread it wears a scope chip
 *    and its message goes to that RUN as steering, not to the chat; on a
 *    finished run it closes rather than silently swallowing the text.
 *
 * Transport and the shared session store are mocked — this is the
 * presentation contract, not the wire.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type {
  ContextualDecisionsPage,
  ContextualRunActivity,
  ContextualRunPage,
  ContextualRunRecord,
} from "@/lib/contextual/transport"

vi.mock("@/lib/contextual/transport", () => ({
  fetchContextualRuns: vi.fn(),
  fetchContextualDecisions: vi.fn(),
  fetchContextualRunActivity: vi.fn(),
  sendContextualSteering: vi.fn(),
  // DecisionCard (rendered in a question thread) imports this too.
  actOnContextualDecision: vi.fn(),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "test-jwt", username: "alice" }, loading: false }),
}))

// The shared chat session: the channel renders its runs and its composer
// sends into it. Faked so the channel's own wiring is what's under test.
const agentSend = vi.fn()
const agentSessionState = {
  sessionId: "s1",
  runs: [] as {
    localId: string
    prompt: string
    runId: string | null
    items: unknown[]
    status: string
  }[],
  isStreaming: false,
  queued: [] as string[],
  decided: new Map(),
  activity: [] as { key: string; note: string }[],
}
vi.mock("@/lib/agent/session-store", () => ({
  useAgentSession: () => ({
    state: agentSessionState,
    send: agentSend,
    stop: vi.fn(),
    reset: vi.fn(),
    decide: vi.fn(),
    noteActivity: vi.fn(),
  }),
}))

// ChatComposer is a TipTap editor whose text can only be set through its
// imperative handle, which this view owns. Stub it down to the contract the
// view actually depends on: a box that honours `isConfigured`, shows the
// placeholder, and hands back typed text on send.
vi.mock("@/components/chat/ChatComposer", () => ({
  ChatComposer: ({
    isConfigured,
    onSend,
    placeholder,
  }: {
    isConfigured: boolean
    onSend: (payload: { text: string; chips: [] }) => void
    placeholder?: string
  }) => {
    let value = ""
    return (
      <div>
        <input
          aria-label="Ask the agent"
          disabled={!isConfigured}
          placeholder={placeholder}
          onChange={(e) => {
            value = e.target.value
          }}
        />
        <button type="button" disabled={!isConfigured} onClick={() => onSend({ text: value, chips: [] })}>
          Send
        </button>
      </div>
    )
  },
}))

const transport = await import("@/lib/contextual/transport")
const fetchContextualRuns = vi.mocked(transport.fetchContextualRuns)
const fetchContextualDecisions = vi.mocked(transport.fetchContextualDecisions)
const fetchContextualRunActivity = vi.mocked(transport.fetchContextualRunActivity)
const sendContextualSteering = vi.mocked(transport.sendContextualSteering)

const { TeamThreadsView } = await import("./TeamThreadsView")

function runRecord(overrides: Partial<ContextualRunRecord> = {}): ContextualRunRecord {
  return {
    runId: "run-1",
    fileId: "file-1",
    status: "running",
    phase: "drafting",
    spanLabel: "MRK 4:1–4:8",
    done: 1,
    total: 4,
    failed: 0,
    unitsSpent: 2,
    callsSpent: 5,
    lastError: null,
    createdAt: "2026-08-28T11:00:00Z",
    updatedAt: "2026-08-28T12:00:00Z",
    activeDirections: [],
    proposedDrafts: 3,
    targetLang: "",
    ...overrides,
  }
}

function runsPage(runs: ContextualRunRecord[]): ContextualRunPage {
  return { available: true, runs, truncated: false, nextCursor: null }
}

function decisionsPage(overrides: Partial<ContextualDecisionsPage> = {}): ContextualDecisionsPage {
  return { decisions: [], openCount: 0, cap: 3, ...overrides }
}

function activity(events: ContextualRunActivity["events"]): ContextualRunActivity {
  return {
    run: null,
    events,
    sceneBriefs: [],
    drafts: [],
    truncated: false,
    truncatedCollections: { events: false, sceneBriefs: false, drafts: false },
    draftCounts: { proposed: 0, applied: 0, rejected: 0, superseded: 0 },
    draftNextCursor: null,
  }
}

const openQuestion = {
  id: "d1",
  fileId: "file-1",
  cellIds: ["c1"],
  reason: "Two prior renderings of this name conflict.",
  readinessItem: null,
  blastRadius: 4,
  status: "open" as const,
  assignedUserId: null,
}

function renderView() {
  return render(
    <MemoryRouter>
      <TeamThreadsView
        projectId="p1"
        fileNames={new Map([["file-1", "Mark"], ["file-2", "Luke"]])}
      />
    </MemoryRouter>,
  )
}

beforeAll(() => {
  // ScrollArea uses @base-ui/react which calls getAnimations() — not in
  // happy-dom (same shim as AutopilotActivityInspector.test).
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  })
})

beforeEach(() => {
  vi.clearAllMocks()
  agentSessionState.runs = []
  agentSessionState.isStreaming = false
  fetchContextualRunActivity.mockResolvedValue(activity([]))
  sendContextualSteering.mockResolvedValue(undefined)
})

describe("TeamThreadsView — the project channel", () => {
  it("introduces the team when nothing has run yet", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([]))
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    const view = renderView()
    expect(await screen.findByText("The team posts its work here")).toBeInTheDocument()
    for (const name of ["Drafter", "Reviewer", "Coordinator"]) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0)
    }
    view.unmount()
  })

  it("posts dispatches in time order, questions, and the live conversation in one channel", async () => {
    fetchContextualRuns.mockResolvedValue(
      // Newest first on the wire — the channel must read oldest-first.
      runsPage([
        runRecord({ runId: "run-2", fileId: "file-2", createdAt: "2026-08-28T13:00:00Z" }),
        runRecord({ runId: "run-1", fileId: "file-1", createdAt: "2026-08-28T11:00:00Z" }),
      ]),
    )
    fetchContextualDecisions.mockResolvedValue(
      decisionsPage({ openCount: 1, decisions: [openQuestion] }),
    )
    agentSessionState.runs = [
      { localId: "chat-1", prompt: "How is Mark going?", runId: null, items: [], status: "done" },
    ]
    const view = renderView()

    const channel = await screen.findByTestId("team-channel")
    expect(await within(channel).findByText("Started work on Mark.")).toBeInTheDocument()
    expect(within(channel).getByText("Started work on Luke.")).toBeInTheDocument()
    // Oldest dispatch first, then the question, then the chat conversation.
    const order = within(channel)
      .getAllByText(/Started work on|Two prior renderings|How is Mark going\?/)
      .map((node) => node.textContent)
    expect(order).toEqual([
      "Started work on Mark.",
      "Started work on Luke.",
      "Two prior renderings of this name conflict.",
      "How is Mark going?",
    ])
    // Question messages are addressed to the human, in the Coordinator's voice.
    expect(within(channel).getByText("Needs your expertise")).toBeInTheDocument()
    // The run's staged-draft count rides its dispatch message.
    expect(within(channel).getAllByText("3").length).toBeGreaterThan(0)
    view.unmount()
  })

  it("opens a dispatch thread, collapses the channel to a highlighted spine, and scopes the composer", async () => {
    fetchContextualRuns.mockResolvedValue(
      runsPage([
        runRecord({ runId: "run-1", fileId: "file-1", createdAt: "2026-08-28T11:00:00Z" }),
        runRecord({ runId: "run-2", fileId: "file-2", createdAt: "2026-08-28T13:00:00Z" }),
      ]),
    )
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    fetchContextualRunActivity.mockResolvedValue(
      activity([
        {
          id: "e1",
          runId: "run-1",
          projectId: "p1",
          fileId: "file-1",
          kind: "drafts_staged",
          spanId: "s1",
          spanLabel: "MRK 4:1–4:8",
          summary: "",
          details: { count: 3 },
          createdAt: "2026-08-28T12:00:05Z",
        },
      ]),
    )
    const view = renderView()

    fireEvent.click(await screen.findByRole("button", { name: "Open the thread for Mark" }))

    // The thread takes the width and shows the subagent's play-by-play.
    expect(await screen.findByText("Put 3 drafts out for your review.")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Review drafts" })).toBeInTheDocument()
    // Main collapsed to the spine: the same two messages, same order, with
    // the open thread's parent highlighted.
    expect(screen.queryByTestId("team-channel")).not.toBeInTheDocument()
    const spine = screen.getByTestId("team-channel-spine")
    const spineItems = Array.from(spine.querySelectorAll("[data-spine-item]"))
    expect(spineItems.map((node) => node.getAttribute("data-spine-item"))).toEqual([
      "run:run-1",
      "run:run-2",
    ])
    expect(spineItems.map((node) => node.getAttribute("data-active"))).toEqual(["true", "false"])
    // The composer says exactly who it is talking to.
    const scope = screen.getByTestId("team-composer-scope")
    expect(scope).toHaveTextContent("Drafter · MRK 4:1–4:8")
    view.unmount()
  })

  it("sends a thread message to that run as steering, never to the chat", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([runRecord({ runId: "run-7" })]))
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    const view = renderView()

    fireEvent.click(await screen.findByRole("button", { name: "Open the thread for Mark" }))
    await screen.findByTestId("team-composer-scope")

    fireEvent.change(screen.getByLabelText("Ask the agent"), {
      target: { value: "keep the tone formal" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() =>
      expect(sendContextualSteering).toHaveBeenCalledWith("run-7", "keep the tone formal"),
    )
    expect(agentSend).not.toHaveBeenCalled()
    view.unmount()
  })

  it("closes the thread composer on a finished run and explains why", async () => {
    fetchContextualRuns.mockResolvedValue(
      runsPage([runRecord({ runId: "run-9", status: "done", phase: null })]),
    )
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    const view = renderView()

    fireEvent.click(await screen.findByRole("button", { name: "Open the thread for Mark" }))
    const box = await screen.findByLabelText("Ask the agent")
    expect(box).toBeDisabled()
    expect(box).toHaveAttribute(
      "placeholder",
      "This work has finished — there is no one left in this thread to direct.",
    )
    view.unmount()
  })

  it("restores the full channel when the spine is clicked", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([runRecord()]))
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    const view = renderView()

    fireEvent.click(await screen.findByRole("button", { name: "Open the thread for Mark" }))
    expect(await screen.findByTestId("team-channel-spine")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("team-channel-spine"))

    expect(await screen.findByTestId("team-channel")).toBeInTheDocument()
    expect(screen.queryByTestId("team-channel-spine")).not.toBeInTheDocument()
    // Back on the channel, the composer addresses the team, not a subagent.
    expect(screen.queryByTestId("team-composer-scope")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Ask the agent")).toHaveAttribute(
      "placeholder",
      "Message the team…",
    )
    view.unmount()
  })

  it("sends a channel message to the shared chat session", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([runRecord()]))
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    const view = renderView()
    await screen.findByTestId("team-channel")

    fireEvent.change(screen.getByLabelText("Ask the agent"), {
      target: { value: "what is left in Mark?" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    expect(agentSend).toHaveBeenCalledTimes(1)
    expect(agentSend.mock.calls[0][0]).toMatchObject({
      wire: "what is left in Mark?",
      jwt: "test-jwt",
      request: { projectId: "p1" },
    })
    expect(sendContextualSteering).not.toHaveBeenCalled()
    view.unmount()
  })

  it("opens a question thread on its decision card, with no second message box", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([]))
    fetchContextualDecisions.mockResolvedValue(
      decisionsPage({ openCount: 1, decisions: [openQuestion] }),
    )
    const view = renderView()

    fireEvent.click(await screen.findByRole("button", { name: "Open this question" }))

    expect(await screen.findByTestId("contextual-decision-card")).toBeInTheDocument()
    // DecisionCard owns its own Answer input — the channel composer stands down.
    expect(screen.queryByLabelText("Ask the agent")).not.toBeInTheDocument()
    view.unmount()
  })

  it("offers a retry when the team's activity can't load", async () => {
    fetchContextualRuns.mockRejectedValue(new Error("offline"))
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    const view = renderView()
    expect(await screen.findByText("Couldn't load the team's activity.")).toBeInTheDocument()
    fetchContextualRuns.mockResolvedValue(runsPage([]))
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("The team posts its work here")).toBeInTheDocument()
    view.unmount()
  })
})
