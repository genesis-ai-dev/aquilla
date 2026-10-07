import { beforeEach, describe, expect, it } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { NotificationsInbox } from "./NotificationsInbox"
import { resetMentionReadStateForTests } from "@/lib/store/mention-read-state"

function comment(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    commentId: "c1",
    projectId: "proj-1",
    scopeKind: "cell",
    fileId: "file-1",
    cellId: "cell-1",
    parentCommentId: null,
    body: "Could @[alice] review this verse?",
    resolved: false,
    authorId: "bob",
    authorLabel: "Bob",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
    cellRef: "GEN 1:1",
    ...overrides,
  }
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}{location.search}</div>
}

function renderInbox(comments: CommentRecord[]) {
  return render(
    <MemoryRouter initialEntries={["/project/proj-1/editor/file/file-1"]}>
      <Routes>
        <Route
          path="/project/:id/*"
          element={
            <>
              <NotificationsInbox
                projectId="proj-1"
                readerUsername="alice"
                comments={comments}
              />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe("NotificationsInbox", () => {
  beforeEach(() => {
    localStorage.clear()
    resetMentionReadStateForTests()
  })

  it("shows an unread mention and jumps to that cell's thread when opened", async () => {
    const user = userEvent.setup()
    renderInbox([
      comment(),
      comment({ commentId: "own", authorId: "alice", body: "@[alice] myself" }),
    ])
    expect(screen.getByTestId("notifications-unread-count")).toHaveTextContent("1")
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    expect(screen.getByText("Bob commented: Could @alice review this verse?")).toBeInTheDocument()
    expect(screen.getByText("GEN 1:1")).toBeInTheDocument()
    const dot = screen.getByTestId("notification-unread-dot")
    expect(dot.parentElement).toHaveTextContent("GEN 1:1")
    expect(dot.parentElement).not.toHaveTextContent("commented")
    expect(screen.queryByText(/Cell /)).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Bob/ }))
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/project/proj-1/editor/file/file-1?cellId=cell-1&comments=1&commentId=c1",
    )
    expect(screen.queryByTestId("notifications-unread-count")).not.toBeInTheDocument()
  })

  it("shows the cell's text when it has no verse or chapter ref", async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={["/project/proj-1/editor/file/file-1"]}>
        <Routes>
          <Route
            path="/project/:id/*"
            element={
              <NotificationsInbox
                projectId="proj-1"
                readerUsername="alice"
                comments={[
                  comment({
                    cellRef: null,
                    createdForTranslated: "Saved later",
                    body: "@[alice] look",
                  }),
                ]}
                cellTextById={new Map([["cell-1", "The Creation"]])}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    )
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    expect(screen.getByText("The Creation")).toBeInTheDocument()
    expect(screen.getByText("Bob commented: @alice look")).toBeInTheDocument()
    expect(screen.queryByText("Saved later")).not.toBeInTheDocument()
    expect(screen.queryByText(/Berean|Cell /)).not.toBeInTheDocument()
  })

  it("marks every mention read without leaving the page", async () => {
    const user = userEvent.setup()
    renderInbox([
      comment({ commentId: "a", body: "@[alice] one" }),
      comment({ commentId: "b", createdAt: 1_700_000_000_100, body: "@[alice] two", cellRef: "GEN 1:2" }),
    ])
    expect(screen.getByTestId("notifications-unread-count")).toHaveTextContent("2")
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    await user.click(screen.getByTestId("notifications-actions"))
    await user.click(screen.getByRole("menuitem", { name: "Mark all as read" }))
    expect(screen.queryByTestId("notifications-unread-count")).not.toBeInTheDocument()
    expect(screen.getByTestId("location")).toHaveTextContent("/project/proj-1/editor/file/file-1")
  })

  it("marks one notification read from the right-click menu without opening it", async () => {
    const user = userEvent.setup()
    renderInbox([comment()])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    fireEvent.contextMenu(screen.getByRole("button", { name: /GEN 1:1/ }))
    await user.click(screen.getByRole("menuitem", { name: "Mark as read" }))
    expect(screen.queryByTestId("notification-unread-dot")).not.toBeInTheDocument()
    expect(screen.queryByTestId("notifications-unread-count")).not.toBeInTheDocument()
    expect(screen.getByTestId("location")).toHaveTextContent("/project/proj-1/editor/file/file-1")
    expect(screen.getByText("GEN 1:1")).toBeInTheDocument()
  })

  it("deletes one notification from the right-click menu after confirming", async () => {
    const user = userEvent.setup()
    renderInbox([
      comment(),
      comment({ commentId: "b", cellRef: "GEN 1:2", body: "@[alice] two" }),
    ])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    fireEvent.contextMenu(screen.getByRole("button", { name: /GEN 1:1/ }))
    await user.click(screen.getByRole("menuitem", { name: "Delete" }))
    expect(screen.getByRole("heading", { name: "Delete notification?" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Delete" }))
    expect(screen.queryByText("GEN 1:1")).not.toBeInTheDocument()
    expect(screen.getByText("GEN 1:2")).toBeInTheDocument()
  })

  it("shows only unread rows, and delete all read leaves the unread ones", async () => {
    const user = userEvent.setup()
    renderInbox([
      comment({ commentId: "a", body: "@[alice] one" }),
      comment({ commentId: "b", createdAt: 1_700_000_000_100, body: "@[alice] two", cellRef: "GEN 1:2" }),
    ])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    fireEvent.contextMenu(screen.getByRole("button", { name: /GEN 1:1/ }))
    await user.click(screen.getByRole("menuitem", { name: "Mark as read" }))

    await user.click(screen.getByTestId("notifications-unreads-only"))
    expect(screen.queryByText("GEN 1:1")).not.toBeInTheDocument()
    expect(screen.getByText("GEN 1:2")).toBeInTheDocument()

    await user.click(screen.getByTestId("notifications-unreads-only"))
    expect(screen.getByText("GEN 1:1")).toBeInTheDocument()

    await user.click(screen.getByTestId("notifications-actions"))
    await user.click(screen.getByRole("menuitem", { name: "Delete all read" }))
    expect(screen.getByRole("heading", { name: "Delete read notifications?" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Delete" }))
    expect(screen.queryByText("GEN 1:1")).not.toBeInTheDocument()
    expect(screen.getByText("GEN 1:2")).toBeInTheDocument()
  })
})
