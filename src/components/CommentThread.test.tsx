/**
 * AQU-1000 — the resolve-family controls must tell the truth about what the
 * server will accept on THIS thread.
 *
 * The bug this guards: `canResolve` was one per-user boolean handed to every
 * thread, so a Commenter was offered Resolve on threads they had not written.
 * `useComments.resolveThread` flips `resolved` optimistically, so the click
 * closed the thread on screen and the server's 403 flipped it straight back —
 * a promise the system never intended to keep.
 *
 * The contract now has three states, and each is asserted below:
 *   offered   — the action will succeed
 *   refused   — rendered, inert, and carrying the reason (09-design-and-ux.md
 *               → "Never disable silently")
 *   absent    — no role context exists to explain, so nothing is shown
 */
import { beforeEach, describe, it, expect, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { COMMENT_HIGHLIGHT_MS, CommentThread } from "./CommentThread"
import type { CommentThread as ThreadData } from "@/lib/parsers/types"

const DENIAL = "Only Contributors and above can resolve a thread someone else started."

function makeThread(status: "open" | "resolved" = "open"): ThreadData {
  return {
    id: "thread-1",
    status,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    createdForTranslated: null,
    authorId: "alice",
    messages: [
      {
        id: "thread-1",
        author: "Alice",
        authorType: "user",
        text: "Is this rendering right?",
        timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
      },
    ],
  }
}

const noop = () => {}

async function openActions() {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Comment actions" }))
  return user
}

async function expandResolved() {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: /resolved comment from/i }))
  return user
}

function renderThread(props: Partial<React.ComponentProps<typeof CommentThread>> = {}) {
  return render(
    <CommentThread
      thread={makeThread()}
      currentTranslated="Bonjour"
      onReply={noop}
      onResolve={noop}
      onReopen={noop}
      {...props}
    />,
  )
}

