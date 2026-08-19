import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { CommentsPage } from "./CommentsPage"

const mockComments = vi.fn<() => CommentRecord[]>(() => [])
const mockRefresh = vi.fn()

vi.mock("@/hooks/useComments", () => ({
  useComments: () => ({
    comments: mockComments(),
    isLoading: false,
    isError: false,
    resolveThread: vi.fn(),
    editComment: vi.fn(async () => {}),
    deleteComment: vi.fn(async () => {}),
    refresh: mockRefresh,
    addComment: vi.fn(async () => {}),
  }),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { username: "alice", jwt: "tok" },
  }),
}))

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({
    project: {
      id: "proj-1",
      name: "Test Project",
      files: [{ id: "file-1", name: "GEN.usfm" }],
    },
    loading: false,
    status: "ready",
  }),
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
    body: "unique-search-token",
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/project/proj-1/comments"]}>
      <Routes>
        <Route path="/project/:id/comments" element={<CommentsPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe("CommentsPage chrome", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockComments.mockReturnValue([])
  })

  it("renders empty state with Comments heading", () => {
    renderPage()

    expect(screen.getByRole("heading", { name: /Comments/i })).toBeInTheDocument()
    expect(screen.getByText(/No comments yet/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Refresh$/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Filters$/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Back to project/i })).not.toBeInTheDocument()
  })

  it("calls refresh from the icon button", () => {
    renderPage()
    fireEvent.click(screen.getByRole("button", { name: /^Refresh$/i }))
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it("expands Filters to show Sort combobox and collapses to hide it", () => {
    renderPage()

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /^Filters$/i }))
    const sortTrigger = screen.getByRole("combobox")
    expect(sortTrigger).toBeInTheDocument()
    expect(screen.getByText(/^Sort$/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /^Filters$/i }))
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
  })

  it("filters threads by search, shows filter badge and clear-filters empty state", () => {
    mockComments.mockReturnValue([makeComment()])
    renderPage()

    expect(screen.getByText("unique-search-token")).toBeInTheDocument()
    expect(screen.getByTestId("comments-count-badge")).toHaveTextContent("1")

    const search = screen.getByPlaceholderText("Search comments…")
    fireEvent.change(search, { target: { value: "unique-search-token" } })

    expect(screen.getByText("unique-search-token")).toBeInTheDocument()
    expect(screen.getByText(/1 filter/i)).toBeInTheDocument()
    expect(screen.getByTestId("comments-count-badge")).toHaveTextContent("1")

    fireEvent.change(search, { target: { value: "zzz-no-match-zzz" } })

    expect(screen.getByText(/No threads match your filters/i)).toBeInTheDocument()
    expect(screen.getByTestId("comments-count-badge")).toHaveTextContent("0")
    expect(screen.getByRole("button", { name: /Clear filters/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /Clear filters/i }))
    expect(search).toHaveValue("")
    expect(screen.getByText("unique-search-token")).toBeInTheDocument()
    expect(screen.getByTestId("comments-count-badge")).toHaveTextContent("1")
  })

  it("shows No comments without Clear filters when only resolved threads exist", () => {
    mockComments.mockReturnValue([makeComment({ resolved: true })])
    renderPage()

    expect(screen.getByText(/^No comments$/i)).toBeInTheDocument()
    expect(screen.queryByText(/No threads match your filters/i)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Clear filters/i })).not.toBeInTheDocument()
  })
})
