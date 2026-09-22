import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import {
  composerDraftKey, composerDraftStore, createComposerDraftStore, resetComposerDraftsForTesting,
} from "@/lib/agent/composer-drafts"
import type { AgentSendOptions, AgentSessionState } from "@/lib/agent/session-store"
import type { UploadedArtifact } from "@/lib/agent/protocol"
import type { AgentRunUi } from "@/lib/agent/run-state"
import { serializeDocJSON } from "@/lib/agent/context-chip"
import { t } from "@/lib/i18n/standalone"
import { AgentDockView, type AgentDockViewProps } from "./AgentDockView"

const send = vi.fn<(options: AgentSendOptions) => void>()
const state: AgentSessionState = {
  sessionId: "session", runs: [], isStreaming: false, queued: [], decided: new Map(), activity: [],
}
vi.mock("@/lib/agent/session-store", () => ({
  useAgentSession: () => ({ state, send, stop: vi.fn(), noteActivity: vi.fn() }),
}))
vi.mock("@/lib/agent/artifact-upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/artifact-upload")>()
  return { ...actual, uploadAgentArtifact: vi.fn() }
})
vi.mock("./AgentEmptyState", () => ({
  AgentEmptyState: ({ onPromptSelect }: { onPromptSelect: (text: string) => void }) => (
    <div data-testid="empty-state">
      <button onClick={() => onPromptSelect("Unsent Team chat <literal>")}>Use example prompt</button>
    </div>
  ),
}))
vi.mock("./AgentRunView", () => ({
  AgentRunView: ({ run }: { run: AgentRunUi }) => <div data-testid="session-run">{run.prompt}</div>,
}))

const { uploadAgentArtifact } = await import("@/lib/agent/artifact-upload")
const upload = vi.mocked(uploadAgentArtifact)
const scope = { owner: "alice", projectId: "project", conversationId: "team-chat" }
const props: AgentDockViewProps = {
  projectId: "project", jwt: "private-session-jwt", author: "alice", roleLevel: 100,
  context: { fileId: "file", cellId: "cell" }, rules: [],
}
const artifact = (name: string): UploadedArtifact => ({
  artifactId: `artifact-${name}`, fileName: name, sizeBytes: 10, sha256: "hash",
})
function chooseFile(container: HTMLElement, name: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  expect(input).not.toBeNull()
  fireEvent.change(input!, { target: { files: [new File(["notes"], name, { type: "text/plain" })] } })
}
const typePrompt = () => fireEvent.click(screen.getByRole("button", { name: "Use example prompt" }))
const submit = () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  resetComposerDraftsForTesting()
  state.runs = []
  upload.mockImplementation(async (_jwt, _projectId, file) => artifact(file.name))
})

