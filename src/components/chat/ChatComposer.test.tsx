import { beforeEach, describe, it, expect, vi } from "vitest"
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"
import { createRef } from "react"
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer"
import {
  composerDraftStore, createComposerDraftStore, resetComposerDraftsForTesting, type ComposerDraftScope,
} from "@/lib/agent/composer-drafts"
import { serializeDocJSON, type ContextChip } from "@/lib/agent/context-chip"

const scope: ComposerDraftScope = { owner: "alice", projectId: "project", conversationId: "run:1" }
const chip: ContextChip = {
  chipId: "a", fileId: "f", cellId: "z", canonicalRef: "GEN 1:1", fileName: "Genesis.usfm",
  side: "source", selection: "<exact>\nsource & words", preview: "<exact> source & words",
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  resetComposerDraftsForTesting()
})

describe("ChatComposer (TipTap)", () => {
  it("sends on Enter and keeps Shift+Enter for a newline", () => {
    const onSend = vi.fn()
    const ref = createRef<ChatComposerHandle>()
    render(<ChatComposer ref={ref} isStreaming={false} isConfigured onSend={onSend} onStop={vi.fn()} />)
    act(() => ref.current!.insertText("First line"))
    const textbox = screen.getByRole("textbox")
    fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(textbox, { key: "Enter" })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it("insertChip adds a chip that serializes into the send payload on Command+Enter", () => {
    const onSend = vi.fn()
    const ref = createRef<ChatComposerHandle>()
    render(<ChatComposer ref={ref} isStreaming={false} isConfigured onSend={onSend} onStop={vi.fn()} />)
    act(() => ref.current!.insertChip({
      chipId: "a", fileId: "f", cellId: "z", canonicalRef: "GEN 1:1",
      side: "source", selection: "In the beginning", preview: "In the beginning",
    }))
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", metaKey: true })
    expect(onSend).toHaveBeenCalledTimes(1)
    const payload = onSend.mock.calls[0][0]
    expect(payload.chips).toHaveLength(1)
    expect(payload.text).toContain("⟦chip:a⟧")
  })

  it("shows Stop and calls onStop while streaming", () => {
    const onStop = vi.fn()
    render(<ChatComposer isStreaming isConfigured onSend={vi.fn()} onStop={onStop} />)
    fireEvent.click(screen.getByRole("button", { name: /stop/i }))
    expect(onStop).toHaveBeenCalled()
  })

  it("keeps keyboard shortcuts functional without permanent help copy", () => {
    render(<ChatComposer isStreaming={false} isConfigured onSend={vi.fn()} onStop={vi.fn()} />)
    expect(screen.queryByText(/Enter to send/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Shift\+Enter for newline/)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveClass("min-h-9", "max-h-32", "overflow-y-auto")
  })

  it("round-trips the real editor JSON, literal text, and chips across unmount and reload", () => {
    const ref = createRef<ChatComposerHandle>()
    const onSend = vi.fn()
    const props = { ref, draftScope: scope, isStreaming: false, isConfigured: true, onSend, onStop: vi.fn() }
    const first = render(<ChatComposer {...props} />)
    act(() => {
      ref.current!.insertText("Draft persistence check (unsent) <literal>")
      ref.current!.insertChip(chip)
    })
    const saved = composerDraftStore(scope).getSnapshot().document
    first.unmount()
    resetComposerDraftsForTesting()
    render(<ChatComposer {...props} />)
    expect(composerDraftStore(scope).getSnapshot().document).toEqual(saved)
    expect(screen.getByRole("textbox")).toHaveTextContent("Draft persistence check (unsent) <literal>")
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSend).toHaveBeenCalledWith({
      text: expect.stringContaining("⟦chip:a⟧"), chips: [chip],
    })
    expect(serializeDocJSON(createComposerDraftStore(scope).getSnapshot().document).text).toBe("")
  })

  it("isolates scopes synchronously when the same composer switches destinations/accounts/projects", () => {
    const ref = createRef<ChatComposerHandle>()
    const props = { ref, isStreaming: false, isConfigured: true, onSend: vi.fn(), onStop: vi.fn() }
    const view = render(<ChatComposer {...props} draftScope={scope} />)
    act(() => ref.current!.insertText("Run draft"))
    for (const other of [
      { ...scope, conversationId: "team-chat" }, { ...scope, owner: "bob" }, { ...scope, projectId: "elsewhere" },
    ]) {
      view.rerender(<ChatComposer {...props} draftScope={other} />)
      expect(screen.getByRole("textbox")).not.toHaveTextContent("Run draft")
      act(() => ref.current!.insertText("Other draft"))
      expect(serializeDocJSON(composerDraftStore(scope).getSnapshot().document).text).toBe("Run draft")
      view.rerender(<ChatComposer {...props} draftScope={scope} />)
      expect(screen.getByRole("textbox")).toHaveTextContent("Run draft")
    }
  })

  it("keeps newer typing while a send is pending and prevents duplicate submits", async () => {
    let resolveSend!: () => void
    const onSend = vi.fn(() => new Promise<void>((resolve) => { resolveSend = resolve }))
    const ref = createRef<ChatComposerHandle>()
    render(<ChatComposer ref={ref} draftScope={scope} isStreaming={false} isConfigured onSend={onSend} onStop={vi.fn()} />)
    act(() => ref.current!.insertText("First"))
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    act(() => ref.current!.insertText(" newer"))
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSend).toHaveBeenCalledTimes(1)
    await act(async () => resolveSend())
    expect(screen.getByRole("textbox")).toHaveTextContent("newer")
    expect(serializeDocJSON(createComposerDraftStore(scope).getSnapshot().document).text).toContain("newer")
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
  })

  it("acknowledges only the old scope after navigation during send", async () => {
    let resolveSend!: () => void
    const onSend = vi.fn(() => new Promise<void>((resolve) => { resolveSend = resolve }))
    const ref = createRef<ChatComposerHandle>()
    const props = { ref, isStreaming: false, isConfigured: true, onSend, onStop: vi.fn() }
    const view = render(<ChatComposer {...props} draftScope={scope} />)
    act(() => ref.current!.insertText("Sent old draft"))
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    const other = { ...scope, conversationId: "team-chat" }
    view.rerender(<ChatComposer {...props} draftScope={other} />)
    act(() => ref.current!.insertText("Unsent new destination"))
    await act(async () => resolveSend())
    expect(screen.getByRole("textbox")).toHaveTextContent("Unsent new destination")
    expect(serializeDocJSON(createComposerDraftStore(scope).getSnapshot().document).text).toBe("")
  })

  it("keeps the pending-send guard and newer edits when navigating away and back before acknowledgement", async () => {
    let resolveSend!: () => void
    const onSend = vi.fn(() => new Promise<void>((resolve) => { resolveSend = resolve }))
    const ref = createRef<ChatComposerHandle>()
    const props = { ref, isStreaming: false, isConfigured: true, onSend, onStop: vi.fn() }
    const view = render(<ChatComposer {...props} draftScope={scope} />)
    act(() => ref.current!.insertText("Sent revision"))
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    view.rerender(<ChatComposer {...props} draftScope={{ ...scope, conversationId: "team-chat" }} />)
    view.rerender(<ChatComposer {...props} draftScope={scope} />)
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
    act(() => ref.current!.insertText(" new revision"))
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSend).toHaveBeenCalledTimes(1)
    await act(async () => resolveSend())
    expect(screen.getByRole("textbox")).toHaveTextContent("new revision")
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
  })

  it.each(["throw", "reject", "decline"])("retains drafts on %s rather than claiming a handoff", async (failure) => {
    const ref = createRef<ChatComposerHandle>()
    const onSend = vi.fn(() => {
      if (failure === "throw") throw new Error("offline")
      if (failure === "reject") return Promise.reject(new Error("offline"))
      return false
    })
    render(<ChatComposer ref={ref} draftScope={scope} isStreaming={false} isConfigured onSend={onSend} onStop={vi.fn()} />)
    act(() => ref.current!.insertText("Keep this"))
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled())
    expect(screen.getByRole("textbox")).toHaveTextContent("Keep this")
    expect(serializeDocJSON(createComposerDraftStore(scope).getSnapshot().document).text).toBe("Keep this")
    if (failure !== "decline") expect(screen.getByRole("alert")).toHaveTextContent("Could not send")
  })

  it("shows storage failures while keeping the live draft through a remount", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("quota") })
    const ref = createRef<ChatComposerHandle>()
    const props = { ref, draftScope: scope, isStreaming: false, isConfigured: true, onSend: vi.fn(), onStop: vi.fn() }
    const first = render(<ChatComposer {...props} />)
    act(() => ref.current!.insertText("Memory only"))
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save")
    first.unmount()
    render(<ChatComposer {...props} />)
    expect(screen.getByRole("textbox")).toHaveTextContent("Memory only")
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save")
  })

  it("does not steal focus on mount, configuration change or destination change", () => {
    const props = { isStreaming: false, onSend: vi.fn(), onStop: vi.fn() }
    const view = render(<><button>Selected thread</button><ChatComposer {...props} draftScope={scope} isConfigured={false} /></>)
    const navigation = screen.getByRole("button", { name: "Selected thread" })
    navigation.focus()
    view.rerender(<><button>Selected thread</button><ChatComposer {...props} draftScope={scope} isConfigured /></>)
    expect(navigation).toHaveFocus()
    view.rerender(<><button>Selected thread</button><ChatComposer {...props} draftScope={{ ...scope, conversationId: "team-chat" }} isConfigured /></>)
    expect(navigation).toHaveFocus()
  })
})
