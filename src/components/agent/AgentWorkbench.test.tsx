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

import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import type { Editor } from "@tiptap/core"
import type { AgentFrame } from "@/lib/agent/protocol"

// Stub the chat rail but keep the workbench seam: render each proposal
// through renderProposalOverride so the RECEIPT (counters + Undo) is real.
vi.mock("./AgentDockView", async () => {
  const { agentSessionStore: storeOf } = await import("@/lib/agent/session-store")
  const { proposalsOf } = await import("@/lib/agent/run-state")
  return {
    AgentDockView: (props: {
      projectId: string
      renderProposalOverride?: (p: unknown) => unknown
    }) => (
      <>
        {storeOf(props.projectId)
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
import { AgentWorkbench, type AgentWorkbenchProps } from "./AgentWorkbench"

const PROJECT = `wb-test-${Math.random().toString(36).slice(2)}`

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
      currentCell: null,
      rules: [],
      resolveCell: () => undefined,
      onApplied: vi.fn(),
    },
    onClose: () => {},
    onChooseFile: vi.fn(),
    workspace: {
      fileName: "Mark.md",
      sourceLanguage: "English",
      targetLanguage: "Italian",
      focusedCellId: "c1",
      totalCells: 2,
      cells: [
        { cellId: "c1", fileId: "f1", ref: "MRK 1:1", source: "The beginning", target: "L'inizio", status: "unvalidated" },
        { cellId: "c2", fileId: "f1", ref: "MRK 1:2", source: "As it is written", target: "", status: "empty" },
      ],
    },
  }
}

async function primeSessionWithDraftRun(): Promise<void> {
  scriptedFrames = draftRunFrames()
  agentSessionStore(PROJECT).send({
    wire: "draft this file",
    display: "draft this file",
    jwt: "jwt",
    request: { projectId: PROJECT },
  })
  await waitFor(() => expect(agentSessionStore(PROJECT).getState().isStreaming).toBe(false))
}

beforeEach(() => {
  agentSessionStore(PROJECT).reset()
  window.localStorage.clear()
})

describe("AgentWorkbench three-pane layout", () => {
  it("keeps source, Agent, and target visible before the first prompt", () => {
    render(<AgentWorkbench {...workbenchProps()} />)
    expect(screen.getByLabelText("Source pane")).toBeInTheDocument()
    expect(screen.getByLabelText("Agent pane")).toBeInTheDocument()
    expect(screen.getByLabelText("Target pane")).toBeInTheDocument()
    expect(screen.getByText("The beginning")).toBeInTheDocument()
    expect(screen.getByText("L'inizio")).toBeInTheDocument()
    expect(screen.getAllByRole("separator")).toHaveLength(2)
  })

  it("shows the active filename once in the workbench chrome", () => {
    render(<AgentWorkbench {...workbenchProps()} />)
    expect(screen.getAllByText("Mark.md")).toHaveLength(1)
  })

  it("turns the target pane into the existing review editor when the agent stages drafts", async () => {
    await primeSessionWithDraftRun()
    render(<AgentWorkbench {...workbenchProps()} />)
    expect(screen.getByLabelText("Target review pane")).toBeInTheDocument()
    expect(screen.getByLabelText("Source pane")).toHaveTextContent("The house is red")
    // Source has its own stable pane, so review rows do not duplicate it.
    expect(screen.getByLabelText("Target review pane")).not.toHaveTextContent("The house is red")
  })

  it("a read-only run leaves the workspace context in place", async () => {
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
    agentSessionStore(PROJECT).send({ wire: "show me mark 1", display: "show me mark 1", jwt: "jwt", request: { projectId: PROJECT } })
    await waitFor(() => expect(agentSessionStore(PROJECT).getState().isStreaming).toBe(false))

    render(<AgentWorkbench {...workbenchProps()} />)
    expect(screen.getByLabelText("Source pane")).toHaveTextContent("The beginning")
    expect(screen.getByLabelText("Target pane")).toHaveTextContent("L'inizio")
  })

  it("keeps the header focused on session actions while panes remain manually resizable", () => {
    render(<AgentWorkbench {...workbenchProps()} />)
    const toolbar = screen.getByRole("group", { name: "Agent workbench toolbar" })
    expect(within(toolbar).getByRole("tab", { name: "Sessions" })).toBeInTheDocument()
    expect(within(toolbar).getByRole("tab", { name: "Memory" })).toBeInTheDocument()
    expect(within(toolbar).getByRole("button", { name: "New session" })).toBeInTheDocument()
    expect(within(toolbar).getByRole("button", { name: "Close workbench" })).toHaveTextContent("Editor")
    expect(within(screen.getByLabelText("Agent pane")).getByRole("button", { name: "Change agent file" }))
      .toHaveTextContent("Change file")
    expect(screen.queryByRole("button", { name: /layout/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /source pane/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /target pane/i })).not.toBeInTheDocument()
    expect(screen.getAllByRole("separator")).toHaveLength(2)
  })

  it("reuses the translation editor and sends its rich snapshot through the workspace commit path", async () => {
    const props = workbenchProps()
    const onCommitTarget = vi.fn()
    props.workspace = { ...props.workspace!, editable: true, onCommitTarget }
    const { container } = render(<AgentWorkbench {...props} />)

    fireEvent.click(screen.getByRole("textbox", { name: "MRK 1:1 — unvalidated" }))
    await act(async () => { await Promise.resolve() })
    const editorSurface = container.querySelector(".ProseMirror") as HTMLElement & { editor?: Editor }
    expect(editorSurface).toHaveAttribute("contenteditable", "true")

    act(() => {
      editorSurface.editor?.commands.setContent("Workbench correction")
      fireEvent.blur(editorSurface)
    })
    await waitFor(() => expect(onCommitTarget).toHaveBeenCalledWith("c1", expect.objectContaining({
      value: "Workbench correction",
      valueHtml: expect.stringContaining("Workbench correction"),
    })))
  })
})

describe("AgentWorkbench review loop", () => {
  it("accept-all keeps the committed text visible in the grid (regression: rows went blank)", async () => {
    await primeSessionWithDraftRun()
    render(<AgentWorkbench {...workbenchProps()} />)

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

    fireEvent.click(screen.getByRole("button", { name: /Accept remaining/ }))
    await waitFor(() => expect(screen.getAllByText("✓ accepted")).toHaveLength(2))

    fireEvent.click(screen.getByRole("button", { name: /Undo applied/ }))
    await waitFor(() => expect(screen.getAllByText("↩ undone")).toHaveLength(2))
    // Pre-draft value was empty → the drafted text is gone from the rows.
    expect(screen.queryByText("La casa è rossa")).not.toBeInTheDocument()
  })
})

describe("AgentWorkbench Sessions | Memory tab slot (AQU-AGENT §5)", () => {
  it("defaults to the Sessions tab and offers a Memory tab that lazy-loads its content", async () => {
    render(<AgentWorkbench {...workbenchProps()} />)

    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true")
    const memoryTab = screen.getByRole("tab", { name: "Memory" })
    expect(memoryTab).toHaveAttribute("aria-selected", "false")

    fireEvent.click(memoryTab)
    await waitFor(() => expect(memoryTab).toHaveAttribute("aria-selected", "true"))
    // The Memory tab lazy-loads W1E's real AgentMemoryTab (Wave-2 seam): once
    // resolved it renders its own Proposed/Approved/Project-brief sub-tabs.
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Proposed/ })).toBeInTheDocument(),
    )
  })
})