describe("AgentDockView shared Team chat", () => {
  it("preserves its normal first-run empty state when no prelude or session runs exist", () => {
    render(<AgentDockView {...props} />)
    expect(screen.getByTestId("empty-state")).toBeInTheDocument()
  })

  it("uses the stable localized composer hint with no rotation timer, before and after conversation content arrives", () => {
    const scheduleInterval = vi.spyOn(window, "setInterval")
    try {
      const view = render(<AgentDockView {...props} />)
      expect(screen.getByText(t("agent.dock.composerPlaceholder"))).toBeInTheDocument()
      expect(scheduleInterval).not.toHaveBeenCalled()
      view.rerender(<AgentDockView {...props} conversationPrelude={<div>Contextual dispatch</div>} />)
      expect(screen.getByText(t("agent.dock.composerPlaceholder"))).toBeInTheDocument()
      state.runs = [{ localId: "run", runId: null, prompt: "Session prompt", items: [], status: "ok" }]
      view.rerender(<AgentDockView {...props} />)
      expect(screen.getByText(t("agent.dock.composerPlaceholder"))).toBeInTheDocument()
    } finally {
      scheduleInterval.mockRestore()
    }
  })

  it("renders a prelude inside the message scroller instead of a competing first-run state", () => {
    render(<AgentDockView {...props} conversationPrelude={<div>Contextual dispatch</div>} />)
    expect(screen.getByText("Contextual dispatch").closest('[data-slot="message-scroller-content"]')).not.toBeNull()
    expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument()
    expect(screen.getByRole("textbox")).toBeInTheDocument()
  })

  it("renders the prelude ahead of existing session runs in the same scroller", () => {
    state.runs = [{ localId: "run", runId: null, prompt: "Session prompt", items: [], status: "ok" }]
    const { container } = render(<AgentDockView {...props} conversationPrelude={<div>Contextual dispatch</div>} />)
    const content = container.querySelector('[data-slot="message-scroller-content"]')
    expect(content?.textContent).toMatch(/Contextual dispatch.*Session prompt/)
  })

  it("reloads typed prose, exact context chips and attachments, then hands their real composed payload to the session", async () => {
    const chip = {
      chipId: "selection", fileId: "source-file", cellId: "source-cell", side: "source" as const,
      selection: "<exact>\nsource & words", preview: "<exact> source & words", canonicalRef: "GEN 1:1", fileName: "Genesis.usfm",
    }
    const first = render(<AgentDockView {...props} pendingChip={chip} onPendingChipConsumed={vi.fn()} />)
    typePrompt()
    chooseFile(first.container, "notes.txt")
    expect(await screen.findByText("notes.txt")).toBeInTheDocument()
    const saved = composerDraftStore(scope).getSnapshot()
    expect(localStorage.getItem(composerDraftKey(scope))).not.toContain("private-session-jwt")
    first.unmount()
    resetComposerDraftsForTesting()
    render(<AgentDockView {...props} />)
    expect(screen.getByRole("textbox")).toHaveTextContent("Unsent Team chat <literal>")
    expect(screen.getByText("notes.txt")).toBeInTheDocument()
    expect(composerDraftStore(scope).getSnapshot().document).toEqual(saved.document)
    submit()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      wire: expect.stringContaining("<exact>\nsource & words"),
      display: expect.stringContaining("[GEN 1:1]"),
      request: expect.objectContaining({
        projectId: "project", context: { fileId: "file", cellId: "cell" },
        artifacts: [{ artifactId: "artifact-notes.txt", fileName: "notes.txt" }],
      }),
    }))
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument()
    expect(serializeDocJSON(createComposerDraftStore(scope).getSnapshot().document).text).toBe("")
    expect(createComposerDraftStore(scope).getSnapshot().attachments).toEqual([])
  })

  it("does not expose another owner's or project's text or attachments on rerender", async () => {
    const view = render(<AgentDockView {...props} />)
    typePrompt()
    chooseFile(view.container, "alice-private.txt")
    await screen.findByText("alice-private.txt")
    view.rerender(<AgentDockView {...props} author="bob" />)
    expect(screen.getByRole("textbox")).not.toHaveTextContent("Unsent Team chat")
    expect(screen.queryByText("alice-private.txt")).not.toBeInTheDocument()
    view.rerender(<AgentDockView {...props} projectId="elsewhere" />)
    expect(screen.getByRole("textbox")).not.toHaveTextContent("Unsent Team chat")
    expect(screen.queryByText("alice-private.txt")).not.toBeInTheDocument()
    view.rerender(<AgentDockView {...props} />)
    expect(screen.getByRole("textbox")).toHaveTextContent("Unsent Team chat")
    expect(screen.getByText("alice-private.txt")).toBeInTheDocument()
  })

  it("routes a late upload completion to its original owner after account switching", async () => {
    let resolveUpload!: (value: UploadedArtifact) => void
    upload.mockImplementationOnce(() => new Promise<UploadedArtifact>((resolve) => { resolveUpload = resolve }))
    const view = render(<AgentDockView {...props} />)
    chooseFile(view.container, "alice-private.txt")
    view.rerender(<AgentDockView {...props} author="bob" jwt="bob-jwt" />)
    chooseFile(view.container, "bob-notes.txt")
    await screen.findByText("bob-notes.txt")
    await act(async () => resolveUpload(artifact("alice-private.txt")))
    expect(screen.queryByText("alice-private.txt")).not.toBeInTheDocument()
    expect(screen.getByText("bob-notes.txt")).toBeInTheDocument()
    view.rerender(<AgentDockView {...props} />)
    expect(screen.getByText("alice-private.txt")).toBeInTheDocument()
    expect(screen.queryByText("bob-notes.txt")).not.toBeInTheDocument()
    expect(upload).toHaveBeenNthCalledWith(1, "private-session-jwt", "project", expect.any(File))
    expect(upload).toHaveBeenNthCalledWith(2, "bob-jwt", "project", expect.any(File))
  })

  it("reports a late upload failure only in the scope that selected the file", async () => {
    let rejectUpload!: (error: Error) => void
    upload.mockImplementationOnce(() => new Promise<UploadedArtifact>((_resolve, reject) => { rejectUpload = reject }))
    const view = render(<AgentDockView {...props} />)
    chooseFile(view.container, "alice-private.txt")
    view.rerender(<AgentDockView {...props} author="bob" jwt="bob-jwt" />)
    await act(async () => rejectUpload(new Error("upload failed")))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    view.rerender(<AgentDockView {...props} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Could not attach")
    expect(composerDraftStore(scope).getSnapshot().attachments).toEqual([])
  })

  it("clears only the sent attachment batch, preserving an upload that completes afterward", async () => {
    const view = render(<AgentDockView {...props} />)
    typePrompt()
    chooseFile(view.container, "sent.txt")
    await screen.findByText("sent.txt")
    let resolveUpload!: (value: UploadedArtifact) => void
    upload.mockImplementationOnce(() => new Promise<UploadedArtifact>((resolve) => { resolveUpload = resolve }))
    chooseFile(view.container, "later.txt")
    submit()
    expect(send.mock.calls[0][0].request.artifacts).toEqual([{ artifactId: "artifact-sent.txt", fileName: "sent.txt" }])
    await act(async () => resolveUpload(artifact("later.txt")))
    expect(screen.queryByText("sent.txt")).not.toBeInTheDocument()
    expect(screen.getByText("later.txt")).toBeInTheDocument()
    expect(createComposerDraftStore(scope).getSnapshot().attachments).toEqual([
      { artifactId: "artifact-later.txt", fileName: "later.txt" },
    ])
  })

  it("retains both the document and attachment batch if the session rejects the handoff", async () => {
    send.mockImplementationOnce(() => { throw new Error("handoff failed") })
    const view = render(<AgentDockView {...props} />)
    typePrompt()
    chooseFile(view.container, "keep.txt")
    await screen.findByText("keep.txt")
    submit()
    expect(screen.getByRole("alert")).toHaveTextContent("Could not send")
    expect(screen.getByRole("textbox")).toHaveTextContent("Unsent Team chat")
    expect(screen.getByText("keep.txt")).toBeInTheDocument()
    expect(createComposerDraftStore(scope).getSnapshot().attachments).toHaveLength(1)
    submit()
    expect(screen.queryByText("keep.txt")).not.toBeInTheDocument()
    expect(serializeDocJSON(createComposerDraftStore(scope).getSnapshot().document).text).toBe("")
  })

  it("persists explicit attachment removal without changing the unsent document", async () => {
    const view = render(<AgentDockView {...props} />)
    typePrompt()
    chooseFile(view.container, "remove.txt")
    await screen.findByText("remove.txt")
    fireEvent.click(screen.getByRole("button", { name: /remove.*remove.txt/i }))
    await waitFor(() => expect(screen.queryByText("remove.txt")).not.toBeInTheDocument())
    expect(createComposerDraftStore(scope).getSnapshot().attachments).toEqual([])
    expect(serializeDocJSON(createComposerDraftStore(scope).getSnapshot().document).text).toContain("Unsent Team chat")
  })
})
