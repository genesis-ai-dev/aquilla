import { createRef, StrictMode } from "react"
import { Editor } from "@tiptap/core"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ChatComposerHandle, ChatComposerProps } from "@/components/chat/ChatComposer"
import { composerDraftStore, createComposerDraftStore, resetComposerDraftsForTesting } from "@/lib/agent/composer-drafts"
import { serializeDocJSON } from "@/lib/agent/context-chip"
import { TeamChannelComposer, type TeamChannelComposerProps, type TeamComposerThread } from "./TeamChannelComposer"
import type { ContextualSteeringResult } from "@/lib/contextual/transport"
import { AgentDockView } from "./AgentDockView"

// Only expose the handle for input; editing, JSON persistence and send are the
// real TipTap composer, not a synthetic textarea implementation.
const composer = createRef<ChatComposerHandle>()
vi.mock("@/components/chat/ChatComposer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/chat/ChatComposer")>()
  return { ...actual, ChatComposer: (props: ChatComposerProps) => <actual.ChatComposer {...props} ref={composer} /> }
})

vi.mock("@/lib/contextual/transport", () => ({
  sendContextualSteering: vi.fn(),
  startFileContextualRun: vi.fn(),
}))
vi.mock("@/lib/agent/session-store", () => ({
  useAgentSession: () => ({
    state: { runs: [], queued: [], isStreaming: false },
    send: vi.fn(), stop: vi.fn(), noteActivity: vi.fn(),
  }),
}))
vi.mock("./AgentEmptyState", () => ({
  AgentEmptyState: () => <div>Start Team chat</div>,
}))
const { sendContextualSteering, startFileContextualRun } = await import("@/lib/contextual/transport")
const steer = vi.mocked(sendContextualSteering)
// AQU-1299: the server routes each message and answers with what it did.
const STEERED: ContextualSteeringResult = { intent: "direction", applied: true, run: null }
const start = vi.mocked(startFileContextualRun)
const scope = { owner: "alice", projectId: "project", conversationId: "run:1" }
const thread: TeamComposerThread = { runId: "1", personaId: "drafter", scopeLabel: "GEN 1", steerable: true }
const props = (): TeamChannelComposerProps => ({
  draftScope: scope, thread, isConfigured: true, isStreaming: false, onStop: vi.fn(), onSendToChannel: vi.fn(),
})
const type = (text: string) => act(() => composer.current!.insertText(text))
const submit = () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
function activeEditor(surface?: HTMLElement): Editor {
  const textbox = (surface ? within(surface) : screen).getByRole("textbox")
  if (!("editor" in textbox) || !(textbox.editor instanceof Editor)) throw new Error("Missing TipTap editor")
  return textbox.editor
}
function appendNativeText(surface: HTMLElement, text: string) {
  const textbox = within(surface).getByRole("textbox")
  const paragraph = textbox.querySelector("p")!
  paragraph.append(document.createTextNode(text))
  fireEvent.input(textbox, { inputType: "insertText", data: text })
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  localStorage.clear()
  resetComposerDraftsForTesting()
  steer.mockResolvedValue(STEERED)
})

