// AQU-1958: the export's labels come from the page, so this is the test that
// pins "the file says what the screen says" — project and file names, the cell
// reference the row shows, and the deleted-file tombstone.

import { describe, expect, it } from "vitest"
import { buildCommentCsvThreads } from "./comments-export-threads"
import { cellPlaceKey } from "./comments-cell-preview"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

function comment(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    commentId: "c1",
    projectId: "p1",
    scopeKind: "cell",
    fileId: "f1",
    cellId: "cell-1",
    parentCommentId: null,
    body: "body",
    resolved: false,
    authorId: "u1",
    authorLabel: "Anastasia",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  }
}

const projectNames = new Map([["p1", "Oromo NT"]])
const fileMap = new Map([["f1", "Genesis"]])

describe("buildCommentCsvThreads", () => {
  it("carries the project and file display names, never the ids", () => {
    const [thread] = buildCommentCsvThreads({
      roots: [comment()],
      repliesByParent: new Map(),
      projectNames,
      fileMap,
    })
    expect(thread.projectName).toBe("Oromo NT")
    expect(thread.fileName).toBe("Genesis")
  })

  it("attaches each root's replies", () => {
    const reply = comment({ commentId: "c2", parentCommentId: "c1" })
    const [thread] = buildCommentCsvThreads({
      roots: [comment()],
      repliesByParent: new Map([["c1", [reply]]]),
      projectNames,
      fileMap,
    })
    expect(thread.replies).toEqual([reply])
  })

  it("prefers the resolved place over the raw cell ref, and falls back to it", () => {
    const withPlace = buildCommentCsvThreads({
      roots: [comment({ cellRef: "GEN 1:1" })],
      repliesByParent: new Map(),
      projectNames,
      fileMap,
      places: new Map([[cellPlaceKey("f1", "cell-1"), "Genesis 1:1"]]),
    })
    expect(withPlace[0].reference).toBe("Genesis 1:1")

    const refOnly = buildCommentCsvThreads({
      roots: [comment({ cellRef: "GEN 1:1" })],
      repliesByParent: new Map(),
      projectNames,
      fileMap,
    })
    expect(refOnly[0].reference).toBe("Genesis 1:1")

    const neither = buildCommentCsvThreads({
      roots: [comment({ cellRef: null })],
      repliesByParent: new Map(),
      projectNames,
      fileMap,
    })
    expect(neither[0].reference).toBe("")
  })

  it("tombstones a deleted file instead of exporting its id", () => {
    const [thread] = buildCommentCsvThreads({
      roots: [comment({ fileId: "f-gone" })],
      repliesByParent: new Map(),
      projectNames,
      fileMap,
    })
    expect(thread.fileName).toBe("Deleted file")
  })

  it("leaves file and reference empty for a project-scoped thread", () => {
    const [thread] = buildCommentCsvThreads({
      roots: [comment({ scopeKind: "project", fileId: null, cellId: null })],
      repliesByParent: new Map(),
      projectNames,
      fileMap,
    })
    expect(thread.fileName).toBe("")
    expect(thread.reference).toBe("")
  })

  it("keeps the caller's order — the export is the visible list", () => {
    const threads = buildCommentCsvThreads({
      roots: [comment({ commentId: "second" }), comment({ commentId: "first" })],
      repliesByParent: new Map(),
      projectNames,
      fileMap,
    })
    expect(threads.map((t) => t.root.commentId)).toEqual(["second", "first"])
  })
})
