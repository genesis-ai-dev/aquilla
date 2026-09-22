/**
 * TeamThreadsView tests — the Team surface in the v2.2 three-column layout
 * (2026-08-28): the conversations list lives in the DOCK (AgentDockPanel);
 * this surface is the active conversation plus the optional step inspector.
 * These assert the presentation contract:
 *
 *  - selection is URL-driven (CONVERSATION_PARAM): absent = Team chat, and a
 *    run id in the URL opens that run's conversation directly (a dock click,
 *    a shared link);
 *  - Team chat is time-ordered: Coordinator dispatches (with a quiet "view
 *    updates" affordance), questions addressed to the human, the live
 *    session underneath; Escape is the keyboard way home;
 *  - clicking a step opens the inspector third column with the receipts
 *    (raw event kind/details) behind collapsed sections;
 *  - the one composer says where it sends: Team chat → the shared session;
 *    a live run → steering; a FINISHED run with CONTRIBUTOR+ → re-opens the
 *    work (fresh run seeded with the message); finished without the role →
 *    the box closes and says why.
 *
 * Transport and the shared session store are mocked — this is the
 * presentation contract, not the wire.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { ROLE } from "@/lib/frontier/roles"
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
  startFileContextualRun: vi.fn(),
  // DecisionCard (rendered in the questions conversation) imports this too.
  actOnContextualDecision: vi.fn(),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "test-jwt", username: "alice" }, loading: false }),
}))

// The shared chat session: Team chat renders its runs and its composer sends
// into it. Faked so the surface's own wiring is what's under test.
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
const startFileContextualRun = vi.mocked(transport.startFileContextualRun)

const { resetTeamConversationsForTesting } = await import("@/lib/agent/team-conversations")
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

const stagedEvent = {
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

function renderView(options: { initialEntry?: string; roleLevel?: number } = {}) {
  return render(
    <MemoryRouter initialEntries={[options.initialEntry ?? "/project/p1/agent"]}>
      <TeamThreadsView
        projectId="p1"
        fileNames={new Map([["file-1", "Mark"], ["file-2", "Luke"]])}
        roleLevel={options.roleLevel ?? null}
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
  resetTeamConversationsForTesting()
  agentSessionState.runs = []
  agentSessionState.isStreaming = false
  fetchContextualRunActivity.mockResolvedValue(activity([]))
  // AQU-1299: steering resolves to the server's routed result, not void.
  sendContextualSteering.mockResolvedValue({ intent: "direction", applied: true, run: null })
})

describe("TeamThreadsView — the active conversation surface", () => {
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

  it("shows Team chat by default: dispatches in time order, questions, and the conversation", async () => {
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
    const order = within(channel)
      .getAllByText(/Started work on|Two prior renderings|How is Mark going\?/)
      .map((node) => node.textContent)
    expect(order).toEqual([
      "Started work on Mark.",
      "Started work on Luke.",
      "Two prior renderings of this name conflict.",
      "How is Mark going?",
    ])
    // The replies-badge pattern: a quiet inline affordance under the message.
    expect(
      within(channel).getByRole("button", { name: "Open the thread for Mark" }),
    ).toHaveTextContent("View updates")
    view.unmount()
  })

  it("opens the conversation named by the URL directly (dock click, shared link)", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([runRecord()]))
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    fetchContextualRunActivity.mockResolvedValue(activity([stagedEvent]))
    const view = renderView({ initialEntry: "/project/p1/agent?conversation=run%3Arun-1" })

    expect(await screen.findByTestId("team-thread-detail")).toBeInTheDocument()
    expect(await screen.findByText("Put 3 drafts out for your review.")).toBeInTheDocument()
    // The composer says exactly who it is talking to.
    expect(screen.getByTestId("team-composer-scope")).toHaveTextContent("Drafter · MRK 4:1–4:8")
    view.unmount()
  })

  it("clicking a step opens the inspector with the receipts behind collapsed sections", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([runRecord()]))
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    fetchContextualRunActivity.mockResolvedValue(activity([stagedEvent]))
    const view = renderView({ initialEntry: "/project/p1/agent?conversation=run%3Arun-1" })

    fireEvent.click(await screen.findByText("Put 3 drafts out for your review."))
    const inspector = await screen.findByTestId("team-step-inspector")
    // The receipts are collapsed by default…
    expect(within(inspector).queryByText("drafts_staged")).not.toBeInTheDocument()
    // …and one click away.
    fireEvent.click(within(inspector).getByRole("button", { name: "Details" }))
    expect(within(inspector).getByText("drafts_staged")).toBeInTheDocument()
    expect(within(inspector).getByText("count")).toBeInTheDocument()
    // Close restores the two-column view.
    fireEvent.click(within(inspector).getByRole("button", { name: "Close step detail" }))
    expect(screen.queryByTestId("team-step-inspector")).not.toBeInTheDocument()
    view.unmount()
  })

  it("sends a thread message to that run as steering, never to the chat", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([runRecord({ runId: "run-7" })]))
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    const view = renderView({ initialEntry: "/project/p1/agent?conversation=run%3Arun-7" })
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

  it("re-opens a finished run by messaging when the viewer can start runs", async () => {
    fetchContextualRuns.mockResolvedValue(
      runsPage([runRecord({ runId: "run-9", status: "done", phase: null })]),
    )
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    startFileContextualRun.mockResolvedValue({ runId: "run-10" })
    const view = renderView({
      initialEntry: "/project/p1/agent?conversation=run%3Arun-9",
      roleLevel: ROLE.CONTRIBUTOR,
    })

    const box = await screen.findByLabelText("Ask the agent")
    expect(box).toBeEnabled()
    expect(box).toHaveAttribute(
      "placeholder",
      "Message to start new work on this file — your note guides the fresh run.",
    )
    fireEvent.change(box, { target: { value: "redo GEN 1 with simpler wording" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() =>
      expect(startFileContextualRun).toHaveBeenCalledWith("p1", "file-1", ""),
    )
    await waitFor(() =>
      expect(sendContextualSteering).toHaveBeenCalledWith(
        "run-10",
        "redo GEN 1 with simpler wording",
      ),
    )
    expect(agentSend).not.toHaveBeenCalled()
    view.unmount()
  })

  it("closes the thread composer on a finished run for viewers who cannot start runs", async () => {
    fetchContextualRuns.mockResolvedValue(
      runsPage([runRecord({ runId: "run-9", status: "done", phase: null })]),
    )
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    const view = renderView({ initialEntry: "/project/p1/agent?conversation=run%3Arun-9" })

    const box = await screen.findByLabelText("Ask the agent")
    expect(box).toBeDisabled()
    expect(box).toHaveAttribute(
      "placeholder",
      "This work has finished — there is no one left in this thread to direct.",
    )
    view.unmount()
  })

  it("Escape returns to Team chat", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([runRecord()]))
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    const view = renderView({ initialEntry: "/project/p1/agent?conversation=run%3Arun-1" })

    expect(await screen.findByTestId("team-thread-detail")).toBeInTheDocument()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(await screen.findByTestId("team-channel")).toBeInTheDocument()
    // Back on Team chat, the composer addresses the team, not a subagent.
    expect(screen.queryByTestId("team-composer-scope")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Ask the agent")).toHaveAttribute(
      "placeholder",
      "Message the team…",
    )
    view.unmount()
  })

  it("sends a Team chat message to the shared chat session", async () => {
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

  it("consolidates open questions into one conversation, with no second message box", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([]))
    fetchContextualDecisions.mockResolvedValue(
      decisionsPage({ openCount: 1, decisions: [openQuestion] }),
    )
    const view = renderView()

    // Reachable from the inline Answer affordance in Team chat…
    fireEvent.click(await screen.findByRole("button", { name: "Open this question" }))

    expect(await screen.findByTestId("team-questions")).toBeInTheDocument()
    expect(screen.getByTestId("contextual-decision-card")).toBeInTheDocument()
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
