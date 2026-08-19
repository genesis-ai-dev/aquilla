import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

  it("shows No comments without Clear filters when only resolved threads exist", () => {
    mockComments.mockReturnValue([makeComment({ resolved: true })])
    renderPage()

    expect(screen.getByText(/^No comments$/i)).toBeInTheDocument()
    expect(screen.queryByText(/No threads match your filters/i)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Clear filters/i })).not.toBeInTheDocument()
  })
})
