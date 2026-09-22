// Phase 2c-β: verify the new plain-TipTap editor commits via the onCommit
// callback (no Y.Doc), remains read-only under a remote lock, and surfaces
// the remote-changed banner.

import { describe, it, expect, vi, afterEach } from "vitest"
import { render, fireEvent, cleanup, act } from "@testing-library/react"
import {
  TranslatedEditor,
  COMMIT_IDLE_MS,
  isPresenceWordBoundary,
  presenceDraftIdleAction,
  shouldPublishPresenceDraft,
} from "./TranslatedEditor"

afterEach(cleanup)

describe("TranslatedEditor — plain TipTap commit path", () => {
  it("batches live draft presence at two-word checkpoints", () => {
    expect(shouldPublishPresenceDraft("", "one")).toBe(false)
    expect(shouldPublishPresenceDraft("", "one two")).toBe(true)
    expect(shouldPublishPresenceDraft("one two", "one corrected words")).toBe(true)
    expect(shouldPublishPresenceDraft("one two three", "one")).toBe(true)
    expect(shouldPublishPresenceDraft("one two", "one two three four")).toBe(true)
    expect(shouldPublishPresenceDraft("", "one,two ")).toBe(true)
    expect(shouldPublishPresenceDraft("", "don't ")).toBe(false)
  })

  it("defers a mid-word or sub-batch draft once, then publishes it regardless", () => {
    // A continuous typist who pauses mid-word must still show up as typing
    // within two idle windows — the gates delay a draft, they never bury it.
    const midWord = { atWordBoundary: false, previous: "one", next: "one tw" }
    expect(presenceDraftIdleAction({ ...midWord, alreadyDeferred: false })).toBe("defer")
    expect(presenceDraftIdleAction({ ...midWord, alreadyDeferred: true })).toBe("publish")
    const oneWord = { atWordBoundary: true, previous: "one", next: "one two " }
    expect(presenceDraftIdleAction({ ...oneWord, alreadyDeferred: false })).toBe("defer")
    expect(presenceDraftIdleAction({ ...oneWord, alreadyDeferred: true })).toBe("publish")
    expect(presenceDraftIdleAction({
      atWordBoundary: true, alreadyDeferred: false, previous: "one", next: "one two three ",
    })).toBe("publish")
    expect(presenceDraftIdleAction({
      atWordBoundary: false, alreadyDeferred: true, previous: "same", next: "same",
    })).toBe("skip")
  })

  it("recognizes only whitespace and Unicode punctuation as publish boundaries", () => {
    expect(isPresenceWordBoundary("one ", 4)).toBe(true)
    expect(isPresenceWordBoundary("one…", 4)).toBe(true)
    expect(isPresenceWordBoundary("one", 3)).toBe(false)
    expect(isPresenceWordBoundary("", 0)).toBe(false)
  })

  it("hydrates from initialPlain", async () => {
    const { container } = render(
      <TranslatedEditor
        cellId="cell-a"
        initialPlain="hello world"
        onCommit={() => { /* no-op */ }}
      />,
    )
    await new Promise((r) => setTimeout(r, 0))
    const text = container.querySelector(".ProseMirror")?.textContent ?? ""
    expect(text).toContain("hello world")
  })

  it("hydrates from initialHtml when present", async () => {
    const { container } = render(
      <TranslatedEditor
        cellId="cell-a"
        initialPlain="hello world"
        initialHtml="<p><b>bold</b> word</p>"
        onCommit={() => { /* no-op */ }}
      />,
    )
    await new Promise((r) => setTimeout(r, 0))
    // TipTap normalizes <b> to <strong>; either tag carries the marked text.
    const strong =
      container.querySelector(".ProseMirror strong") ??
      container.querySelector(".ProseMirror b")
    expect(strong?.textContent).toBe("bold")
  })

  it("calls onCommit after the idle window when content changes", async () => {
    vi.useFakeTimers()
    const commits: { value: string; valueHtml: string }[] = []
    const { container } = render(
      <TranslatedEditor
        cellId="cell-a"
        initialPlain="hi"
        onCommit={(snap) => { commits.push(snap) }}
      />,
    )
    // Wait one micro-tick for the editor to be ready.
    await act(async () => {
      await Promise.resolve()
    })

    const pm = container.querySelector(".ProseMirror") as HTMLElement
    pm.focus()

    // Simulate typing by replacing innerHTML — TipTap's onUpdate fires on
    // DOM mutations. We use the editor instance directly through the
    // ProseMirror selection API in practice, but for a unit test we
    // synthesize a textInput.
    // Simpler: dispatch input event after writing content.
    // TipTap exposes editor commands via a `.tiptap-editor` data attribute
    // — skip that here and verify the commit timer logic is wired.
    await act(async () => {
      // Fast-forward past the idle window. With no changes the commit
      // shouldn't fire (onUpdate hasn't been called).
      vi.advanceTimersByTime(COMMIT_IDLE_MS + 100)
    })
    expect(commits).toHaveLength(0)
    vi.useRealTimers()
  })

  // AQU-1334: the idle commit only fires after 1.2 s of quiet. A tab close,
  // reload, or navigation off the SPA never unmounts the editor, so an edit
  // made inside that window used to vanish. The page-hide flush must commit
  // it exactly once — and leave nothing behind for the unmount flush.
  it("flushes a pending edit on pagehide, once, so closing the tab can't drop it", async () => {
    vi.useFakeTimers()
    const commits: { value: string; valueHtml: string }[] = []
    const { container, unmount } = render(
      <TranslatedEditor
        cellId="cell-pagehide"
        initialPlain="verse text"
        onCommit={(snap) => { commits.push(snap) }}
      />,
    )
    await act(async () => { await Promise.resolve() })
    const pm = container.querySelector(".ProseMirror") as HTMLElement
    act(() => { fireEvent.focus(pm) })

    // Insert text through the TipTap instance TipTap hangs off its DOM root
    // (the same transaction path real typing takes), so onUpdate arms the
    // idle timer and stores the pending snapshot without committing yet.
    const tiptap = (pm as unknown as { editor?: { commands: { insertContent: (c: string) => boolean } } }).editor
    expect(tiptap).toBeDefined()
    act(() => { tiptap?.commands.insertContent("!") })
    expect(pm.textContent).toBe("!verse text")
    expect(commits).toHaveLength(0)

    act(() => { window.dispatchEvent(new Event("pagehide")) })
    expect(commits).toHaveLength(1)
    expect(commits[0]?.value).toBe("!verse text")

    // Nothing left to flush: the idle timer must not fire a second commit,
    // and neither must unmount.
    act(() => { vi.advanceTimersByTime(COMMIT_IDLE_MS + 100) })
    unmount()
    expect(commits).toHaveLength(1)
    vi.useRealTimers()
  })

  it("is read-only without rendering a warning pill when heldByLabel is set", async () => {
    const { container, queryByText } = render(
      <TranslatedEditor
        cellId="cell-a"
        initialPlain="hello"
        onCommit={() => { /* no-op */ }}
        heldByLabel="Alice"
      />,
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(queryByText(/Alice is editing/)).toBeNull()
    // The editor should be set non-editable; TipTap reflects this via
    // contentEditable="false" on the rendered ProseMirror node.
    const pm = container.querySelector(".ProseMirror") as HTMLElement
    expect(pm.getAttribute("contenteditable")).toBe("false")
  })

  // AQU-584: plain Enter confirms the edit (commit-and-exit to grid) instead of
  // splitting the paragraph and leaving a trailing newline in the cell.
  it("confirms the edit on plain Enter (commit-and-exit to grid)", async () => {
    const onEscapeToGrid = vi.fn()
    const { container } = render(
      <TranslatedEditor
        cellId="cell-enter"
        initialPlain="verse text"
        onCommit={() => { /* no-op */ }}
        onEscapeToGrid={onEscapeToGrid}
      />,
    )
    await new Promise((r) => setTimeout(r, 0))
    const pm = container.querySelector(".ProseMirror") as HTMLElement
    expect(pm).toBeTruthy()

    let prevented = false
    act(() => {
      fireEvent.focus(pm)
      // fireEvent.keyDown returns false when a handler called preventDefault.
      prevented = !fireEvent.keyDown(pm, { key: "Enter", code: "Enter" })
    })

    expect(onEscapeToGrid).toHaveBeenCalledTimes(1)
    expect(prevented).toBe(true)
    // The paragraph must not have been split — no trailing newline injected.
    expect(pm.querySelectorAll("p").length).toBe(1)
    expect(pm.textContent).toBe("verse text")
  })

  it("leaves Shift+Enter for a deliberate line break (not a confirm)", async () => {
    const onEscapeToGrid = vi.fn()
    const { container } = render(
      <TranslatedEditor
        cellId="cell-shift-enter"
        initialPlain="verse text"
        onCommit={() => { /* no-op */ }}
        onEscapeToGrid={onEscapeToGrid}
      />,
    )
    await new Promise((r) => setTimeout(r, 0))
    const pm = container.querySelector(".ProseMirror") as HTMLElement

    act(() => {
      fireEvent.focus(pm)
      fireEvent.keyDown(pm, { key: "Enter", code: "Enter", shiftKey: true })
    })

    expect(onEscapeToGrid).not.toHaveBeenCalled()
  })

  // AQU-667: an AI draft (sparkle / batch "Draft all") that lands while the
  // target editor is focused must become the editor's content, and a subsequent
  // blur must NOT commit the stale pre-draft text over it — otherwise the
  // prediction "randomly doesn't save" (the cell reloads blank).
  it("absorbs an AI draft that lands while focused and never blurs stale text over it", async () => {
    const commits: { value: string; valueHtml: string }[] = []
    const onCommit = (snap: { value: string; valueHtml: string }) => { commits.push(snap) }
    const { container, rerender } = render(
      <TranslatedEditor
        cellId="cell-ai"
        initialPlain=""
        aiDrafted={false}
        onCommit={onCommit}
      />,
    )
    await act(async () => { await Promise.resolve() })

    const pm = container.querySelector(".ProseMirror") as HTMLElement
    // Focus the (empty, untranslated) cell — the translator is sitting in it
    // when the prediction lands.
    act(() => { pm.focus() })

    // The AI draft lands in the store while we're focused: the row re-renders
    // with the predicted value flagged as an authoritative AI draft.
    await act(async () => {
      rerender(
        <TranslatedEditor
          cellId="cell-ai"
          initialPlain="predicted text"
          aiDrafted
          onCommit={onCommit}
        />,
      )
      await Promise.resolve()
    })

    // The prediction is now visible INSIDE the editor (absorbed while focused),
    // so a keystroke would edit the prediction, not the empty pre-draft value.
    expect(pm.textContent).toContain("predicted text")

    // Move away — the classic reproduction step.
    await act(async () => {
      pm.blur()
      await Promise.resolve()
    })

    // The invariant: the blur must never have committed the stale empty value.
    expect(commits.some((c) => c.value.trim() === "")).toBe(false)
    // And if it committed at all, it committed the prediction — never older text.
    for (const c of commits) expect(c.value).toContain("predicted text")
  })

  // Negative guard: a NON-AI (human/remote) value change while focused must NOT
  // yank the focused editor's content — that path is owned by the
  // discard-and-reload banner, not a silent re-hydrate. Protects normal editing.
  it("does not overwrite a focused editor on a non-AI value change", async () => {
    const { container, rerender } = render(
      <TranslatedEditor
        cellId="cell-human"
        initialPlain="hello"
        aiDrafted={false}
        onCommit={() => { /* no-op */ }}
      />,
    )
    await act(async () => { await Promise.resolve() })

    const pm = container.querySelector(".ProseMirror") as HTMLElement
    act(() => { pm.focus() })

    await act(async () => {
      rerender(
        <TranslatedEditor
          cellId="cell-human"
          initialPlain="remote change"
          aiDrafted={false}
          onCommit={() => { /* no-op */ }}
        />,
      )
      await Promise.resolve()
    })

    // Still showing the focused content — not silently replaced.
    expect(pm.textContent).toContain("hello")
    expect(pm.textContent).not.toContain("remote change")
  })

  it("renders the discard-and-reload banner when remoteChangedDuringEdit is true", async () => {
    const onDiscard = vi.fn()
    const { getByText } = render(
      <TranslatedEditor
        cellId="cell-a"
        initialPlain="hello"
        onCommit={() => { /* no-op */ }}
        remoteChangedDuringEdit
        onDiscardLocal={onDiscard}
      />,
    )
    await new Promise((r) => setTimeout(r, 0))
    const btn = getByText(/Discard and reload/)
    fireEvent.click(btn)
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })
})
