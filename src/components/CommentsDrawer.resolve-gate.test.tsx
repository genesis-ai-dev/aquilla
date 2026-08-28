/**
 * AQU-1000 — the Comments drawer decides resolve authority PER THREAD.
 *
 * Before this, the drawer computed `canPerform("comment.resolve", roleLevel)`
 * once and handed the same answer to every thread. The server does not work
 * that way: it compares the thread's `author_id` to the caller and applies a
 * higher floor when they differ. A Commenter was therefore offered Resolve on
 * other people's threads, and — because the write is optimistic — watched the
 * thread close and then spring back open when the 403 landed.
 *
 * These tests pin the decision itself: which threads get an offered control,
 * which get a refused one, and that the refusal names the missing role.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { CommentsDrawer } from "./CommentsDrawer"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { ROLE } from "@/lib/frontier/roles"

/**
 * Stand in for CommentThread and surface the gate decision as DOM attributes,
 * so each assertion is about what the drawer DECIDED rather than how the
 * button happens to be styled. CommentThread's own rendering of those three
 * states is covered in CommentThread.test.tsx.
 */
vi.mock("./CommentThread", () => ({
  CommentThread: ({
    thread,
    canResolve,
    resolveDenialReason,
  }: {
    thread: { id: string }
    canResolve?: boolean
    resolveDenialReason?: string | null
  }) => (
    <div
      data-testid={`thread-${thread.id}`}
      data-can-resolve={String(canResolve)}
      data-denial={resolveDenialReason ?? ""}
    />
  ),
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
  if (roleLevel === null) return base
  return {
    ...base,
    syncRole: { level: roleLevel, name: "test", source: "server", fetchedAt: new Date().toISOString() },
  }
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

function makeComment(commentId: string, authorId: string): CommentRecord {
  return {
    commentId,
    projectId: "proj-1",
    fileId: "file-1",
    cellId: "cell-1",
    parentCommentId: null,
    authorId,
    authorLabel: authorId,
    body: "A remark",
    resolved: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
    scopeKind: "cell",
    createdForTranslated: null,
  }
}

// One thread bob wrote, one alice wrote — the whole point is that the same
// reader gets different answers for these two rows.
const COMMENTS: CommentRecord[] = [makeComment("own-thread", "bob"), makeComment("foreign-thread", "alice")]

const noop = () => {}

function renderDrawer(roleLevel: number | null, currentUsername: string | null = "bob") {
  return render(
    <CommentsDrawer
      project={makeProject(roleLevel)}
      cell={CELL}
      liveComments={COMMENTS}
      onClose={noop}
      onNewThread={noop}
      onReply={noop}
      onResolve={noop}
      onReopen={noop}
      currentUsername={currentUsername}
    />,
  )
}

function gate(threadId: string) {
  const el = screen.getByTestId(`thread-${threadId}`)
  return { canResolve: el.getAttribute("data-can-resolve"), denial: el.getAttribute("data-denial") }
}

describe("CommentsDrawer — per-thread resolve gate (AQU-1000)", () => {
  it("offers Resolve on the reader's OWN thread but refuses it on someone else's, for a Commenter", () => {
    renderDrawer(ROLE.COMMENTER)
    expect(gate("own-thread").canResolve).toBe("true")
    expect(gate("foreign-thread").canResolve).toBe("false")
  })

  it("explains the refusal by naming the role that could do it", () => {
    renderDrawer(ROLE.COMMENTER)
    // Not a bare "you can't" — the sentence has to be actionable.
    expect(gate("foreign-thread").denial).toMatch(/contributor/i)
    expect(gate("own-thread").denial).toBe("")
  })

  it("still refuses a Reviewer (300) a foreign resolve — above commenter, below the foreign floor", () => {
    renderDrawer(ROLE.REVIEWER)
    expect(gate("own-thread").canResolve).toBe("true")
    expect(gate("foreign-thread").canResolve).toBe("false")
  })

  it("offers Resolve on every thread to a Contributor (400)", () => {
    renderDrawer(ROLE.CONTRIBUTOR)
    expect(gate("own-thread").canResolve).toBe("true")
    expect(gate("foreign-thread").canResolve).toBe("true")
  })

  it("offers Resolve on every thread to a Maintainer (600)", () => {
    renderDrawer(ROLE.MAINTAINER)
    expect(gate("own-thread").canResolve).toBe("true")
    expect(gate("foreign-thread").canResolve).toBe("true")
  })

  it("refuses a Viewer (100) on every thread, with the plain role denial", () => {
    renderDrawer(ROLE.VIEWER)
    expect(gate("own-thread").canResolve).toBe("false")
    expect(gate("foreign-thread").canResolve).toBe("false")
    // Below even the self floor, so the sentence is about the role bar itself.
    expect(gate("own-thread").denial).toMatch(/commenter/i)
  })

  it("treats a thread as foreign when the reader is anonymous", () => {
    // No session username to compare against: the server will still compare a
    // real author_id we cannot see, so the honest answer is the higher floor.
    renderDrawer(ROLE.COMMENTER, null)
    expect(gate("own-thread").canResolve).toBe("false")
    expect(gate("foreign-thread").canResolve).toBe("false")
  })

  it("leaves local / git-imported projects alone — no syncRole, no invented denial", () => {
    renderDrawer(null)
    expect(gate("own-thread").canResolve).toBe("true")
    expect(gate("foreign-thread").canResolve).toBe("true")
    expect(gate("foreign-thread").denial).toBe("")
  })
})
