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
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
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
})

describe("AgentWorkbench layout (chat spine vs stage)", () => {
  it("an empty session is a single centered chat column — no empty grid", () => {
    render(<AgentWorkbench {...workbenchProps()} />)
    // No working-set stage until there's an artifact to review.
    expect(screen.queryByLabelText("Working set")).toBeNull()
    expect(screen.queryByText(/cells the agent reads and drafts appear here/)).toBeNull()
  })

  it("summons the working-set stage once the run surfaces rows", async () => {
    await primeSessionWithDraftRun()
    render(<AgentWorkbench {...workbenchProps()} />)
    expect(screen.getByLabelText("Working set")).toBeInTheDocument()
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
