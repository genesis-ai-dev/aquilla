/**
 * TeamThreadsView tests — the Team tab must present autopilot work as a
 * social surface: a roster the user can meet before any run exists, one
 * thread per run with persona-attributed plain-language messages, and a
 * pinned "Needs your expertise" thread that takes precedence while open
 * decisions exist (2026-08-28 social-workspace design). Transport is mocked —
 * this is the presentation contract, not the wire.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type {
  ContextualDecisionsPage,
  ContextualRunActivity,
  ContextualRunPage,
  ContextualRunRecord,
} from "@/lib/contextual/transport"
import { TeamThreadsView } from "./TeamThreadsView"

vi.mock("@/lib/contextual/transport", () => ({
  fetchContextualRuns: vi.fn(),
  fetchContextualDecisions: vi.fn(),
  fetchContextualRunActivity: vi.fn(),
  // DecisionCard (rendered in the decisions thread) imports this too.
  actOnContextualDecision: vi.fn(),
}))

const transport = await import("@/lib/contextual/transport")
const fetchContextualRuns = vi.mocked(transport.fetchContextualRuns)
const fetchContextualDecisions = vi.mocked(transport.fetchContextualDecisions)
const fetchContextualRunActivity = vi.mocked(transport.fetchContextualRunActivity)

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

function renderView() {
  return render(
    <MemoryRouter>
      <TeamThreadsView projectId="p1" fileNames={new Map([["file-1", "Mark"]])} />
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
  fetchContextualRunActivity.mockResolvedValue(activity([]))
})

describe("TeamThreadsView", () => {
  it("introduces the team when nothing has run yet", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([]))
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    const view = renderView()
    expect(await screen.findByText("The team posts its work here")).toBeInTheDocument()
    for (const name of ["Drafter", "Reviewer", "Coordinator"]) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
    view.unmount()
  })

  it("lists one thread per run and narrates the selected run's feed", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([runRecord()]))
    fetchContextualDecisions.mockResolvedValue(decisionsPage())
    fetchContextualRunActivity.mockResolvedValue(
      activity([
        {
          id: "e1",
          runId: "run-1",
          projectId: "p1",
          fileId: "file-1",
          kind: "span_started",
          spanId: "s1",
          spanLabel: "MRK 4:1–4:8",
          summary: "",
          details: {},
          createdAt: "2026-08-28T12:00:00Z",
        },
        {
          id: "e2",
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
    // Thread titled by file name, auto-selected (newest run).
    expect((await screen.findAllByText("Mark")).length).toBeGreaterThan(0)
    // Persona-attributed plain language, not event kinds.
    expect(await screen.findByText("Starting on MRK 4:1–4:8.")).toBeInTheDocument()
    expect(screen.getByText("Put 3 drafts out for your review.")).toBeInTheDocument()
    // Staged drafts link straight to review.
    expect(screen.getByRole("link", { name: "Review drafts" })).toBeInTheDocument()
    view.unmount()
  })

  it("pins and auto-selects the decisions thread while questions are open", async () => {
    fetchContextualRuns.mockResolvedValue(runsPage([runRecord()]))
    fetchContextualDecisions.mockResolvedValue(
      decisionsPage({
        openCount: 2,
        decisions: [
          {
            id: "d1",
            fileId: "file-1",
            cellIds: ["c1"],
            reason: "Two prior renderings of this name conflict.",
            readinessItem: null,
            blastRadius: 4,
            status: "open",
            assignedUserId: null,
          },
        ],
      }),
    )
    const view = renderView()
    expect(await screen.findByText("Needs your expertise")).toBeInTheDocument()
    // Auto-selected: the question card is showing without a click.
    expect(
      await screen.findByText("Two prior renderings of this name conflict."),
    ).toBeInTheDocument()
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
