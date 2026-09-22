import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, useSearchParams } from "react-router-dom"
import { Editor } from "@tiptap/core"
import type { ContextualRunRecord } from "@/lib/contextual/transport"
import { composerDraftStore, createComposerDraftStore, resetComposerDraftsForTesting } from "@/lib/agent/composer-drafts"
import { serializeDocJSON } from "@/lib/agent/context-chip"
import { TeamThreadsView } from "./TeamThreadsView"
import { AgentDockView } from "./AgentDockView"

const run: ContextualRunRecord = {
  runId: "run-1", fileId: "file-1", status: "running", phase: "drafting", spanLabel: "GEN 1:1",
  done: 1, total: 4, failed: 0, unitsSpent: 2, callsSpent: 5, lastError: null,
  createdAt: "2026-09-15T11:00:00Z", updatedAt: "2026-09-15T12:00:00Z",
  activeDirections: [], proposedDrafts: 11, targetLang: "",
}
const runs = [run]
const sessionState = { runs: [], queued: [], isStreaming: false }
const send = vi.fn()
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "alice" }, loading: false }),
}))
vi.mock("@/lib/agent/session-store", () => ({
  useAgentSession: () => ({ state: sessionState, send, stop: vi.fn(), noteActivity: vi.fn() }),
}))
vi.mock("@/lib/agent/team-conversations", () => ({
  useTeamConversations: () => ({
    runs, decisions: { decisions: [], openCount: 0, cap: 3 }, loadFailed: false, retry: vi.fn(),
  }),
}))
vi.mock("@/lib/contextual/transport", () => ({
  fetchContextualRunActivity: vi.fn(async () => ({
    run: null, events: [], sceneBriefs: [], drafts: [], truncated: false,
    truncatedCollections: { events: false, sceneBriefs: false, drafts: false },
    draftCounts: { proposed: 11, applied: 0, rejected: 0, superseded: 0 }, draftNextCursor: null,
  })),
  sendContextualSteering: vi.fn(),
  startFileContextualRun: vi.fn(),
  actOnContextualDecision: vi.fn(),
}))
vi.mock("./TeamThreadDetail", () => ({
  TeamThreadDetail: () => <div>Task activity</div>,
}))
vi.mock("./AgentEmptyState", () => ({
  AgentEmptyState: () => <div>Start Team chat</div>,
}))

const scope = { owner: "alice", projectId: "project", conversationId: "run:run-1" }
function Workspace() {
  const [params, setParams] = useSearchParams()
  const select = (conversation: string) => setParams({ conversation })
  return (
    <>
      <nav>
        <button onClick={() => setParams({ conversation: scope.conversationId, view: "knowledge" })}>Project knowledge</button>
        <button onClick={() => select(scope.conversationId)}>Selected task</button>
        <button onClick={() => select("team-chat")}>Pinned Team chat</button>
      </nav>
      <output aria-label="Current route">{params.toString()}</output>
      {params.get("view") === "knowledge" ? <div>Knowledge content</div> : (
        <TeamThreadsView
          author={scope.owner} projectId={scope.projectId} jwt="jwt" roleLevel={100}
          renderChannel={() => (
            <AgentDockView
              author={scope.owner} projectId={scope.projectId} jwt="jwt" roleLevel={100}
              context={{}} rules={[]} conversationPrelude={<div>Contextual dispatch</div>}
            />
          )}
        />
      )}
    </>
  )
}

function activeEditor(): Editor {
  const textbox = screen.getByRole("textbox", { name: "Ask the agent" })
  if (!("editor" in textbox) || !(textbox.editor instanceof Editor)) throw new Error("Missing TipTap editor")
  return textbox.editor
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  resetComposerDraftsForTesting()
})

describe("URL-selected task / full Team chat draft boundary", () => {
  it("restores a native-input task draft after knowledge and pinned Team chat without sending", async () => {
    const marker = "Unsent Safari UX regression check"
    render(<MemoryRouter initialEntries={["/project/project/agent?conversation=run%3Arun-1"]}><Workspace /></MemoryRouter>)
    const textbox = await screen.findByRole("textbox", { name: "Ask the agent" })
    const paragraph = textbox.querySelector("p")!
    paragraph.append(document.createTextNode(marker))
    fireEvent.input(textbox, { inputType: "insertText", data: marker })
    await waitFor(() => expect(serializeDocJSON(composerDraftStore(scope).getSnapshot().document).text).toBe(marker))
    const firstEditor = activeEditor()
    fireEvent.click(screen.getByRole("button", { name: "Project knowledge" }))
    await waitFor(() => expect(firstEditor.isDestroyed).toBe(true))
    fireEvent.click(screen.getByRole("button", { name: "Selected task" }))
    expect(await screen.findByRole("textbox")).toHaveTextContent(marker)
    const restoredEditor = activeEditor()
    fireEvent.click(screen.getByRole("button", { name: "Pinned Team chat" }))
    await waitFor(() => expect(restoredEditor.isDestroyed).toBe(true))
    expect(screen.getByRole("textbox")).not.toHaveTextContent(marker)
    expect(serializeDocJSON(composerDraftStore(scope).getSnapshot().document).text).toBe(marker)
    const channelEditor = activeEditor()
    fireEvent.click(screen.getByRole("button", { name: "Selected task" }))
    await waitFor(() => expect(channelEditor.isDestroyed).toBe(true))
    expect(screen.getByRole("textbox")).toHaveTextContent(marker)
    expect(serializeDocJSON(activeEditor().getJSON()).text).toBe(marker)
    expect(serializeDocJSON(createComposerDraftStore(scope).getSnapshot().document).text).toBe(marker)
    expect(screen.getByLabelText("Current route")).toHaveTextContent("conversation=run%3Arun-1")
    expect(send).not.toHaveBeenCalled()
  })
})
