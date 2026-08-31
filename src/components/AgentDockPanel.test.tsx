/**
 * AgentDockPanel tests — the dock's Agent tab is the THREADS LIST (v2.2
 * three-column layout): the conversations every teammate is working, one row
 * each, and clicking one navigates to that conversation on the agent surface
 * (URL-driven selection). The old dock-local chat is gone on purpose — this
 * panel answers "what is the team doing", it does not host a second composer.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import type {
  ContextualDecisionsPage,
  ContextualRunPage,
  ContextualRunRecord,
} from "@/lib/contextual/transport"

vi.mock("@/lib/contextual/transport", () => ({
  fetchContextualRuns: vi.fn(),
  fetchContextualDecisions: vi.fn(),
  fetchContextualRunActivity: vi.fn(),
  sendContextualSteering: vi.fn(),
  startFileContextualRun: vi.fn(),
  actOnContextualDecision: vi.fn(),
}))

vi.mock("@/lib/agent/session-store", () => ({
  useAgentSession: () => ({
    state: {
      sessionId: "s1",
      runs: [],
      isStreaming: false,
      queued: [],
      decided: new Map(),
      activity: [],
    },
    send: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    decide: vi.fn(),
    noteActivity: vi.fn(),
  }),
}))

const transport = await import("@/lib/contextual/transport")
const fetchContextualRuns = vi.mocked(transport.fetchContextualRuns)
const fetchContextualDecisions = vi.mocked(transport.fetchContextualDecisions)

const { resetTeamConversationsForTesting } = await import("@/lib/agent/team-conversations")
const { AgentDockPanel } = await import("./AgentDockPanel")

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

let currentPath = ""
function LocationProbe() {
  const location = useLocation()
  currentPath = `${location.pathname}${location.search}`
  return null
}

function renderPanel(initialEntry = "/project/p1/editor") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <AgentDockPanel
        projectId="p1"
        author="alice"
        fileNames={new Map([["file-1", "Mark"]])}
        onExpand={() => {}}
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
  currentPath = ""
})

describe("AgentDockPanel", () => {
  it("lists the team's conversations — Team chat pinned, runs with previews and count badges", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([runRecord()]))
    fetchContextualDecisions.mockResolvedValue(
      decisionsPage({
        openCount: 1,
        decisions: [
          {
            id: "d1",
            fileId: "file-1",
            cellIds: [],
            reason: "Two prior renderings conflict.",
            readinessItem: null,
            blastRadius: 1,
            status: "open",
            assignedUserId: null,
          },
        ],
      }),
    )
    renderPanel()

    const list = await screen.findByTestId("team-conversation-list")
    const rows = within(list).getAllByRole("button")
    expect(rows[0]).toHaveTextContent("Team chat")
    expect(rows[1]).toHaveTextContent("Needs your expertise")
    expect(rows[2]).toHaveTextContent("Mark")
    expect(rows[2]).toHaveTextContent("3 drafts ready for your review")
    // No composer here — the dock lists, the surface talks.
    expect(screen.queryByLabelText("Ask the agent")).not.toBeInTheDocument()
  })

  it("clicking a conversation navigates to it on the agent surface", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([runRecord()]))
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    renderPanel()

    const list = await screen.findByTestId("team-conversation-list")
    fireEvent.click(within(list).getByText("Mark"))
    expect(currentPath).toBe("/project/p1/agent?conversation=run%3Arun-1")

    fireEvent.click(within(list).getByText("Team chat"))
    expect(currentPath).toBe("/project/p1/agent?conversation=team-chat")
  })

  it("marks a conversation the team started off the back of your edits", async () => {
    // A reaction run is uninvited work. The row has to admit that at a glance
    // — quietly (a muted glyph, not an alert), which is what keeps the react
    // loop a thread you find rather than a notification that finds you.
    fetchContextualRuns.mockResolvedValue(
      runsPage([runRecord({ proposedDrafts: 0, initiatedBy: "reaction" })]),
    )
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    renderPanel()

    const list = await screen.findByTestId("team-conversation-list")
    expect(
      within(list).getByLabelText("Started in response to your changes"),
    ).toBeInTheDocument()
    expect(
      within(list).getByText("Reacted to your changes — Working — MRK 4:1–4:8"),
    ).toBeInTheDocument()
  })

  it("leaves a run somebody asked for unmarked", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([runRecord()]))
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    renderPanel()

    const list = await screen.findByTestId("team-conversation-list")
    expect(within(list).queryByLabelText("Started in response to your changes")).toBeNull()
  })

  it("never titles a row with a raw span id", async () => {
    // No file name to fall back on and an opaque span label — the row must
    // reach the generic title rather than printing a UUID.
    fetchContextualRuns.mockResolvedValue(
      runsPage([
        runRecord({
          fileId: "file-unknown",
          spanLabel: "0b6f1f1e-4a1e-4c33-9f4a-8f2b0f5f1e77",
        }),
      ]),
    )
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    renderPanel()

    const list = await screen.findByTestId("team-conversation-list")
    expect(within(list).getByText("Autopilot run")).toBeInTheDocument()
    expect(within(list).queryByText(/0b6f1f1e/)).toBeNull()
  })

  it("the new-conversation control heads to a fresh Team chat", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([]))
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    renderPanel()

    fireEvent.click(await screen.findByRole("button", { name: "New conversation" }))
    expect(currentPath).toBe("/project/p1/agent?conversation=team-chat")
  })
})
