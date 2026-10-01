/**
 * AQU-1275 — the per-cell comments drawer must never render "No comments yet."
 * when the comments feed failed to load or is still paging in.
 *
 * A Pattani Malay translator on a VPN reported her comments "disappearing":
 * the server had them and everyone else saw them, but a dropped page request
 * left her client with a partial list and the drawer rendered that as an empty
 * cell. An honest failure state is the difference between "retry" and "my work
 * was deleted".
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommentsDrawer } from "./CommentsDrawer"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

vi.mock("./CommentThread", () => ({
  CommentThread: () => <div data-testid="comment-thread" />,
}))

const PROJECT: ProjectRecord = {
  id: "proj-1",
  name: "Pattani Malay Bible",
  sourceLanguage: "en",
  targetLanguage: "mfa",
  createdAt: new Date().toISOString(),
  files: [],
  members: [],
}

const CELL: CellData = {
  id: "cell-1",
  fileId: "file-1",
  original: "Hello",
  translated: "Bonjour",
  context: "ACT 10:14",
  group: "g1",
  type: "text",
  status: "unvalidated",
  validationStatus: "none",
  activeValidators: [],
  validationHistory: [],
  history: [],
  threads: [],
}

function comment(id: string): CommentRecord {
  return {
    commentId: id, projectId: "proj-1", scopeKind: "cell", fileId: "file-1", cellId: "cell-1",
    parentCommentId: null, body: "looks good", resolved: false, authorId: "pmmarie",
    authorLabel: "pmmarie", createdAt: 1, updatedAt: 1, deletedAt: null,
  }
}

const noop = () => {}

function renderDrawer(props: Partial<React.ComponentProps<typeof CommentsDrawer>> = {}) {
  return render(
    <CommentsDrawer
      project={PROJECT}
      cell={CELL}
      liveComments={[]}
      onClose={noop}
      onNewThread={noop}
      onReply={noop}
      onResolve={noop}
      onReopen={noop}
      {...props}
    />,
  )
}

describe("CommentsDrawer load state (AQU-1275)", () => {
  it("shows the empty state only when the load genuinely finished with no threads", () => {
    renderDrawer()
    expect(screen.getByText(/No comments yet/i)).toBeInTheDocument()
    expect(screen.queryByTestId("comments-drawer-error")).not.toBeInTheDocument()
  })

  it("renders an error state, NOT 'No comments yet', when the feed failed", () => {
    renderDrawer({ isError: true })
    expect(screen.queryByText(/No comments yet/i)).not.toBeInTheDocument()
    const error = screen.getByTestId("comments-drawer-error")
    expect(error.textContent).toMatch(/couldn't load comments/i)
  })

  it("keeps the error banner above threads that did land — a partial list is not trustworthy", () => {
    renderDrawer({ isError: true, liveComments: [comment("c1")] })
    expect(screen.getByTestId("comments-drawer-error")).toBeInTheDocument()
    expect(screen.getByTestId("comment-thread")).toBeInTheDocument()
    expect(screen.queryByText(/No comments yet/i)).not.toBeInTheDocument()
  })

  it("offers a Retry that re-runs the comments load", async () => {
    const onRetry = vi.fn()
    renderDrawer({ isError: true, onRetry })
    await userEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("holds the empty state while later pages are still arriving", () => {
    renderDrawer({ isLoadingRest: true })
    expect(screen.queryByText(/No comments yet/i)).not.toBeInTheDocument()
    expect(screen.getByTestId("comments-drawer-loading")).toBeInTheDocument()
  })

  it("an error outranks the still-loading state", () => {
    renderDrawer({ isError: true, isLoadingRest: true })
    expect(screen.getByTestId("comments-drawer-error")).toBeInTheDocument()
    expect(screen.queryByTestId("comments-drawer-loading")).not.toBeInTheDocument()
    expect(screen.queryByText(/No comments yet/i)).not.toBeInTheDocument()
  })
})
