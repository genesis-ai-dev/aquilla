import { describe, expect, it } from "vitest"
import { splitCommentThreads } from "./comment-threads"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

function comment(commentId: string, parentCommentId: string | null = null): CommentRecord {
  return {
    commentId,
    projectId: "p1",
    scopeKind: "cell",
    fileId: "f1",
    cellId: "c1",
    parentCommentId,
    body: commentId,
    resolved: false,
    authorId: "u1",
    authorLabel: "Alice",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }
}

describe("splitCommentThreads", () => {
  it("separates roots from replies and keys replies by their parent", () => {
    const { roots, repliesByParent } = splitCommentThreads([
      comment("r1"),
      comment("a", "r1"),
      comment("r2"),
      comment("b", "r1"),
      comment("c", "r2"),
    ])

    expect(roots.map((r) => r.commentId)).toEqual(["r1", "r2"])
    expect(repliesByParent.get("r1")?.map((r) => r.commentId)).toEqual(["a", "b"])
    expect(repliesByParent.get("r2")?.map((r) => r.commentId)).toEqual(["c"])
  })

  it("keeps an orphaned reply out of the root list rather than rendering it as a thread", () => {
    // A reply whose root is not in this page of results (or was hard-deleted)
    // must not be promoted to a thread of its own.
    const { roots, repliesByParent } = splitCommentThreads([comment("orphan", "missing-root")])
    expect(roots).toEqual([])
    expect(repliesByParent.get("missing-root")?.map((r) => r.commentId)).toEqual(["orphan"])
  })
})
