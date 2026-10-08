import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"
import { CommentsPage } from "./CommentsPage"

const mockComments = vi.fn<() => CommentRecord[]>(() => [])
const mockRefresh = vi.fn()
const mockResolveThread = vi.fn()

vi.mock("@/hooks/useComments", () => ({
  useComments: () => ({
    comments: mockComments(),
    isLoading: false,
    isError: false,
    resolveThread: mockResolveThread,
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
  useProject: vi.fn(() => ({
    project: {
      id: "proj-1",
      name: "Test Project",
      files: [{ id: "file-1", name: "GEN.usfm" }],
    },
    loading: false,
    status: "ready",
  })),
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

const { fetchCellsByIds } = vi.hoisted(() => ({
  fetchCellsByIds: vi.fn(async () => [] as Array<Record<string, unknown>>),
}))

vi.mock("@/lib/sync/cells-read", () => ({
  fetchCellsByIds,
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

function renderPage(props: React.ComponentProps<typeof CommentsPage> = {}) {
  return renderWithTooltips(
    <MemoryRouter initialEntries={["/project/proj-1/comments"]}>
      <Routes>
        <Route path="/project/:id/comments" element={<CommentsPage {...props} />} />
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
    const filters = screen.getByRole("button", { name: /^Filters$/i })
    const refresh = screen.getByRole("button", { name: /^Refresh$/i })
    expect(filters.compareDocumentPosition(refresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByPlaceholderText("Search comments…").closest("[data-slot='input-group']")).toHaveClass("bg-card")
    expect(filters).toHaveClass("bg-card")
    expect(refresh).toHaveClass("bg-card")
    expect(screen.queryByRole("button", { name: /Back to project/i })).not.toBeInTheDocument()
  })

  it("calls refresh from the icon button", () => {
    renderPage()
    fireEvent.click(screen.getByRole("button", { name: /^Refresh$/i }))
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it("centers the filters tooltip and right-aligns the refresh tooltip", async () => {
    renderPage()
    const user = userEvent.setup()

    await expectTooltip(screen.getByRole("button", { name: /^Filters$/i }), /^Filters$/i)
    expect(screen.getByRole("tooltip").closest("[data-align]")).toHaveAttribute("data-align", "center")

    await user.unhover(screen.getByRole("button", { name: /^Filters$/i }))
    await expectTooltip(screen.getByRole("button", { name: /^Refresh$/i }), /^Refresh$/i)
    expect(screen.getByRole("tooltip").closest("[data-align]")).toHaveAttribute("data-align", "end")
  })

  it("uses the workspace-owned project without starting another project resolve", async () => {
    const { useProject } = await import("@/hooks/useProject")
    renderPage({
      project: {
        id: "proj-1",
        name: "Workspace project",
        files: [{ id: "file-1", name: "Workspace GEN" }],
      } as never,
    })

    expect(vi.mocked(useProject)).toHaveBeenLastCalledWith("proj-1", expect.objectContaining({
      enabled: false,
      includeSettings: false,
    }))
  })

  it("opens the Filters menu to show Sort and Show resolved, then closes it", async () => {
    const user = userEvent.setup()
    renderPage()

    expect(screen.queryByRole("combobox", { name: /^Sort$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: /Show resolved/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /^Filters$/i }))
    const filters = screen.getByRole("button", { name: /^Filters$/i })
    expect(filters).toHaveAttribute("data-variant", "outline")
    expect(filters).toHaveAttribute("aria-expanded", "true")
    const sortTrigger = screen.getByRole("combobox", { name: /^Sort$/i })
    expect(sortTrigger).toBeInTheDocument()
    expect(sortTrigger.className).toMatch(/text-foreground/)
    await user.click(screen.getByText("Sort"))
    expect(sortTrigger).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(sortTrigger)
    const sortMenu = document.querySelector("[data-slot=select-content]")
    expect(sortMenu).toHaveAttribute("data-align-trigger", "false")
    expect(sortMenu?.closest("[data-align]")).toHaveAttribute("data-align", "end")
    expect(sortMenu?.closest("[data-side]")).toHaveAttribute("data-side", "top")
    expect(screen.getByText("Sort").className).toMatch(/text-muted-foreground/)
    expect(screen.getByText("Show resolved").className).toMatch(/text-muted-foreground/)
    expect(screen.getByRole("switch", { name: /Show resolved/i })).not.toBeChecked()

    fireEvent.click(screen.getByRole("switch", { name: /Show resolved/i }))
    const reset = screen.getByRole("button", { name: /^Reset$/i })
    expect(reset.className).toMatch(/text-foreground/)
    expect(reset.className).not.toMatch(/text-muted-foreground/)
    expect(reset.parentElement).toHaveClass("justify-end")
    expect(screen.getByTestId("comments-filters-popover").className).toMatch(/\bp-0\b/)
    expect(screen.getByRole("separator")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /^Filters$/i }))
    expect(screen.queryByRole("combobox", { name: /^Sort$/i })).not.toBeInTheDocument()
  })

  it("keeps File, Author, and Participant trigger text as selected values", () => {
    mockComments.mockReturnValue([makeComment()])
    renderPage()
    fireEvent.click(screen.getByRole("button", { name: /^Filters$/i }))

    for (const name of [/^Sort$/i, /^File$/i, /^Author$/i, /^Participant$/i]) {
      const trigger = screen.getByRole("combobox", { name })
      expect(trigger).not.toHaveAttribute("data-placeholder")
      expect(trigger.className).toMatch(/text-foreground/)
    }

    const sortTrigger = screen.getByRole("combobox", { name: /^Sort$/i })
    fireEvent.click(sortTrigger)
    expect(document.querySelector("[data-slot=select-content]")?.closest("[data-side]")).toHaveAttribute(
      "data-side",
      "bottom",
    )
    fireEvent.click(sortTrigger)
    fireEvent.click(screen.getByRole("combobox", { name: /^Participant$/i }))
    expect(document.querySelector("[data-slot=select-content]")?.closest("[data-side]")).toHaveAttribute(
      "data-side",
      "top",
    )
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

  it("labels a thread with the book, chapter, and verse", async () => {
    fetchCellsByIds.mockResolvedValueOnce([
      {
        cellId: "cell-heading",
        side: "source",
        canonicalRef: null,
        value: "The Creation",
        valueHtml: null,
        metadata: { aquillaImport: { milestone: { label: "Genesis 1" } } },
      },
      {
        cellId: "cell-verse",
        side: "source",
        canonicalRef: "GEN 1:2",
        value: "Now the earth was formless",
        valueHtml: null,
      },
    ])
    mockComments.mockReturnValue([
      makeComment({ commentId: "heading", cellId: "cell-heading", cellRef: null, body: "on the heading" }),
      makeComment({ commentId: "verse", cellId: "cell-verse", cellRef: null, body: "on the verse" }),
    ])
    renderPage()

    expect(await screen.findByText("Genesis 1")).toBeInTheDocument()
    expect(screen.getByText("Genesis 1:2")).toBeInTheDocument()
    expect(screen.queryByText("The Creation")).not.toBeInTheDocument()
    expect(screen.queryByText("Now the earth was formless")).not.toBeInTheDocument()
    expect(screen.queryByText(/cell-heading/)).not.toBeInTheDocument()
  })

  it("shows No comments without Clear filters when only resolved threads exist", () => {
    mockComments.mockReturnValue([makeComment({ resolved: true })])
    renderPage()

    expect(screen.getByText(/^No comments$/i)).toBeInTheDocument()
    expect(screen.queryByText(/No threads match your filters/i)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Clear filters/i })).not.toBeInTheDocument()
  })
})

// AQU-1259 (A): jumping to a comment must land on the row with the thread
// OPEN. The page's half of that contract is the link it navigates to — the
// editor reads `comments=1` and opens the drawer (see
// project-workspace-lane-deeplink).
describe("CommentsPage — jump to a comment", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockComments.mockReturnValue([])
  })

  function LocationProbe() {
    const location = useLocation()
    return <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  }

  function renderWithEditorRoute() {
    return renderWithTooltips(
      <MemoryRouter initialEntries={["/project/proj-1/comments"]}>
        <Routes>
          <Route path="/project/:id/comments" element={<CommentsPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  function jumpedTo() {
    return screen.getByTestId("location").textContent ?? ""
  }

  it("navigates to the cell with the open-comments flag", () => {
    mockComments.mockReturnValue([makeComment()])
    renderWithEditorRoute()

    expect(screen.queryByRole("button", { name: /Open file/i })).not.toBeInTheDocument()
    const comment = screen.getByRole("button", { name: /unique-search-token/i })
    expect(comment.closest(".rounded-lg")).toHaveClass("bg-card")
    fireEvent.click(screen.getByText("Alice"))

    expect(jumpedTo()).toBe(
      "/project/proj-1/editor/file/file-1?cellId=cell-1&comments=1&commentId=c1",
    )
  })

  it("carries the flag for a resolved thread too", () => {
    // A resolved thread is where "reopen" lives, so the reviewer needs the
    // drawer open just as much — the AC names both cases explicitly.
    mockComments.mockReturnValue([makeComment({ resolved: true })])
    renderWithEditorRoute()

    // Resolved threads are filtered out by default; reveal them the way a
    // reviewer revisiting old notes does.
    fireEvent.click(screen.getByRole("button", { name: /^Filters$/i }))
    fireEvent.click(screen.getByRole("switch", { name: "Show resolved" }))
    fireEvent.click(screen.getByRole("button", { name: /resolved comment from/i }))

    expect(jumpedTo()).toContain("comments=1")
    expect(jumpedTo()).toContain("commentId=c1")
  })

  it("does not offer a comment actions menu or a right-click menu", () => {
    mockComments.mockReturnValue([makeComment()])
    renderWithEditorRoute()

    expect(screen.queryByRole("button", { name: "Comment actions" })).not.toBeInTheDocument()
    fireEvent.contextMenu(screen.getByText("unique-search-token"))
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument()
  })

  it("scrolls to the reply that was clicked, not the top of the thread", () => {
    mockComments.mockReturnValue([
      makeComment({ commentId: "root", body: "the question" }),
      makeComment({
        commentId: "reply-9",
        parentCommentId: "root",
        body: "the answer further down",
        authorId: "bob",
        authorLabel: "Bob",
      }),
    ])
    renderWithEditorRoute()

    fireEvent.click(screen.getByText("Bob"))

    expect(jumpedTo()).toBe(
      "/project/proj-1/editor/file/file-1?cellId=cell-1&comments=1&commentId=reply-9",
    )
  })
})