describe("CommentThread — resolve controls reflect real authority (AQU-1000)", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("offers an enabled Resolve when the action is permitted", async () => {
    renderThread({ canResolve: true })
    await openActions()
    const resolve = screen.getByTestId("comment-resolve")
    expect(resolve).toBeInTheDocument()
    expect(resolve).not.toHaveAttribute("aria-disabled")
  })

  it("renders Resolve inert, not absent, when refused with a reason", async () => {
    renderThread({
      canResolve: false,
      resolveDenialReason: DENIAL,
    })
    await openActions()
    const resolve = screen.getByTestId("comment-resolve")
    // Still on screen: the reader can see the action exists and learn why it
    // is closed to them, rather than wondering where it went.
    expect(resolve).toBeInTheDocument()
    expect(resolve).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByText(DENIAL)).toBeInTheDocument()
  })

  it("never fires onResolve from a refused control — this is the flip-then-revert guard", async () => {
    const onResolve = vi.fn()
    renderThread({
      canResolve: false,
      resolveDenialReason: DENIAL,
      onResolve,
    })
    const user = await openActions()
    await user.click(screen.getByTestId("comment-resolve"))
    // No event is enqueued, so nothing flips optimistically and nothing reverts.
    expect(onResolve).not.toHaveBeenCalled()
  })

  it("keeps Reply available when Resolve is refused, and Option-Enter does not resolve", async () => {
    const onReply = vi.fn()
    const onResolve = vi.fn()
    renderThread({
      canReply: true,
      canResolve: false,
      resolveDenialReason: DENIAL,
      onReply,
      onResolve,
    })
    await openActions()
    expect(screen.getByTestId("comment-resolve")).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("button", { name: "Reply" })).toHaveAttribute("data-variant", "outline")

    const user = userEvent.setup()
    await user.click(screen.getByRole("textbox"))
    await user.type(screen.getByRole("textbox"), "hello")
    expect(screen.getByRole("button", { name: "Reply" })).toHaveAttribute("data-variant", "default")
    await user.keyboard("{Alt>}{Enter}{/Alt}")
    expect(onResolve).not.toHaveBeenCalled()
    expect(onReply).not.toHaveBeenCalled()
  })

  it("refuses Reopen on a resolved thread the reader may not touch", async () => {
    renderThread({
      thread: makeThread("resolved"),
      canResolve: false,
      resolveDenialReason: DENIAL,
    })
    await expandResolved()
    await openActions()
    expect(screen.getByTestId("comment-reopen")).toHaveAttribute("aria-disabled", "true")
  })

  it("offers an enabled Reopen on a resolved thread when permitted", async () => {
    renderThread({ thread: makeThread("resolved"), canResolve: true })
    await expandResolved()
    await openActions()
    expect(screen.getByTestId("comment-reopen")).not.toHaveAttribute("aria-disabled")
  })

  it("makes the reason reachable from the menu — a disabled control that explains nothing is the thing the design rule forbids", async () => {
    renderThread({
      canResolve: false,
      resolveDenialReason: DENIAL,
    })
    await openActions()
    expect(screen.getByText(/Contributors and above/i)).toBeInTheDocument()
  })

  it("hides Resolve when there is no reason to give", async () => {
    // Local / git-imported projects carry no sync role, so there is no
    // permission sentence to show. Legacy hide-entirely behaviour is preserved.
    renderThread({ canResolve: false, canReply: false })
    await openActions()
    expect(screen.queryByTestId("comment-resolve")).not.toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Copy comment URL" })).toBeInTheDocument()
  })

  it("Enter replies, and Option-Enter replies and resolves", async () => {
    const user = userEvent.setup()
    const onReply = vi.fn()
    const onResolve = vi.fn()
    renderThread({ canReply: true, canResolve: true, onReply, onResolve })
    const field = screen.getByRole("textbox")
    await user.click(field)
    await user.type(field, "hello")
    expect(field.textContent).toBe("hello")
    await user.keyboard("{Enter}")
    expect(onReply).toHaveBeenCalledWith("hello")
    expect(onResolve).not.toHaveBeenCalled()

    await user.type(field, "bye")
    await user.keyboard("{Alt>}{Enter}{/Alt}")
    expect(onResolve).toHaveBeenCalledWith("bye")
  })

  it("copies the comment url from the menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText)
    renderThread({ projectId: "proj-1", fileId: "file-1", cellId: "cell-1" })
    const user = await openActions()
    await user.click(screen.getByRole("menuitem", { name: "Copy comment URL" }))
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/project/proj-1/editor/file/file-1?cellId=cell-1&comments=1&commentId=thread-1`,
    )
  })

  it("edits the opening comment from the top of the menu", async () => {
    const onEdit = vi.fn()
    renderThread({ canEdit: true, onEdit })
    const user = await openActions()
    await user.click(screen.getByRole("menuitem", { name: "Edit" }))
    const field = screen.getByPlaceholderText("Edit comment…")
    expect(field).toHaveTextContent("Is this rendering right?")
    const selection = window.getSelection()
    expect(selection?.isCollapsed).toBe(true)
    expect(selection?.anchorNode && field.contains(selection.anchorNode)).toBe(true)
    expect(selection?.anchorOffset).toBe(selection?.anchorNode?.textContent?.length)
    await user.clear(field)
    await user.type(field, "updated")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onEdit).toHaveBeenCalledWith("updated")
  })

  it("deletes the opening comment from the bottom of the menu", async () => {
    const onDelete = vi.fn()
    renderThread({ canDelete: true, onDelete })
    const user = await openActions()
    const items = screen.getAllByRole("menuitem")
    expect(items[items.length - 1]).toHaveAccessibleName("Delete")
    await user.click(screen.getByRole("menuitem", { name: "Delete" }))
    await user.click(screen.getByRole("button", { name: "Delete" }))
    expect(onDelete).toHaveBeenCalledOnce()
  })
})

describe("CommentThread — resolved threads collapse", () => {
  it("hides the messages until the summary is opened, then folds them again", async () => {
    const user = userEvent.setup()
    const thread = makeThread("resolved")
    thread.messages.push({
      id: "reply-1",
      author: "Alice",
      authorType: "user",
      text: "second note",
      timestamp: new Date("2026-01-02T00:00:00Z").toISOString(),
    })
    renderThread({ thread })
    expect(screen.getByRole("button", { name: "2 resolved comments from Alice" })).toBeInTheDocument()
    expect(screen.queryByText("Is this rendering right?")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "2 resolved comments from Alice" }))
    expect(screen.getByText("Is this rendering right?")).toBeInTheDocument()
    expect(screen.getByText("second note")).toBeInTheDocument()

    await user.click(screen.getAllByRole("button", { name: "Collapse" })[0])
    expect(screen.queryByText("second note")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "2 resolved comments from Alice" })).toBeInTheDocument()
  })
})

describe("CommentThread — author mark and focused reply", () => {
  it("shows the author's mark beside their name", () => {
    renderThread()
    expect(screen.getByText("AL")).toBeInTheDocument()
    expect(screen.getByText("Alice")).toBeInTheDocument()
  })

  it("marks an edited message beside its time", () => {
    const thread = makeThread()
    thread.messages[0].editedAt = new Date("2026-01-02T00:00:00Z").toISOString()
    renderThread({ thread })
    expect(screen.getByText("(edited)")).toBeInTheDocument()
  })

  it("scrolls the named reply into view and highlights it", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {})
    const thread = makeThread()
    thread.messages.push({
      id: "reply-1",
      author: "Bob",
      authorType: "user",
      text: "please look",
      timestamp: new Date("2026-01-02T00:00:00Z").toISOString(),
    })
    renderThread({ thread, highlightCommentId: "reply-1" })
    const reply = screen.getByText("please look").closest("li")
    expect(reply).toHaveAttribute("data-focused", "true")
    expect(reply?.closest(".rounded-lg")?.className).toContain("border-primary")
    expect(reply?.className).not.toContain("ring-1")
    expect(reply?.className).not.toContain("bg-muted")
    expect(reply?.className).not.toContain("bg-primary")
    expect(scroll.mock.instances).toContain(reply)
    scroll.mockRestore()
  })

  it("drops the highlight after 8 seconds and leaves the reply in place", () => {
    vi.useFakeTimers()
    try {
      const thread = makeThread()
      thread.messages.push({
        id: "reply-1",
        author: "Bob",
        authorType: "user",
        text: "please look",
        timestamp: new Date("2026-01-02T00:00:00Z").toISOString(),
      })
      renderThread({ thread, highlightCommentId: "reply-1" })
      const reply = screen.getByText("please look").closest("li")
      expect(reply).toHaveAttribute("data-focused", "true")

      act(() => {
        vi.advanceTimersByTime(COMMENT_HIGHLIGHT_MS - 1)
      })
      expect(reply).toHaveAttribute("data-focused", "true")

      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(reply).not.toHaveAttribute("data-focused")
      expect(reply?.closest(".rounded-lg")?.className).not.toContain("border-primary")
      expect(screen.getByText("please look")).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("highlights only the thread that holds the linked comment", () => {
    const elsewhere = makeThread()
    elsewhere.id = "thread-2"
    elsewhere.messages = [
      {
        id: "thread-2",
        author: "Alice",
        authorType: "user",
        text: "somewhere else",
        timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
      },
    ]
    render(
      <>
        <CommentThread
          thread={makeThread()}
          currentTranslated="Bonjour"
          onReply={noop}
          onResolve={noop}
          onReopen={noop}
          highlightCommentId="thread-1"
        />
        <CommentThread
          thread={elsewhere}
          currentTranslated="Bonjour"
          onReply={noop}
          onResolve={noop}
          onReopen={noop}
          highlightCommentId="thread-1"
        />
      </>,
    )
    const named = screen.getByText("Is this rendering right?").closest(".rounded-lg")
    const other = screen.getByText("somewhere else").closest(".rounded-lg")
    expect(named?.className).toContain("border-primary")
    expect(other?.className).not.toContain("border-primary")
  })
})
