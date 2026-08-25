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
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommentThread } from "./CommentThread"
import type { CommentThread as ThreadData } from "@/lib/parsers/types"

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
  it("offers an enabled Resolve when the action is permitted", () => {
    renderThread({ canResolve: true })
    const resolve = screen.getByTestId("comment-resolve")
    expect(resolve).toBeInTheDocument()
    expect(resolve).not.toHaveAttribute("aria-disabled")
  })

  it("renders Resolve inert, not absent, when refused with a reason", () => {
    renderThread({
      canResolve: false,
      resolveDenialReason: "Only Contributors and above can resolve a thread someone else started.",
    })
    const resolve = screen.getByTestId("comment-resolve")
    // Still on screen: the reader can see the action exists and learn why it
    // is closed to them, rather than wondering where it went.
    expect(resolve).toBeInTheDocument()
    expect(resolve).toHaveAttribute("aria-disabled", "true")
  })

  it("never fires onResolve from a refused control — this is the flip-then-revert guard", async () => {
    const onResolve = vi.fn()
    renderThread({
      canResolve: false,
      resolveDenialReason: "Only Contributors and above can resolve a thread someone else started.",
      onResolve,
    })
    await userEvent.click(screen.getByTestId("comment-resolve"))
    // No event is enqueued, so nothing flips optimistically and nothing reverts.
    expect(onResolve).not.toHaveBeenCalled()
  })

  it("refuses Close-with-reply alongside Resolve — the same authority backs both", () => {
    renderThread({
      canReply: true,
      canResolve: false,
      resolveDenialReason: "Only Contributors and above can resolve a thread someone else started.",
    })
    expect(screen.getByTestId("comment-close-with-reply")).toHaveAttribute("aria-disabled", "true")
    // Replying is a different authority and must stay available.
    expect(screen.getByText("Reply")).toBeInTheDocument()
  })

  it("refuses Reopen on a resolved thread the reader may not touch", () => {
    renderThread({
      thread: makeThread("resolved"),
      canResolve: false,
      resolveDenialReason: "Only Contributors and above can resolve a thread someone else started.",
    })
    expect(screen.getByTestId("comment-reopen")).toHaveAttribute("aria-disabled", "true")
  })

  it("offers an enabled Reopen on a resolved thread when permitted", () => {
    renderThread({ thread: makeThread("resolved"), canResolve: true })
    expect(screen.getByTestId("comment-reopen")).not.toHaveAttribute("aria-disabled")
  })

  it("hides the controls entirely when there is no reason to give", () => {
    // Local / git-imported projects carry no sync role, so there is no
    // permission sentence to show. Legacy hide-entirely behaviour is preserved.
    renderThread({ canResolve: false, canReply: false })
    expect(screen.queryByTestId("comment-resolve")).not.toBeInTheDocument()
  })
})
