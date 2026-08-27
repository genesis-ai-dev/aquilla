import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CommentThread } from "./CommentThread"
import {
  ownerScopedLocalStorageKey,
  resetClientLocalStorageOwnerForTests,
  setClientLocalStorageOwner,
} from "@/lib/frontier/client-local-storage"
import type { CommentThread as ThreadData } from "@/lib/parsers/types"

const thread: ThreadData = {
  id: "thread-1",
  status: "open",
  createdAt: "2026-08-25T00:00:00.000Z",
  createdForTranslated: "text",
  messages: [],
}

beforeEach(() => {
  localStorage.clear()
  resetClientLocalStorageOwnerForTests()
})

afterEach(() => {
  localStorage.clear()
  resetClientLocalStorageOwnerForTests()
})

describe("CommentThread account-scoped drafts", () => {
  it("changes drafts without carrying the previous account's text across", async () => {
    setClientLocalStorageOwner("alice")
    localStorage.setItem(
      ownerScopedLocalStorageKey("comment-draft:project-1:cell-1:thread-1"),
      "alice draft",
    )
    render(
      <CommentThread
        thread={thread}
        currentTranslated="text"
        projectId="project-1"
        cellId="cell-1"
        onReply={vi.fn()}
        onResolve={vi.fn()}
        onReopen={vi.fn()}
      />,
    )
    const textbox = screen.getByRole("textbox")
    expect(textbox).toHaveValue("alice draft")

    act(() => setClientLocalStorageOwner("bob"))
    expect(textbox).toHaveValue("")
    fireEvent.change(textbox, { target: { value: "bob draft" } })
    await waitFor(() => expect(localStorage.getItem(
      ownerScopedLocalStorageKey("comment-draft:project-1:cell-1:thread-1"),
    )).toBe("bob draft"))

    act(() => setClientLocalStorageOwner("alice"))
    expect(textbox).toHaveValue("alice draft")
  })
})
