/**
 * AQU-427 — Tests that CommentsDrawer correctly gates the comment UI
 * by role level and shows a human-readable denial for unpermitted roles.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { CommentsDrawer } from "./CommentsDrawer"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { ROLE } from "@/lib/frontier/roles"

// CommentsDrawer renders CommentThread — mock it to avoid deep render trees.
vi.mock("./CommentThread", () => ({
  CommentThread: () => <div data-testid="comment-thread" />,
}))

function makeProject(roleLevel: number | null): ProjectRecord {
  const base: ProjectRecord = {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
  }
  if (roleLevel !== null) {
    return {
      ...base,
      syncRole: { level: roleLevel, name: "test", source: "server", fetchedAt: new Date().toISOString() },
    }
  }
  return base
}

const CELL: CellData = {
  id: "cell-1",
  fileId: "file-1",
  original: "Hello",
  translated: "Bonjour",
  context: "GEN 1:1",
  group: "g1",
  type: "text",
  status: "unvalidated",
  validationStatus: "none",
  activeValidators: [],
  validationHistory: [],
  history: [],
  threads: [],
}

const noop = () => {}

function renderDrawer(project: ProjectRecord) {
  return render(
    <CommentsDrawer
      project={project}
      cell={CELL}
      onClose={noop}
      onNewThread={noop}
      onReply={noop}
      onResolve={noop}
      onReopen={noop}
    />,
  )
}

describe("CommentsDrawer — comment input gating (AQU-427)", () => {
  it("shows New-thread textarea for COMMENTER (200) — can comment", () => {
    renderDrawer(makeProject(ROLE.COMMENTER))
    expect(screen.getByRole("textbox")).toBeInTheDocument()
    expect(screen.queryByTestId("comments-drawer-denial")).not.toBeInTheDocument()
  })

  it("shows New-thread textarea for CONTRIBUTOR (400)", () => {
    renderDrawer(makeProject(ROLE.CONTRIBUTOR))
    expect(screen.getByRole("textbox")).toBeInTheDocument()
    expect(screen.queryByTestId("comments-drawer-denial")).not.toBeInTheDocument()
  })

  it("hides textarea and shows denial message for VIEWER (100)", () => {
    renderDrawer(makeProject(ROLE.VIEWER))
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    const denial = screen.getByTestId("comments-drawer-denial")
    expect(denial).toBeInTheDocument()
    // The message must name the minimum role, not just say "read-only"
    expect(denial.textContent).toMatch(/commenter/i)
  })

  it("hides textarea and shows denial message for low unknown level (50)", () => {
    renderDrawer(makeProject(50))
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    const denial = screen.getByTestId("comments-drawer-denial")
    expect(denial.textContent).toMatch(/commenter/i)
  })

  it("shows New-thread textarea for local project (no syncRole)", () => {
    // Local projects have no syncRole — legacy behaviour: canEditComments=true.
    renderDrawer(makeProject(null))
    expect(screen.getByRole("textbox")).toBeInTheDocument()
  })
})

describe("CommentsDrawer — the new-thread field has a real accessible name", () => {
  /**
   * AQU-1338: the composer's only name used to be its placeholder, which
   * disappears on the first keystroke and which screen readers and DOM-reading
   * agents may never announce. A live Jev journey stalled on this field.
   */
  it("names the field from the visible heading, not the placeholder", () => {
    renderDrawer(makeProject(ROLE.COMMENTER))
    const field = screen.getByRole("textbox", { name: "New thread" })
    expect(field).toBeInTheDocument()
    expect(field.getAttribute("aria-labelledby")).toBe(
      screen.getByText("New thread").getAttribute("id"),
    )
  })

  it("keeps the placeholder as an additional hint", () => {
    renderDrawer(makeProject(ROLE.COMMENTER))
    expect(screen.getByRole("textbox", { name: "New thread" }))
      .toHaveAttribute("placeholder", "Start a new comment thread...")
  })
})
