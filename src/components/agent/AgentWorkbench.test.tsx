/**
 * AgentWorkbench integration harness — real session store, real working-set
 * derivation, real staged-apply path (fake-indexeddb outbox), real panel.
 * The chat rail (AgentDockView) is stubbed out: these tests exercise the
 * review loop, not the conversation UI.
 *
 * Born from a live bug report: accepting drafts blanked the working-set rows
 * even though the commits landed. The grid must keep showing the committed
 * text after accept (and the restored text after undo).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest"
import { render as renderUI, screen, fireEvent, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import type { AgentFrame } from "@/lib/agent/protocol"

// Stub the chat rail but keep the workbench seam: render each proposal
// through renderProposalOverride so the RECEIPT (counters + Undo) is real.
vi.mock("./AgentDockView", async () => {
  const { agentSessionStore: storeOf } = await import("@/lib/agent/session-store")
  const { proposalsOf } = await import("@/lib/agent/run-state")
  return {
    AgentDockView: (props: {
      projectId: string
      author: string
      renderProposalOverride?: (p: unknown) => unknown
    }) => (
      <>
        {storeOf(props.projectId, props.author)
          .getState()
          .runs.flatMap((r) => proposalsOf(r))
          .map((p) => props.renderProposalOverride?.(p) ?? null)}
      </>
    ),
  }
})

// Scripted transport: store.send() replays these frames synchronously.
let scriptedFrames: AgentFrame[] = []
vi.mock("@/lib/agent/agent-client", () => ({
  runAgent: vi.fn(async ({ onFrame }: { onFrame: (f: AgentFrame) => void }) => {
    for (const frame of scriptedFrames) onFrame(frame)
  }),
}))

// The Memory tab lazy-loads W1E's real AgentMemoryTab, which reads the session
// and fetches memory/brief on mount. Mock both so the tab renders its real
// shell (Proposed/Approved/Project brief) instead of erroring on a live fetch.
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "test-jwt", username: "alice" }, loading: false }),
}))
vi.mock("@/lib/contextual/transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/contextual/transport")>(),
  fetchContextualRuns: vi.fn().mockResolvedValue({
    available: true, runs: [], truncated: false, nextCursor: null,
  }),
  fetchContextualDecisions: vi.fn().mockResolvedValue({
    decisions: [], openCount: 0, cap: 3,
  }),
  fetchContextualRunActivity: vi.fn().mockResolvedValue({
    run: null, events: [], sceneBriefs: [], drafts: [], truncated: false,
    truncatedCollections: { events: false, sceneBriefs: false, drafts: false },
    draftCounts: { proposed: 0, applied: 0, rejected: 0, superseded: 0 },
    draftNextCursor: null,
  }),
}))
vi.mock("@/lib/agent/memory-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/memory-api")>("@/lib/agent/memory-api")
  return {
    ...actual,
    listAgentMemories: vi.fn().mockResolvedValue([]),
    getProjectBrief: vi.fn().mockResolvedValue({
      projectId: "wb",
      content: "",
      updatedBy: null,
      version: 1,
      updatedAt: "2026-01-01T00:00:00Z",
    }),
    listBriefProposals: vi.fn().mockResolvedValue([]),
  }
})

import { agentSessionStore } from "@/lib/agent/session-store"
import { runAgent } from "@/lib/agent/agent-client"
import { getOutboxRecords, outboxRecordCountAllOwners } from "@/lib/sync/outbox"
import { AgentWorkbench, type AgentWorkbenchProps } from "./AgentWorkbench"
import { AgentDockPanel } from "@/components/AgentDockPanel"
import { fetchContextualRuns } from "@/lib/contextual/transport"
import { resetTeamConversationsForTesting } from "@/lib/agent/team-conversations"

const PROJECT = `wb-test-${Math.random().toString(36).slice(2)}`

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="workbench-location">{location.pathname}{location.search}</output>
}

function TestRouter({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={[`/project/${PROJECT}/agent`]}>
      <Routes>
        <Route path="/project/:projectId/agent" element={<>{children}</>} />
        <Route path="/project/:projectId/editor/*" element={<p>Editor destination</p>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  )
}

function render(ui: ReactNode) {
  return renderUI(ui, { wrapper: TestRouter })
}

function draftRunFrames(): AgentFrame[] {
  return [
    { type: "run_start", runId: "run-1" },
    { type: "code_start", step: 1, kind: "draft", summary: ":file" },
    {
      type: "proposal",
      proposal: {
        proposalId: "prop-1",
        runId: "run-1",
        summary: "Draft 2 cells",
        events: [
          {
            kind: "target.cell.commit",
            fileId: "f1",
            cellId: "c1",
            parentId: "src-c1",
            payload: { value: "La casa è rossa", sourceEventId: "src-c1", ai_suggestion: true, agent_run_id: "run-1" },
            display: { canonicalRef: "S 1", before: "", after: "La casa è rossa" },
          },
          {
            kind: "target.cell.commit",
            fileId: "f1",
            cellId: "c2",
            parentId: "src-c2",
            payload: { value: "Il cane dorme", sourceEventId: "src-c2", ai_suggestion: true, agent_run_id: "run-1" },
            display: { canonicalRef: "S 2", before: "", after: "Il cane dorme" },
          },
        ],
      },
    },
    {
      type: "code_result",
      step: 1,
      ok: true,
      summary: "staged 2",
      data: {
        cells: [
          { cellId: "c1", fileId: "f1", ref: "S 1", source: "The house is red", target: "", status: "untranslated" },
          { cellId: "c2", fileId: "f1", ref: "S 2", source: "The dog sleeps", target: "", status: "untranslated" },
        ],
      },
    },
    // Real models often re-read AFTER staging (targets still empty — nothing
    // is applied yet). This stale sighting sits later in the timeline and was
    // exactly what blanked accepted rows in the live bug.
    { type: "code_start", step: 2, kind: "read", summary: ":file" },
    {
      type: "code_result",
      step: 2,
      ok: true,
      summary: "2 rows",
      data: {
        cells: [
          { cellId: "c1", fileId: "f1", ref: "S 1", source: "The house is red", target: "", status: "untranslated" },
          { cellId: "c2", fileId: "f1", ref: "S 2", source: "The dog sleeps", target: "", status: "untranslated" },
        ],
      },
    },
    { type: "done", runId: "run-1", status: "ok" },
  ]
}

function workbenchProps(): AgentWorkbenchProps {
  return {
    agent: {
      projectId: PROJECT,
      jwt: "jwt",
      author: "alice",
      roleLevel: 400,
      context: {},
      rules: [],
      resolveCell: () => undefined,
      onApplied: vi.fn(),
    },
    editorHref: `/project/${PROJECT}/editor/file/f1?lane=it`,
    onChooseFile: vi.fn(),
    workspace: {
      fileName: "Mark.md",
      sourceLanguage: "English",
      targetLanguage: "Italian",
      focusedCellId: "c1",
      totalCells: 2,
      cells: [
        {
          cellId: "c1",
          fileId: "f1",
          ref: "MRK 1:1",
          source: "The beginning",
          sourceHtml: "<p>The <strong>beginning</strong></p>",
          target: "L'inizio",
          targetHtml: "<p>L'<em>inizio</em></p>",
          status: "unvalidated",
          healthRibbonPoint: {
            id: "c1",
            stage: "automatic",
            rawScore: 72,
            smoothedScore: 72,
            evidenceWeight: 1,
          },
          validationStatus: "none",
          activeValidators: [],
          validationHistory: [],
          canValidate: true,
        },
        {
          cellId: "c2",
          fileId: "f1",
          ref: "MRK 1:2",
          source: "As it is written",
          target: "",
          status: "empty",
          healthRibbonPoint: {
            id: "c2",
            stage: "untranslated",
            evidenceWeight: 0.1,
          },
          validationStatus: "empty",
          activeValidators: [],
          validationHistory: [],
          canValidate: true,
        },
      ],
      editable: true,
      onCommitTarget: vi.fn(),
      isAnonymous: false,
      isCompletionConfigured: true,
      isCompletionAvailable: true,
      completing: new Map(),
      onDraftTarget: vi.fn().mockResolvedValue(true),
      onOpenComments: vi.fn(),
      onOpenHistory: vi.fn(),
      currentUsername: "alice",
      validationRequirement: 1,
      canValidate: true,
      onValidationChange: vi.fn().mockResolvedValue(true),
    },
  }
}

async function primeSessionWithDraftRun(): Promise<void> {
  scriptedFrames = draftRunFrames()
  agentSessionStore(PROJECT, "alice").send({
    wire: "draft this file",
    display: "draft this file",
    jwt: "jwt",
    request: { projectId: PROJECT },
  })
  await waitFor(() => expect(agentSessionStore(PROJECT, "alice").getState().isStreaming).toBe(false))
}

beforeAll(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  })
})

beforeEach(() => {
  agentSessionStore(PROJECT, "alice").reset()
  resetTeamConversationsForTesting()
  vi.mocked(fetchContextualRuns).mockResolvedValue({ available: true, runs: [], truncated: false, nextCursor: null })
})

describe("AgentWorkbench optional document context", () => {
  it("starts with one conversation and opens paired document context explicitly", () => {
    render(<AgentWorkbench {...workbenchProps()} />)
    expect(screen.getByRole("tab", { name: "Conversation" })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByRole("tab", { name: "Chat" })).not.toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Team" })).not.toBeInTheDocument()
    expect(screen.queryByText("The beginning")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("tab", { name: "Document" }))
    expect(screen.getByRole("link", { name: "Back to editor" })).toBeInTheDocument()
    expect(screen.getByTestId("workbench-location")).toHaveTextContent("view=document")
    expect(screen.getByText("beginning", { selector: "strong" })).toBeInTheDocument()
    expect(screen.getByText("inizio", { selector: "em" })).toBeInTheDocument()
    expect(screen.getAllByTestId("health-ribbon")).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Not validated — MRK 1:1. Click to validate." })).toBeEnabled()
    expect(screen.queryAllByRole("separator")).toHaveLength(0)
  })

  it("opens staged proposals with paired source in the explicit review view", async () => {
    await primeSessionWithDraftRun()
    render(<AgentWorkbench {...workbenchProps()} />)
    fireEvent.click(screen.getByRole("tab", { name: "Review drafts" }))
    expect(screen.getByText("The house is red")).toBeInTheDocument()
    expect(screen.getByText("La casa è rossa")).toBeInTheDocument()
    expect(screen.getByTestId("workbench-location")).toHaveTextContent("view=review")
  })

  it("uses the editor's real target actions in agent mode", () => {
    const props = workbenchProps()
    render(<AgentWorkbench {...props} />)
    fireEvent.click(screen.getByRole("tab", { name: "Document" }))

    fireEvent.click(screen.getAllByRole("button", { name: "Translate with AI" })[1])
    expect(props.workspace?.onDraftTarget).toHaveBeenCalledWith("c2")
    fireEvent.click(screen.getAllByRole("button", { name: "Add comment" })[1])
    expect(props.workspace?.onOpenComments).toHaveBeenCalledWith("c2")
    fireEvent.click(screen.getAllByRole("button", { name: "Edit history" })[1])
    expect(props.workspace?.onOpenHistory).toHaveBeenCalledWith("c2")
  })

  it("stops document visibility tracking when returning to the conversation", () => {
    const props = workbenchProps()
    const onVisibleCellIdsChange = vi.fn()
    props.workspace!.onVisibleCellIdsChange = onVisibleCellIdsChange
    render(<AgentWorkbench {...props} />)
    fireEvent.click(screen.getByRole("tab", { name: "Document" }))
    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }))
    expect(onVisibleCellIdsChange).toHaveBeenLastCalledWith([])
  })

  it("uses the editor's real validation control in agent mode", () => {
    const props = workbenchProps()
    render(<AgentWorkbench {...props} />)
    fireEvent.click(screen.getByRole("tab", { name: "Document" }))

    fireEvent.click(screen.getByRole("button", { name: "Not validated — MRK 1:1. Click to validate." }))
    expect(props.workspace?.onValidationChange).toHaveBeenCalledWith("c1", true)
  })

  it("a read-only run does not turn committed document context into a proposal", async () => {
    scriptedFrames = [
      { type: "run_start", runId: "run-r" },
      { type: "code_start", step: 1, kind: "read", summary: ":file" },
      {
        type: "code_result",
        step: 1,
        ok: true,
        summary: "2 rows",
        data: {
          cells: [
            { cellId: "c1", fileId: "f1", ref: "MRK 1:1", source: "The beginning", target: "Yeh ibtidaa", status: "drafted" },
            { cellId: "c2", fileId: "f1", ref: "MRK 1:2", source: "As it is written", target: "", status: "untranslated" },
          ],
        },
      },
      { type: "done", runId: "run-r", status: "ok" },
    ]
    agentSessionStore(PROJECT, "alice").send({ wire: "show me mark 1", display: "show me mark 1", jwt: "jwt", request: { projectId: PROJECT } })
    await waitFor(() => expect(agentSessionStore(PROJECT, "alice").getState().isStreaming).toBe(false))

    render(<AgentWorkbench {...workbenchProps()} />)
    expect(screen.queryByRole("tab", { name: "Review drafts" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("tab", { name: "Document" }))
    expect(screen.getByText("beginning", { selector: "strong" })).toBeInTheDocument()
    expect(screen.getByText("inizio", { selector: "em" })).toBeInTheDocument()
  })
})

describe("AgentWorkbench review loop", () => {
  it("navigates back to the editor without stopping or resetting the shared chat", async () => {
    vi.mocked(runAgent).mockImplementationOnce(({ onFrame, signal }) => {
      onFrame({ type: "run_start", runId: "navigation-run" })
      if (!signal) throw new Error("Expected the session store's abort signal")
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    })
    const store = agentSessionStore(PROJECT, "alice")
    store.send({ wire: "continue working", display: "continue working", jwt: "jwt", request: { projectId: PROJECT } })
    const before = store.getState()
    try {
      render(<AgentWorkbench {...workbenchProps()} />)
      const back = screen.getByRole("link", { name: "Back to editor" })
      expect(back).toHaveAttribute("href", `/project/${PROJECT}/editor/file/f1?lane=it`)
      fireEvent.click(back)
      expect(await screen.findByText("Editor destination")).toBeInTheDocument()
      expect(screen.getByTestId("workbench-location")).toHaveTextContent(`/project/${PROJECT}/editor/file/f1?lane=it`)
      expect(store.getState().sessionId).toBe(before.sessionId)
      expect(store.getState().runs).toEqual(before.runs)
      expect(store.getState().isStreaming).toBe(true)
    } finally {
      store.stop()
      await waitFor(() => expect(store.getState().isStreaming).toBe(false))
    }
  })

  it("confirms chat reset without undoing or deleting already-applied events", async () => {
    await primeSessionWithDraftRun()
    const props = workbenchProps()
    const onApplied = vi.fn<NonNullable<AgentWorkbenchProps["agent"]["onApplied"]>>()
    props.agent.onApplied = onApplied
    render(<AgentWorkbench {...props} />)
    fireEvent.click(screen.getByRole("tab", { name: "Review drafts" }))
    fireEvent.click(screen.getByRole("button", { name: /Accept remaining/ }))
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getAllByText("✓ accepted")).toHaveLength(2))

    const store = agentSessionStore(PROJECT, "alice")
    const before = store.getState()
    const appliedIds = onApplied.mock.calls[0][0]
    const appliedRecords = await getOutboxRecords(appliedIds)
    expect(appliedRecords).toHaveLength(2)
    const eventCount = await outboxRecordCountAllOwners()
    expect(before.decided.size).toBe(2)

    fireEvent.click(screen.getByRole("button", { name: "Chat options" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reset chat…" }))
    let dialog = await screen.findByRole("alertdialog", { name: "Reset chat?" })
    expect(store.getState().sessionId).toBe(before.sessionId)
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(store.getState().runs).toEqual(before.runs)
    expect(store.getState().decided).toEqual(before.decided)

    fireEvent.click(screen.getByRole("button", { name: "Chat options" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reset chat…" }))
    dialog = await screen.findByRole("alertdialog", { name: "Reset chat?" })
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset chat" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole("button", { name: "Chat options" })).toHaveFocus())
    expect(store.getState().sessionId).not.toBe(before.sessionId)
    expect(store.getState().runs).toEqual([])
    expect(store.getState().decided.size).toBe(0)
    expect(await getOutboxRecords(appliedIds)).toEqual(appliedRecords)
    expect(await outboxRecordCountAllOwners()).toBe(eventCount)
    expect(screen.getByRole("tab", { name: "Review drafts" })).toHaveAttribute("aria-selected", "true")
  })

  it.each(["project", "account"])("dismisses reset confirmation when its %s changes", async (scope) => {
    await primeSessionWithDraftRun()
    const props = workbenchProps()
    const view = render(<AgentWorkbench {...props} />)
    const before = agentSessionStore(PROJECT, "alice").getState()
    fireEvent.click(screen.getByRole("button", { name: "Chat options" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reset chat…" }))
    expect(await screen.findByRole("alertdialog", { name: "Reset chat?" })).toBeInTheDocument()

    const next = workbenchProps()
    if (scope === "project") next.agent.projectId = `${PROJECT}-other`
    else next.agent.author = "bob"
    view.rerender(<AgentWorkbench {...next} />)
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(agentSessionStore(PROJECT, "alice").getState().sessionId).toBe(before.sessionId)
    expect(agentSessionStore(PROJECT, "alice").getState().runs).toEqual(before.runs)
  })

  it("accept-all keeps the committed text visible in the grid (regression: rows went blank)", async () => {
    await primeSessionWithDraftRun()
    render(<AgentWorkbench {...workbenchProps()} />)
    fireEvent.click(screen.getByRole("tab", { name: "Review drafts" }))

    // Both drafts pending in the grid.
    expect(screen.getByText("La casa è rossa")).toBeInTheDocument()
    expect(screen.getByText("Il cane dorme")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /Accept remaining/ }))

    // After apply: rows are decided, and the text they committed MUST still
    // be there — a blank grid right after accepting is the reported bug.
    await waitFor(() => expect(screen.getAllByText("✓ accepted")).toHaveLength(2))
    expect(screen.getByText("La casa è rossa")).toBeInTheDocument()
    expect(screen.getByText("Il cane dorme")).toBeInTheDocument()
    expect(screen.queryByText("∅", { selector: ".flex.min-w-0 *" })).not.toBeInTheDocument()
  })

  it("undo flips accepted rows to undone and restores the pre-draft value", async () => {
    await primeSessionWithDraftRun()
    render(<AgentWorkbench {...workbenchProps()} />)
    fireEvent.click(screen.getByRole("tab", { name: "Review drafts" }))

    fireEvent.click(screen.getByRole("button", { name: /Accept remaining/ }))
    await waitFor(() => expect(screen.getAllByText("✓ accepted")).toHaveLength(2))

    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }))
    fireEvent.click(await screen.findByRole("button", { name: /Undo applied/ }))
    fireEvent.click(screen.getByRole("tab", { name: "Review drafts" }))
    await waitFor(() => expect(screen.getAllByText("↩ undone")).toHaveLength(2))
    // Pre-draft value was empty → the drafted text is gone from the rows.
    expect(screen.queryByText("La casa è rossa")).not.toBeInTheDocument()
  })
})

describe("AgentWorkbench unified view navigation", () => {
  it("reselecting the same sidebar task exits another view and restores that conversation", async () => {
    vi.mocked(fetchContextualRuns).mockResolvedValue({
      available: true, truncated: false, nextCursor: null,
      runs: [{
        runId: "task-1", fileId: "f1", status: "parked", phase: null,
        spanLabel: "MRK 1:1–1:2", done: 2, total: 2, failed: 0,
        unitsSpent: 0, callsSpent: 0, proposedDrafts: 2, targetLang: "it",
        activeDirections: [], lastError: null,
        createdAt: "2026-09-15T12:00:00Z", updatedAt: "2026-09-15T12:00:00Z",
      }],
    })
    const props = workbenchProps()
    const fileNames = new Map([["f1", "Mark"]])
    render(<>
      <AgentDockPanel projectId={PROJECT} author="alice" fileNames={fileNames} />
      <AgentWorkbench {...props} fileNames={fileNames} />
    </>)
    const list = await screen.findByTestId("team-conversation-list")
    fireEvent.click(await within(list).findByRole("button", { name: /Mark/ }))
    expect(await screen.findByRole("heading", { name: "Mark" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("tab", { name: "Project knowledge" }))
    expect(screen.getByTestId("workbench-location")).toHaveTextContent("view=knowledge")
    fireEvent.click(within(list).getByRole("button", { name: /Mark/ }))
    expect(screen.getByRole("tab", { name: "Conversation" })).toHaveAttribute("aria-selected", "true")
    expect(await screen.findByRole("heading", { name: "Mark" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Review 2 drafts" })).toBeInTheDocument()
    expect(screen.getByTestId("workbench-location")).not.toHaveTextContent("view=")
    expect(within(list).getByRole("button", { name: /Mark/ })).toHaveAttribute("aria-current", "true")
  })
  it("lets the conversation headline identify the workspace without repeated Agent labels", async () => {
    render(<AgentWorkbench {...workbenchProps()} />)
    const teamTab = screen.getByRole("tab", { name: "Conversation" })
    const toolbar = teamTab.closest("[role=tablist]")!.parentElement!

    fireEvent.click(teamTab)
    expect(await screen.findByRole("heading", { name: "Team chat", level: 2 })).toBeInTheDocument()
    expect(within(toolbar).queryByText("Agent", { exact: true })).not.toBeInTheDocument()
    expect(within(toolbar).getByRole("tab", { name: "Document" })).toBeInTheDocument()
    expect(within(toolbar).getByRole("tab", { name: "Project knowledge" })).toBeInTheDocument()
    expect(within(toolbar).getByRole("button", { name: "Chat options" })).toBeInTheDocument()
    expect(within(toolbar).queryByRole("button", { name: /New session/ })).not.toBeInTheDocument()
    expect(within(toolbar).getByRole("link", { name: "Back to editor" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("tab", { name: "Document" }))
    expect(within(toolbar).queryByText("Agent", { exact: true })).not.toBeInTheDocument()
    expect(screen.getByText("beginning", { selector: "strong" })).toBeInTheDocument()
  })

  it("defaults to Conversation and deep-links the lazy-loaded knowledge view", async () => {
    render(<AgentWorkbench {...workbenchProps()} />)

    const chatTab = screen.getByRole("tab", { name: "Conversation" })
    expect(chatTab).toHaveAttribute("aria-selected", "true")
    const memoryTab = screen.getByRole("tab", { name: "Project knowledge" })
    expect(memoryTab).toHaveAttribute("aria-selected", "false")

    const header = chatTab.closest("[role=tablist]")?.parentElement
    expect(header).not.toBeNull()
    expect(within(header!).queryByText("Agent", { exact: true })).not.toBeInTheDocument()
    expect(within(header!).getByRole("button", { name: "Chat options" })).toBeInTheDocument()
    expect(within(header!).getByRole("link", { name: "Back to editor" })).toBeInTheDocument()

    fireEvent.click(memoryTab)
    await waitFor(() => expect(memoryTab).toHaveAttribute("aria-selected", "true"))
    expect(screen.getByTestId("workbench-location")).toHaveTextContent("view=knowledge")
    // The Memory tab lazy-loads W1E's real AgentMemoryTab (Wave-2 seam): once
    // resolved it renders its own Proposed/Approved/Project-brief sub-tabs.
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Proposed/ })).toBeInTheDocument(),
    )
  })
})
