import { beforeEach, describe, expect, it } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { NotificationsInbox } from "./NotificationsInbox"
import { Toaster, toast } from "@/components/ui/toast"
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
    <>
    <Toaster />
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
    </MemoryRouter>
    </>
  )
}

describe("NotificationsInbox", () => {
  beforeEach(() => {
    localStorage.clear()
    resetMentionReadStateForTests()
    toast.close()
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

  it("keeps a clicked notification where it was and only marks it read", async () => {
    const user = userEvent.setup()
    renderInbox([
      comment({ commentId: "older", body: "@[alice] one" }),
      comment({
        commentId: "newer",
        cellId: "cell-2",
        cellRef: "GEN 1:2",
        createdAt: 1_700_000_000_100,
        body: "@[alice] two",
      }),
    ])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    await user.click(screen.getByRole("button", { name: /GEN 1:2/ }))
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    const rows = screen.getAllByRole("button", { name: /GEN 1:/ })
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("GEN 1:2"),
      expect.stringContaining("GEN 1:1"),
    ])
    expect(rows[0].querySelector("[data-testid=notification-unread-dot]")).toBeNull()
    expect(rows[1].querySelector("[data-testid=notification-unread-dot]")).toBeTruthy()
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

  it("marks a read notification unread from the right-click menu", async () => {
    const user = userEvent.setup()
    renderInbox([comment()])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    fireEvent.contextMenu(screen.getByRole("button", { name: /GEN 1:1/ }))
    await user.click(screen.getByRole("menuitem", { name: "Mark as read" }))
    fireEvent.contextMenu(screen.getByRole("button", { name: /GEN 1:1/ }))
    expect(screen.queryByRole("menuitem", { name: "Mark as read" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("menuitem", { name: "Mark unread" }))
    expect(screen.getByTestId("notification-unread-dot")).toBeInTheDocument()
    expect(screen.getByTestId("notifications-unread-count")).toHaveTextContent("1")
    expect(screen.getByTestId("location")).toHaveTextContent("/project/proj-1/editor/file/file-1")
  })

  it("deletes one notification immediately and restores it from the undo toast", async () => {
    const user = userEvent.setup()
    renderInbox([
      comment(),
      comment({ commentId: "b", cellRef: "GEN 1:2", body: "@[alice] two" }),
    ])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    fireEvent.contextMenu(screen.getByRole("button", { name: /GEN 1:1/ }))
    await user.click(screen.getByRole("menuitem", { name: "Delete notification" }))
    expect(screen.queryByRole("heading", { name: "Delete notification?" })).not.toBeInTheDocument()
    expect(document.querySelector(".lucide-mail-x")).toBeTruthy()
    expect(screen.queryByText("GEN 1:1")).not.toBeInTheDocument()
    expect(screen.getByText("GEN 1:2")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Undo" }))
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument()
    expect(screen.getByText("Notification deleted")).toBeInTheDocument()
    expect(screen.getByText('Undo "Notification deleted"')).toBeInTheDocument()
    expect(document.querySelector("[data-slot='toast-icon']")).toBeTruthy()
    expect(screen.getAllByRole("button", { name: "Close toast" }).length).toBeGreaterThanOrEqual(2)
    const trigger = screen.getByTestId("notifications-inbox-trigger")
    if (trigger.getAttribute("aria-expanded") !== "true") {
      await user.click(trigger)
    }
    expect(screen.getByText("GEN 1:1")).toBeInTheDocument()
    expect(screen.getByText("GEN 1:2")).toBeInTheDocument()
  })

  it("undoes a deleted notification with ctrl+z", async () => {
    const user = userEvent.setup()
    renderInbox([comment()])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    fireEvent.contextMenu(screen.getByRole("button", { name: /GEN 1:1/ }))
    await user.click(screen.getByRole("menuitem", { name: "Delete notification" }))
    expect(screen.queryByText("GEN 1:1")).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: "z", ctrlKey: true })
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument()
    expect(screen.getByText('Undo "Notification deleted"')).toBeInTheDocument()
    expect(document.querySelector("[data-slot='toast-icon']")).toBeTruthy()
    const trigger = screen.getByTestId("notifications-inbox-trigger")
    if (trigger.getAttribute("aria-expanded") !== "true") {
      await user.click(trigger)
    }
    expect(screen.getByText("GEN 1:1")).toBeInTheDocument()
  })

  it("virtualizes a long list instead of painting every row", async () => {
    const user = userEvent.setup()
    renderInbox(
      Array.from({ length: 30 }, (_, index) =>
        comment({
          commentId: `c${index}`,
          cellId: `cell-${index}`,
          cellRef: `GEN 2:${index + 1}`,
          body: `@[alice] note ${index}`,
          createdAt: 1_700_000_000_000 + index,
        }),
      ),
    )
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    const rows = screen.getAllByRole("button", { name: /GEN 2:/ })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(30)
    expect(screen.getByRole("button", { name: /GEN 2:30\b/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /GEN 2:1\b/ })).not.toBeInTheDocument()
  })

  it("moves through notifications with the arrow keys and opens the focused one", async () => {
    const user = userEvent.setup()
    renderInbox([
      comment({ commentId: "a", body: "@[alice] one" }),
      comment({ commentId: "b", cellId: "cell-2", cellRef: "GEN 1:2", body: "@[alice] two" }),
    ])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    const first = screen.getByRole("button", { name: /GEN 1:1/ })
    const second = screen.getByRole("button", { name: /GEN 1:2/ })
    expect(first).toHaveFocus()
    await user.keyboard("{ArrowDown}")
    expect(second).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/project/proj-1/editor/file/file-1?cellId=cell-2&comments=1&commentId=b",
    )
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
