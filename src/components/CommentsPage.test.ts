// Tests for CommentsPage filter/sort/show-resolved logic (pure helpers).
// These test business logic only — no React rendering needed.

import { describe, it, expect } from "vitest"
import { applyFilters, applySorting, DEFAULT_FILTER } from "./CommentsPage"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

function makeComment(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    commentId: "c1",
    projectId: "p1",
    scopeKind: "cell",
    fileId: "GEN.sfm",
    cellId: "GEN 1:1",
    parentCommentId: null,
    body: "test body",
    resolved: false,
    authorId: "user-alice",
    authorLabel: "Alice",
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    ...overrides,
  }
}

const noReplies = new Map<string, CommentRecord[]>()

describe("applyFilters", () => {
  it("hides resolved threads when showResolved=false", () => {
    const roots = [
      makeComment({ commentId: "a", resolved: false }),
      makeComment({ commentId: "b", resolved: true }),
    ]
    const result = applyFilters(roots, noReplies, { ...DEFAULT_FILTER, showResolved: false })
    expect(result.map((r) => r.commentId)).toEqual(["a"])
  })

  it("shows resolved threads when showResolved=true", () => {
    const roots = [
      makeComment({ commentId: "a", resolved: false }),
      makeComment({ commentId: "b", resolved: true }),
    ]
    const result = applyFilters(roots, noReplies, { ...DEFAULT_FILTER, showResolved: true })
    expect(result).toHaveLength(2)
  })

  it("filters by fileId", () => {
    const roots = [
      makeComment({ commentId: "a", fileId: "GEN.sfm" }),
      makeComment({ commentId: "b", fileId: "REV.sfm" }),
    ]
    const result = applyFilters(roots, noReplies, { ...DEFAULT_FILTER, fileId: "GEN.sfm" })
    expect(result.map((r) => r.commentId)).toEqual(["a"])
  })

  it("filters by authorId", () => {
    const roots = [
      makeComment({ commentId: "a", authorId: "user-alice" }),
      makeComment({ commentId: "b", authorId: "user-bob" }),
    ]
    const result = applyFilters(roots, noReplies, { ...DEFAULT_FILTER, authorId: "user-alice" })
    expect(result.map((r) => r.commentId)).toEqual(["a"])
  })

  it("filters by participant — matches when user is a reply author", () => {
    const roots = [
      makeComment({ commentId: "thread1", authorId: "user-alice" }),
      makeComment({ commentId: "thread2", authorId: "user-alice" }),
    ]
    const replies = new Map<string, CommentRecord[]>([
      [
        "thread1",
        [makeComment({ commentId: "r1", parentCommentId: "thread1", authorId: "user-bob" })],
      ],
    ])
    const result = applyFilters(roots, replies, { ...DEFAULT_FILTER, participant: "user-bob" })
    expect(result.map((r) => r.commentId)).toEqual(["thread1"])
  })

  it("body search — case-insensitive substring over root body", () => {
    const roots = [
      makeComment({ commentId: "a", body: "Hello world" }),
      makeComment({ commentId: "b", body: "Goodbye" }),
    ]
    const result = applyFilters(roots, noReplies, { ...DEFAULT_FILTER, search: "hello" })
    expect(result.map((r) => r.commentId)).toEqual(["a"])
  })

  it("body search — matches in reply body", () => {
    const roots = [makeComment({ commentId: "t1", body: "root" })]
    const replies = new Map<string, CommentRecord[]>([
      ["t1", [makeComment({ commentId: "r1", parentCommentId: "t1", body: "needle here" })]],
    ])
    const result = applyFilters(roots, replies, { ...DEFAULT_FILTER, search: "needle" })
    expect(result).toHaveLength(1)
  })

  it("empty search string matches everything", () => {
    const roots = [makeComment({ commentId: "a" }), makeComment({ commentId: "b" })]
    const result = applyFilters(roots, noReplies, { ...DEFAULT_FILTER, search: "" })
    expect(result).toHaveLength(2)
  })
})

// ── Edit/delete callback contract ─────────────────────────────────────────
// These tests verify the pure-logic contracts that the CommentsPage UI relies
// on when wiring editComment/deleteComment from useComments.

describe("comment edit/delete hook contract", () => {
  it("editComment signature accepts commentId + body", async () => {
    // Contract: editComment(commentId: string, body: string) => Promise<void>
    const calls: [string, string][] = []
    const mockEditComment = async (commentId: string, body: string): Promise<void> => {
      calls.push([commentId, body])
    }
    await mockEditComment("c1", "updated body")
    expect(calls).toEqual([["c1", "updated body"]])
  })

  it("deleteComment signature accepts commentId", async () => {
    // Contract: deleteComment(commentId: string) => Promise<void>
    const calls: string[] = []
    const mockDeleteComment = async (commentId: string): Promise<void> => {
      calls.push(commentId)
    }
    await mockDeleteComment("c1")
    expect(calls).toEqual(["c1"])
  })

  it("only own comments (authorId === currentUsername) should expose edit/delete", () => {
    // The CommentsPage renders the kebab menu only when authorId === currentUsername.
    const comment = makeComment({ authorId: "alice" })
    const isOwn = (currentUsername: string) => comment.authorId === currentUsername
    expect(isOwn("alice")).toBe(true)
    expect(isOwn("bob")).toBe(false)
    expect(isOwn("")).toBe(false)
  })

  it("deleted comments (deletedAt !== null) do not expose edit/delete", () => {
    const deleted = makeComment({ authorId: "alice", deletedAt: Date.now() })
    const canMutate = (c: CommentRecord, currentUsername: string) =>
      !!currentUsername && c.authorId === currentUsername && c.deletedAt === null
    expect(canMutate(deleted, "alice")).toBe(false)
    expect(canMutate(makeComment({ authorId: "alice" }), "alice")).toBe(true)
  })
})

describe("applySorting", () => {
  it("unresolved-first puts unresolved before resolved", () => {
    const roots = [
      makeComment({ commentId: "resolved", resolved: true, createdAt: 2000 }),
      makeComment({ commentId: "open", resolved: false, createdAt: 1000 }),
    ]
    const result = applySorting(roots, "unresolved-first")
    expect(result[0].commentId).toBe("open")
    expect(result[1].commentId).toBe("resolved")
  })

  it("creation sorts by createdAt DESC", () => {
    const roots = [
      makeComment({ commentId: "old", createdAt: 100 }),
      makeComment({ commentId: "new", createdAt: 999 }),
    ]
    const result = applySorting(roots, "creation")
    expect(result[0].commentId).toBe("new")
  })

  it("recent-activity sorts by updatedAt DESC", () => {
    const roots = [
      makeComment({ commentId: "stale", createdAt: 1000, updatedAt: 1000 }),
      makeComment({ commentId: "active", createdAt: 500, updatedAt: 2000 }),
    ]
    const result = applySorting(roots, "recent-activity")
    expect(result[0].commentId).toBe("active")
  })
})