describe("TeamChannelComposer draft ownership", () => {
  it("keeps task and full Team chat drafts isolated while outgoing and incoming consumers overlap", async () => {
    const base = props()
    const channelScope = { ...scope, conversationId: "team-chat" }
    const surfaces = (task: boolean, channel: boolean) => (
      <div>
        {task && <section key="task" aria-label="Task draft"><TeamChannelComposer {...base} /></section>}
        {channel && <section key="channel" aria-label="Team chat draft">
          <AgentDockView
            author={scope.owner} projectId={scope.projectId} jwt="jwt" roleLevel={100}
            context={{}} rules={[]} conversationPrelude={<div>Contextual dispatch</div>}
          />
        </section>}
      </div>
    )
    const view = render(surfaces(true, false))
    const outgoingTask = screen.getByRole("region", { name: "Task draft" })
    const taskEditor = activeEditor(outgoingTask)
    appendNativeText(outgoingTask, "Unsent task marker")
    await waitFor(() => expect(serializeDocJSON(composerDraftStore(scope).getSnapshot().document).text).toBe("Unsent task marker"))

    view.rerender(surfaces(true, true))
    const channel = screen.getByRole("region", { name: "Team chat draft" })
    expect(within(channel).getByRole("textbox")).not.toHaveTextContent("Unsent task marker")
    appendNativeText(channel, "Separate unsent channel marker")
    await waitFor(() => expect(serializeDocJSON(composerDraftStore(channelScope).getSnapshot().document).text).toBe("Separate unsent channel marker"))
    expect(within(outgoingTask).getByRole("textbox")).toHaveTextContent("Unsent task marker")

    view.rerender(surfaces(false, true))
    await waitFor(() => expect(taskEditor.isDestroyed).toBe(true))
    expect(serializeDocJSON(createComposerDraftStore(scope).getSnapshot().document).text).toBe("Unsent task marker")
    const channelEditor = activeEditor(channel)
    view.rerender(surfaces(true, true))
    expect(within(screen.getByRole("region", { name: "Task draft" })).getByRole("textbox")).toHaveTextContent("Unsent task marker")
    expect(within(channel).getByRole("textbox")).toHaveTextContent("Separate unsent channel marker")

    view.rerender(surfaces(true, false))
    await waitFor(() => expect(channelEditor.isDestroyed).toBe(true))
    expect(screen.getByRole("textbox")).toHaveTextContent("Unsent task marker")
    expect(serializeDocJSON(createComposerDraftStore(channelScope).getSnapshot().document).text).toBe("Separate unsent channel marker")
    expect(steer).not.toHaveBeenCalled()
  })

  it("preserves newer input in an overlapping same-scope consumer after the outgoing sender unmounts", async () => {
    let resolveSend!: () => void
    steer.mockImplementationOnce(() => new Promise<ContextualSteeringResult>((resolve) => { resolveSend = () => resolve(STEERED) }))
    const base = props()
    const consumers = (names: string[]) => <div>{names.map((name) => (
      <section key={name} aria-label={name}><TeamChannelComposer {...base} /></section>
    ))}</div>
    const view = render(consumers(["Outgoing composer"]))
    const outgoing = screen.getByRole("region", { name: "Outgoing composer" })
    appendNativeText(outgoing, "Original direction")
    await waitFor(() => expect(serializeDocJSON(composerDraftStore(scope).getSnapshot().document).text).toBe("Original direction"))
    fireEvent.keyDown(within(outgoing).getByRole("textbox"), { key: "Enter" })
    const outgoingEditor = activeEditor(outgoing)

    view.rerender(consumers(["Outgoing composer", "Incoming composer"]))
    const incoming = screen.getByRole("region", { name: "Incoming composer" })
    expect(within(incoming).getByRole("textbox")).toHaveTextContent("Original direction")
    expect(within(incoming).getByRole("button", { name: "Send" })).toBeDisabled()
    appendNativeText(incoming, " plus newer input")
    await waitFor(() => expect(serializeDocJSON(composerDraftStore(scope).getSnapshot().document).text).toBe("Original direction plus newer input"))
    expect(within(outgoing).getByRole("textbox")).toHaveTextContent("Original direction plus newer input")

    view.rerender(consumers(["Incoming composer"]))
    await waitFor(() => expect(outgoingEditor.isDestroyed).toBe(true))
    await act(async () => resolveSend())
    expect(within(incoming).getByRole("textbox")).toHaveTextContent("Original direction plus newer input")
    expect(within(incoming).getByRole("button", { name: "Send" })).toBeEnabled()
    view.unmount()
    render(<TeamChannelComposer {...base} />)
    expect(screen.getByRole("textbox")).toHaveTextContent("Original direction plus newer input")
    expect(serializeDocJSON(createComposerDraftStore(scope).getSnapshot().document).text).toBe("Original direction plus newer input")
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])("preserves native input through task -> knowledge -> task -> AgentDockView -> task (strict=%s)", async (strict) => {
    const marker = "Unsent Safari UX regression check"
    const base = props()
    function Destination({ selected }: { selected: "task" | "knowledge" | "team-chat" }) {
      return (
        <main>
          {selected === "task" ? <TeamChannelComposer {...base} />
            : selected === "knowledge" ? <div>Project knowledge</div>
              : <AgentDockView
                  author={scope.owner} projectId={scope.projectId} jwt="jwt"
                  roleLevel={100} context={{}} rules={[]}
                  conversationPrelude={<div>Contextual dispatch</div>}
                />}
        </main>
      )
    }
    const destination = (selected: "task" | "knowledge" | "team-chat") => strict
      ? <StrictMode><Destination selected={selected} /></StrictMode>
      : <Destination selected={selected} />
    const view = render(destination("task"))
    // Safari execCommand changes the DOM, then ProseMirror's observer produces
    // the transaction. Do not bypass that producer with insertContent here.
    const textbox = screen.getByRole("textbox")
    const paragraph = textbox.querySelector("p")!
    paragraph.append(document.createTextNode(marker))
    fireEvent.input(textbox, { inputType: "insertText", data: marker })
    await waitFor(() => expect(serializeDocJSON(composerDraftStore(scope).getSnapshot().document).text).toBe(marker))
    const firstEditor = activeEditor()
    view.rerender(destination("knowledge"))
    await waitFor(() => expect(firstEditor.isDestroyed).toBe(true))
    view.rerender(destination("task"))
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent(marker))
    const restoredEditor = activeEditor()
    view.rerender(destination("team-chat"))
    await waitFor(() => expect(restoredEditor.isDestroyed).toBe(true))
    expect(screen.getByRole("textbox")).not.toHaveTextContent(marker)
    expect(serializeDocJSON(composerDraftStore(scope).getSnapshot().document).text).toBe(marker)
    const channelEditor = activeEditor()
    view.rerender(destination("task"))
    await waitFor(() => expect(channelEditor.isDestroyed).toBe(true))
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent(marker))
    expect(serializeDocJSON(createComposerDraftStore(scope).getSnapshot().document).text).toBe(marker)
    expect(steer).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it("preserves a typed run draft across unmount and keeps Team chat / other runs separate", () => {
    const base = props()
    const view = render(<TeamChannelComposer {...base} />)
    type("Draft persistence check (unsent)")
    view.rerender(<TeamChannelComposer {...base} thread={null} draftScope={{ ...scope, conversationId: "team-chat" }} />)
    expect(screen.getByRole("textbox")).not.toHaveTextContent("Draft persistence")
    type("Unsent Team chat")
    view.rerender(<TeamChannelComposer {...base} thread={{ ...thread, runId: "2" }} draftScope={{ ...scope, conversationId: "run:2" }} />)
    expect(screen.getByRole("textbox")).not.toHaveTextContent("Unsent Team chat")
    view.unmount()
    render(<TeamChannelComposer {...base} />)
    expect(screen.getByRole("textbox")).toHaveTextContent("Draft persistence check (unsent)")
  })

  it("retains failed steering and its inline error, then clears only after retry succeeds", async () => {
    steer.mockRejectedValueOnce(new Error("offline"))
    render(<TeamChannelComposer {...props()} />)
    type("Keep this direction")
    submit()
    expect(await screen.findByRole("alert")).toHaveTextContent("message")
    expect(screen.getByRole("textbox")).toHaveTextContent("Keep this direction")
    expect(serializeDocJSON(createComposerDraftStore(scope).getSnapshot().document).text).toBe("Keep this direction")
    submit()
    await waitFor(() => expect(screen.getByRole("textbox")).not.toHaveTextContent("Keep this direction"))
    expect(steer).toHaveBeenCalledTimes(2)
    expect(steer).toHaveBeenLastCalledWith("1", "Keep this direction")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("reports a steering failure in the original scope even when it occurs after unmount", async () => {
    let reject!: (error: Error) => void
    steer.mockImplementationOnce(() => new Promise<ContextualSteeringResult>((_resolve, fail) => { reject = fail }))
    const base = props()
    const first = render(<TeamChannelComposer {...base} />)
    type("Keep the unmounted direction")
    submit()
    first.unmount()
    await act(async () => reject(new Error("offline")))
    render(<TeamChannelComposer {...base} />)
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveTextContent("Keep the unmounted direction")
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
  })

  it("keeps typing enabled during steering and does not erase the newer revision", async () => {
    let resolve!: () => void
    steer.mockImplementationOnce(() => new Promise<ContextualSteeringResult>((done) => { resolve = () => done(STEERED) }))
    render(<TeamChannelComposer {...props()} />)
    type("First direction")
    submit()
    expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true")
    type(" and more")
    await act(async () => resolve())
    expect(screen.getByRole("textbox")).toHaveTextContent("and more")
  })

  it("retains a failed reopen and retries steering on the created run, without duplicating it", async () => {
    const onReopened = vi.fn()
    start.mockResolvedValue({ runId: "fresh-run" })
    steer.mockRejectedValueOnce(new Error("lost direction"))
    render(<TeamChannelComposer {...props()} thread={{
      ...thread, steerable: false,
      reopen: { projectId: "project", fileId: "file", targetLang: "fr", onReopened },
    }} />)
    type("Reopen with this direction")
    submit()
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveTextContent("Reopen with this direction")
    expect(onReopened).not.toHaveBeenCalled()
    submit()
    await waitFor(() => expect(onReopened).toHaveBeenCalledWith("fresh-run"))
    expect(start).toHaveBeenCalledTimes(1)
    expect(steer).toHaveBeenLastCalledWith("fresh-run", "Reopen with this direction")
    expect(screen.getByRole("textbox")).not.toHaveTextContent("Reopen with this direction")
  })

  it("retains the draft when starting the reopened run fails", async () => {
    start.mockRejectedValueOnce(new Error("start failed"))
    render(<TeamChannelComposer {...props()} thread={{
      ...thread, steerable: false,
      reopen: { projectId: "project", fileId: "file", targetLang: "fr", onReopened: vi.fn() },
    }} />)
    type("Keep failed start")
    submit()
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveTextContent("Keep failed start")
    expect(steer).not.toHaveBeenCalled()
  })

  it("does not redirect or overwrite the selected conversation when an old reopen completes", async () => {
    const onReopened = vi.fn()
    let resolve!: () => void
    start.mockResolvedValue({ runId: "fresh-run" })
    steer.mockImplementationOnce(() => new Promise<ContextualSteeringResult>((done) => { resolve = () => done(STEERED) }))
    const base = props()
    const view = render(<TeamChannelComposer {...base} thread={{
      ...thread, steerable: false,
      reopen: { projectId: "project", fileId: "file", targetLang: "fr", onReopened },
    }} />)
    type("Old direction")
    submit()
    await waitFor(() => expect(steer).toHaveBeenCalled())
    view.rerender(<TeamChannelComposer {...base} thread={null} draftScope={{ ...scope, conversationId: "team-chat" }} />)
    type("New channel draft")
    await act(async () => resolve())
    expect(onReopened).not.toHaveBeenCalled()
    expect(screen.getByRole("textbox")).toHaveTextContent("New channel draft")
    expect(serializeDocJSON(composerDraftStore(scope).getSnapshot().document).text).toBe("")
  })

  it("passes real editor context-chip output into steering's wire serializer", async () => {
    render(<TeamChannelComposer {...props()} />)
    act(() => composer.current!.insertChip({
      chipId: "selection", fileId: "file", cellId: "cell", side: "source",
      selection: "Exact source text", preview: "Exact source text", canonicalRef: "GEN 1:1",
    }))
    submit()
    await waitFor(() => expect(steer).toHaveBeenCalledWith("1", expect.stringContaining("Exact source text")))
    expect(steer.mock.calls[0][1]).toContain("⟦ctx:1⟧")
    expect(steer.mock.calls[0][1]).not.toContain("⟦chip:")
  })
})
