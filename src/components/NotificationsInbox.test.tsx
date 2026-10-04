import { beforeEach, describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
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
    expect(screen.getByText("Bob")).toBeInTheDocument()
    expect(screen.getByText("GEN 1:1")).toBeInTheDocument()
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
    await user.click(screen.getByRole("button", { name: "Mark all as read" }))
    expect(screen.queryByTestId("notifications-unread-count")).not.toBeInTheDocument()
    expect(screen.getByTestId("location")).toHaveTextContent("/project/proj-1/editor/file/file-1")
  })
})
