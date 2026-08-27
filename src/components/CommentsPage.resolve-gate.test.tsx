/**
 * AQU-1000 — the project-wide Comments page gates Resolve / Reopen.
 *
 * This surface was the worse of the two: it carried NO permission check at
 * all, so every reader — down to a Viewer, who cannot even comment — was shown
 * a working Resolve button. `useComments.resolveThread` writes optimistically,
 * so the click closed the thread on screen and the server's 403 reopened it,
 * with nothing said about why.
 *
 * The drawer and this page must now answer identically for the same reader and
 * the same thread; that agreement is the actual contract, since the reproduction
 * in the issue moves between the two.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { CommentRecord, } from "@/lib/sync/comments-read-types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"
import { ROLE } from "@/lib/frontier/roles"
import { CommentsPage } from "./CommentsPage"

const mockComments = vi.fn<() => CommentRecord[]>(() => [])
const mockResolveThread = vi.fn()

vi.mock("@/hooks/useComments", () => ({
  useComments: () => ({
    comments: mockComments(),
    isLoading: false,
    isError: false,
    resolveThread: mockResolveThread,
    editComment: vi.fn(async () => {}),
    deleteComment: vi.fn(async () => {}),
    refresh: vi.fn(),
    addComment: vi.fn(async () => {}),
  }),
}))

// The signed-in reader for every case below.
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { username: "bob", jwt: "tok" } }),
}))

vi.mock("@/hooks/useUserSearch", () => ({
  useUserSearch: () => ({
    query: "",
    results: [],
    isLoading: false,
    needsMorePrefix: true,
    lastFetchOk: false,
  }),
}))

vi.mock("@/lib/sync/cqrs-bridge", () => ({
  buildFileScopedTokenFetcher: () => async () => "file-tok",
}))

function makeComment(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    commentId: "c1",
    projectId: "proj-1",
    scopeKind: "cell",
    fileId: "file-1",
    cellId: "cell-1",
    parentCommentId: null,
    body: "A remark",
    resolved: false,
    authorId: "alice",
    authorLabel: "Alice",
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    cellRef: "GEN 1:1",
    ...overrides,
  }
}

function makeProject(roleLevel: number | null): ProjectRecord {
  const base = {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [{ id: "file-1", name: "GEN.usfm" }],
    members: [],
  } as unknown as ProjectRecord
  if (roleLevel === null) return base
  return {
    ...base,
    syncRole: { level: roleLevel, name: "test", source: "server", fetchedAt: new Date().toISOString() },
  }
}

function renderPage(roleLevel: number | null) {
  return renderWithTooltips(
    <MemoryRouter initialEntries={["/project/proj-1/comments"]}>
      <Routes>
        <Route
          path="/project/:id/comments"
          element={<CommentsPage project={makeProject(roleLevel)} />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe("CommentsPage — Resolve gate (AQU-1000)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // A thread written by alice; the reader throughout is bob.
    mockComments.mockReturnValue([makeComment()])
  })

  it("refuses Resolve on a foreign thread for a Commenter", () => {
    renderPage(ROLE.COMMENTER)
    expect(screen.getByTestId("thread-resolve")).toHaveAttribute("aria-disabled", "true")
  })

  it("never enqueues a resolve from the refused control — the flip-then-revert guard", async () => {
    renderPage(ROLE.COMMENTER)
    await userEvent.click(screen.getByTestId("thread-resolve"))
    expect(mockResolveThread).not.toHaveBeenCalled()
  })

  it("explains the refusal in a tooltip that names the role that could do it", async () => {
    renderPage(ROLE.COMMENTER)
    await expectTooltip(screen.getByTestId("thread-resolve"), /contributor/i)
  })

  it("offers Resolve on the reader's OWN thread at Commenter", async () => {
    mockComments.mockReturnValue([makeComment({ authorId: "bob", authorLabel: "Bob" })])
    renderPage(ROLE.COMMENTER)
    const button = screen.getByTestId("thread-resolve")
    expect(button).not.toHaveAttribute("aria-disabled")
    await userEvent.click(button)
    expect(mockResolveThread).toHaveBeenCalledWith("c1", true)
  })

  it("offers Resolve on a foreign thread to a Contributor", async () => {
    renderPage(ROLE.CONTRIBUTOR)
    const button = screen.getByTestId("thread-resolve")
    expect(button).not.toHaveAttribute("aria-disabled")
    await userEvent.click(button)
    expect(mockResolveThread).toHaveBeenCalledWith("c1", true)
  })

  it("refuses a Viewer, who could previously resolve anything from this page", async () => {
    renderPage(ROLE.VIEWER)
    const button = screen.getByTestId("thread-resolve")
    expect(button).toHaveAttribute("aria-disabled", "true")
    // Below the self floor, so the sentence is about the role bar itself.
    await expectTooltip(button, /commenter/i)
  })

  it("refuses Reopen on a foreign RESOLVED thread, not just Resolve", async () => {
    mockComments.mockReturnValue([makeComment({ resolved: true })])
    renderPage(ROLE.COMMENTER)
    // Resolved threads are filtered out of the default view; reveal them the
    // way a user would, so this covers the real path to a Reopen button.
    fireEvent.click(screen.getByRole("button", { name: /^Filters$/i }))
    fireEvent.click(screen.getByRole("switch", { name: /Show resolved/i }))
    const button = screen.getByTestId("thread-resolve")
    expect(button).toHaveTextContent("Reopen")
    expect(button).toHaveAttribute("aria-disabled", "true")
    await userEvent.click(button)
    expect(mockResolveThread).not.toHaveBeenCalled()
  })

  it("leaves local / git-imported projects alone (no syncRole)", () => {
    renderPage(null)
    expect(screen.getByTestId("thread-resolve")).not.toHaveAttribute("aria-disabled")
  })
})
