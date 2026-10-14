import { StrictMode } from "react"
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

function renderInbox(
  comments: CommentRecord[],
  { strict = false, files = [] }: { strict?: boolean; files?: { id: string; name: string }[] } = {},
) {
  const tree = (
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
                files={files}
              />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
    </>
  )
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree)
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
    const title = screen.getByText("GEN 1:1")
    const message = screen.getByText("Bob commented: Could @alice review this verse?")
    expect(title.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(title.className).toContain("font-medium")
    expect(screen.queryByText(/mentioned you/)).not.toBeInTheDocument()
    const dot = screen.getByTestId("notification-unread-dot")
    expect(dot.parentElement).toHaveTextContent("GEN 1:1")
    expect(screen.queryByText(/Cell /)).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Bob/ }))
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/project/proj-1/editor/file/file-1?cellId=cell-1&comments=1&commentId=c1",
    )
    expect(screen.queryByTestId("notifications-unread-count")).not.toBeInTheDocument()
  })

  it("titles a verse mention with the reference and file, then who commented", async () => {
    const user = userEvent.setup()
    renderInbox(
      [
        comment({ body: "@[alice] hello" }),
        comment({
          commentId: "file-note",
          scopeKind: "file",
          cellId: null,
          cellRef: null,
          body: "@[alice] on the file",
        }),
      ],
      { files: [{ id: "file-1", name: "Genesis.usfm" }] },
    )
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    const hello = screen.getByRole("button", { name: /@alice hello/ })
    const helloText = hello.textContent ?? ""
    expect(helloText.indexOf("GEN 1:1 in Genesis.usfm")).toBeLessThan(
      helloText.indexOf("Bob commented: @alice hello"),
    )
    const fileNote = screen.getByRole("button", { name: /@alice on the file/ })
    const fileNoteText = fileNote.textContent ?? ""
    expect(fileNoteText.indexOf("Genesis.usfm")).toBeLessThan(
      fileNoteText.indexOf("Bob commented: @alice on the file"),
    )
    expect(fileNoteText).not.toContain("GEN 1:1")
    expect(screen.getByText("GEN 1:1 in Genesis.usfm")).toBeInTheDocument()
    expect(screen.queryByText(/mentioned you/)).not.toBeInTheDocument()
    expect(screen.queryByText("File Genesis.usfm")).not.toBeInTheDocument()
  })

  it("shows who commented when a mention has no verse or file", async () => {
    const user = userEvent.setup()
    renderInbox([
      comment({
        scopeKind: "project",
        fileId: null,
        cellId: null,
        cellRef: null,
        body: "@[alice] hello from the inbox check",
      }),
    ])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    const title = screen.getByText("Bob commented: @alice hello from the inbox check")
    expect(title.className).toContain("font-medium")
    expect(screen.queryByText("Project")).not.toBeInTheDocument()
    expect(screen.queryByText(/mentioned you/)).not.toBeInTheDocument()
    const dot = screen.getByTestId("notification-unread-dot")
    expect(dot.parentElement).toHaveTextContent("Bob commented: @alice hello from the inbox check")
  })

  it("leaves verse and cell text off the row when a file name is shown", async () => {
    const user = userEvent.setup()
    renderInbox(
      [
        comment({
          cellRef: null,
          createdForTranslated: "Saved later",
          body: "@[alice] look",
        }),
      ],
      { files: [{ id: "file-1", name: "Genesis.usfm" }] },
    )
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    const row = screen.getByRole("button", { name: /@alice look/ })
    const text = row.textContent ?? ""
    expect(text.indexOf("Genesis.usfm")).toBeLessThan(text.indexOf("Bob commented: @alice look"))
    expect(text).not.toContain("GEN 1:1")
    expect(screen.queryByText("The Creation")).not.toBeInTheDocument()
    expect(screen.queryByText("Saved later")).not.toBeInTheDocument()
    expect(screen.queryByText(/Berean|Cell /)).not.toBeInTheDocument()
  })

  // Seen on dev after PR #1319: a cell whose canonical ref is its own id
  // titled the row "b7f7b6f9-c87b-4100-96cc-f3f2dfee7ade in Lesson 1.docx".
  it("titles a mention on a cell whose ref is only its id with the file name", async () => {
    const user = userEvent.setup()
    const opaque = "b7f7b6f9-c87b-4100-96cc-f3f2dfee7ade"
    renderInbox(
      [comment({ cellId: opaque, cellRef: opaque, body: "@[alice] see this" })],
      { files: [{ id: "file-1", name: "Lesson 1.docx" }] },
    )
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    const row = screen.getByRole("button", { name: /@alice see this/ })
    const text = row.textContent ?? ""
    expect(text.indexOf("Lesson 1.docx")).toBeLessThan(text.indexOf("Bob commented: @alice see this"))
    expect(text).not.toContain(opaque)
    expect(screen.getByText("Lesson 1.docx")).toBeInTheDocument()
    expect(screen.queryByText(/ in Lesson 1\.docx/)).not.toBeInTheDocument()
    await user.click(row)
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/project/proj-1/editor/file/file-1?cellId=${opaque}&comments=1&commentId=c1`,
    )
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
    await user.click(screen.getByRole("button", { name: /@alice two/ }))
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    const rows = screen.getAllByRole("button", { name: /commented:/ })
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("@alice two"),
      expect.stringContaining("@alice one"),
    ])
    expect(rows[0].querySelector("[data-testid=notification-unread-dot]")).toBeNull()
    expect(rows[1].querySelector("[data-testid=notification-unread-dot]")).toBeTruthy()
  })

  it("marks one notification read from the right-click menu without opening it", async () => {
    const user = userEvent.setup()
    renderInbox([comment()])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    fireEvent.contextMenu(screen.getByRole("button", { name: /Could @alice review this verse\?/ }))
    await user.click(screen.getByRole("menuitem", { name: "Mark as read" }))
    expect(screen.queryByTestId("notification-unread-dot")).not.toBeInTheDocument()
    expect(screen.queryByTestId("notifications-unread-count")).not.toBeInTheDocument()
    expect(screen.getByTestId("location")).toHaveTextContent("/project/proj-1/editor/file/file-1")
    expect(screen.getByText("Bob commented: Could @alice review this verse?")).toBeInTheDocument()
  })

  it("marks a read notification unread from the right-click menu", async () => {
    const user = userEvent.setup()
    renderInbox([comment()])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    fireEvent.contextMenu(screen.getByRole("button", { name: /Could @alice review this verse\?/ }))
    await user.click(screen.getByRole("menuitem", { name: "Mark as read" }))
    fireEvent.contextMenu(screen.getByRole("button", { name: /Could @alice review this verse\?/ }))
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
    fireEvent.contextMenu(screen.getByRole("button", { name: /Could @alice review this verse\?/ }))
    await user.click(screen.getByRole("menuitem", { name: "Delete notification" }))
    expect(screen.queryByRole("heading", { name: "Delete notification?" })).not.toBeInTheDocument()
    expect(document.querySelector(".lucide-mail-x")).toBeTruthy()
    expect(screen.queryByText("Bob commented: Could @alice review this verse?")).not.toBeInTheDocument()
    expect(screen.getByText("Bob commented: @alice two")).toBeInTheDocument()
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
    expect(screen.getByText("Bob commented: Could @alice review this verse?")).toBeInTheDocument()
    expect(screen.getByText("Bob commented: @alice two")).toBeInTheDocument()
  })

  it("undoes a deleted notification with ctrl+z", async () => {
    const user = userEvent.setup()
    renderInbox([comment()])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    fireEvent.contextMenu(screen.getByRole("button", { name: /Could @alice review this verse\?/ }))
    await user.click(screen.getByRole("menuitem", { name: "Delete notification" }))
    expect(screen.queryByText("Bob commented: Could @alice review this verse?")).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: "z", ctrlKey: true })
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument()
    expect(screen.getByText('Undo "Notification deleted"')).toBeInTheDocument()
    expect(document.querySelector("[data-slot='toast-icon']")).toBeTruthy()
    const trigger = screen.getByTestId("notifications-inbox-trigger")
    if (trigger.getAttribute("aria-expanded") !== "true") {
      await user.click(trigger)
    }
    expect(screen.getByText("Bob commented: Could @alice review this verse?")).toBeInTheDocument()
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
    const rows = screen.getAllByRole("button", { name: /note / })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(30)
    expect(screen.getByRole("button", { name: /note 29\b/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /note 0\b/ })).not.toBeInTheDocument()
  })

  it("does not highlight a row on open, then moves with the arrow keys and opens the focused one", async () => {
    const user = userEvent.setup()
    renderInbox([
      comment({ commentId: "a", body: "@[alice] one" }),
      comment({ commentId: "b", cellId: "cell-2", cellRef: "GEN 1:2", body: "@[alice] two" }),
    ])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    const first = screen.getByRole("button", { name: /@alice one\b/ })
    const second = screen.getByRole("button", { name: /@alice two\b/ })
    expect(first).not.toHaveAttribute("data-active")
    expect(second).not.toHaveAttribute("data-active")
    expect(first).not.toHaveFocus()
    await user.keyboard("{ArrowDown}")
    expect(first).toHaveFocus()
    expect(first).toHaveAttribute("data-active", "true")
    expect(second).not.toHaveAttribute("data-active")
    await user.keyboard("{ArrowDown}")
    expect(second).toHaveFocus()
    expect(second).toHaveAttribute("data-active", "true")
    expect(first).not.toHaveAttribute("data-active")
    await user.keyboard("{Enter}")
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/project/proj-1/editor/file/file-1?cellId=cell-2&comments=1&commentId=b",
    )
  })

  it("moves the highlight on the first open even when focus is still outside the inbox", async () => {
    const user = userEvent.setup()
    renderInbox(
      [
        comment({ commentId: "a", body: "@[alice] one" }),
        comment({ commentId: "b", cellId: "cell-2", cellRef: "GEN 1:2", body: "@[alice] two" }),
      ],
      { strict: true },
    )
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    const outside = document.activeElement
    if (outside instanceof HTMLElement) outside.blur()
    const first = screen.getByRole("button", { name: /@alice one\b/ })
    expect(first).not.toHaveFocus()
    await user.keyboard("{ArrowDown}")
    expect(first).toHaveAttribute("data-active", "true")
    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("button", { name: /@alice two\b/ })).toHaveAttribute("data-active", "true")
  })

  it("moves the highlight when arrow keys land on the inbox shell or the unread filter", async () => {
    const user = userEvent.setup()
    renderInbox([
      comment({ commentId: "a", body: "@[alice] one" }),
      comment({ commentId: "b", cellId: "cell-2", cellRef: "GEN 1:2", body: "@[alice] two" }),
    ])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    const first = screen.getByRole("button", { name: /@alice one\b/ })
    const second = screen.getByRole("button", { name: /@alice two\b/ })
    const popup = document.querySelector("[data-slot='popover-content']")
    if (!(popup instanceof HTMLElement)) throw new Error("inbox popover missing")
    popup.focus()
    expect(popup).toHaveFocus()
    await user.keyboard("{ArrowDown}")
    expect(first).toHaveFocus()
    expect(first).toHaveAttribute("data-active", "true")
    screen.getByTestId("notifications-unreads-only").focus()
    await user.keyboard("{ArrowDown}")
    expect(second).toHaveFocus()
    expect(second).toHaveAttribute("data-active", "true")
    expect(first).not.toHaveAttribute("data-active")
  })

  it("leaves the actions menu in charge of its own arrow keys", async () => {
    const user = userEvent.setup()
    renderInbox([comment({ commentId: "a", body: "@[alice] one" })])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    await user.click(screen.getByTestId("notifications-actions"))
    expect(await screen.findByRole("menuitem", { name: "Mark all as read" })).toBeInTheDocument()
    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("button", { name: /@alice one\b/ })).not.toHaveAttribute("data-active")
  })

  it("highlights the last row when ArrowUp is pressed before any row is highlighted", async () => {
    const user = userEvent.setup()
    renderInbox([
      comment({ commentId: "a", body: "@[alice] one" }),
      comment({ commentId: "b", cellId: "cell-2", cellRef: "GEN 1:2", body: "@[alice] two" }),
    ])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    const first = screen.getByRole("button", { name: /@alice one\b/ })
    const second = screen.getByRole("button", { name: /@alice two\b/ })
    await user.keyboard("{ArrowUp}")
    expect(second).toHaveFocus()
    expect(second).toHaveAttribute("data-active", "true")
    expect(first).not.toHaveAttribute("data-active")
  })

  it("shows only unread rows, and delete all read leaves the unread ones", async () => {
    const user = userEvent.setup()
    renderInbox([
      comment({ commentId: "a", body: "@[alice] one" }),
      comment({ commentId: "b", createdAt: 1_700_000_000_100, body: "@[alice] two", cellRef: "GEN 1:2" }),
    ])
    await user.click(screen.getByTestId("notifications-inbox-trigger"))
    fireEvent.contextMenu(screen.getByRole("button", { name: /@alice one\b/ }))
    await user.click(screen.getByRole("menuitem", { name: "Mark as read" }))

    await user.click(screen.getByTestId("notifications-unreads-only"))
    expect(screen.queryByText("Bob commented: @alice one")).not.toBeInTheDocument()
    expect(screen.getByText("Bob commented: @alice two")).toBeInTheDocument()

    await user.click(screen.getByTestId("notifications-unreads-only"))
    expect(screen.getByText("Bob commented: @alice one")).toBeInTheDocument()

    await user.click(screen.getByTestId("notifications-actions"))
    await user.click(screen.getByRole("menuitem", { name: "Delete all read" }))
    expect(screen.getByRole("heading", { name: "Delete read notifications?" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Delete" }))
    expect(screen.queryByText("Bob commented: @alice one")).not.toBeInTheDocument()
    expect(screen.getByText("Bob commented: @alice two")).toBeInTheDocument()
  })
})
