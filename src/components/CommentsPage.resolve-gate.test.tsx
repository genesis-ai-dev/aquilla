/**
 * The comments page does not offer resolve, edit, or delete. Those actions
 * stay on the editor comments panel, which still gates them (AQU-1000,
 * CommentThread.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen, fireEvent } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { renderWithTooltips } from "@/test-utils/tooltip"
import { ROLE } from "@/lib/frontier/roles"
import { CommentsPage } from "./CommentsPage"
import type { ProjectRecord } from "@/lib/parsers/types"

const mockComments = vi.fn<() => CommentRecord[]>(() => [])

vi.mock("@/hooks/useComments", () => ({
  useComments: () => ({
    comments: mockComments(),
    isLoading: false,
    isError: false,
    resolveThread: vi.fn(),
    editComment: vi.fn(async () => {}),
    deleteComment: vi.fn(async () => {}),
    refresh: vi.fn(),
    addComment: vi.fn(async () => {}),
  }),
}))

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

vi.mock("@/lib/sync/cells-read", () => ({
  fetchCellsByIds: vi.fn(async () => []),
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

function renderPage(roleLevel: number) {
  const project = {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [{ id: "file-1", name: "GEN.usfm" }],
    members: [],
    syncRole: { level: roleLevel, name: "test", source: "server", fetchedAt: new Date().toISOString() },
  } as unknown as ProjectRecord
  return renderWithTooltips(
    <MemoryRouter initialEntries={["/project/proj-1/comments"]}>
      <Routes>
        <Route path="/project/:id/comments" element={<CommentsPage project={project} />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe("CommentsPage — no comment actions menu", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockComments.mockReturnValue([makeComment()])
  })

  it("shows the comment without an actions button or a right-click menu", () => {
    renderPage(ROLE.CONTRIBUTOR)
    expect(screen.getByText("A remark")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Comment actions" })).not.toBeInTheDocument()
    fireEvent.contextMenu(screen.getByText("A remark"))
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument()
  })
})
