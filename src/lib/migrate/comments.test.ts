import { describe, it, expect } from "vitest"
import type { CodexCommentsFile } from "../codex-editor/types"
import { mapComments } from "./comments"
import { fileIdFor } from "./ids"

const OPTS = { projectId: "p", projectKey: "k", fallbackTs: 1 }

function file(): CodexCommentsFile {
  return {
    t1: {
      id: "t1",
      cellId: { cellId: "cue1", uri: "files/target/Book-abc.codex" },
      comments: [
        { id: "c1", timestamp: 10, body: "first", mode: 1, deleted: false, author: { name: "keithmiller" } },
        { id: "c2", timestamp: 20, body: "reply", mode: 1, deleted: false, author: { name: "randall" } },
        { id: "c3", timestamp: 30, body: "gone", mode: 1, deleted: true, author: { name: "x" } },
      ],
      collapsibleState: 0,
      canReply: true,
      resolvedEvent: [{ timestamp: 40, author: { name: "keithmiller" }, resolved: true }],
    },
    t2: {
      id: "t2",
      cellId: { cellId: "cue2", uri: "files/target/Book-abc.codex" },
      comments: [{ id: "c9", timestamp: 5, body: "x", mode: 1, deleted: false, author: { name: "a" } }],
      collapsibleState: 0,
      canReply: true,
      deletionEvent: [{ timestamp: 6, author: { name: "a" }, deleted: true }],
    },
  }
}

describe("mapComments", () => {
  it("maps live comments to comment.create, threads replies under the root, derives fileId from uri", () => {
    const ev = mapComments(file(), OPTS)
    const creates = ev.filter((e) => e.kind === "comment.create")
    expect(creates).toHaveLength(2) // c1, c2 (c3 deleted); t2 thread is deleted
    const fileId = fileIdFor("k", "Book-abc")
    expect(creates[0].payload).toMatchObject({
      commentId: "c1",
      parentCommentId: null,
      scope: { kind: "cell", fileId, cellId: "cue1" },
    })
    expect(creates[1].payload).toMatchObject({ commentId: "c2", parentCommentId: "c1" })
    expect(creates[0].author).toBe("keithmiller")
  })

  it("emits comment.resolve for resolved threads, keyed on the root comment", () => {
    const resolves = mapComments(file(), OPTS).filter((e) => e.kind === "comment.resolve")
    expect(resolves).toHaveLength(1)
    expect(resolves[0].payload).toMatchObject({ commentId: "c1", resolved: true })
  })

  it("skips deleted threads entirely", () => {
    expect(mapComments(file(), OPTS).some((e) => e.cellId === "cue2")).toBe(false)
  })

  it("accepts the array container shape too (legacy desktop wrote both)", () => {
    const asArray = Object.values(file())
    expect(mapComments(asArray, OPTS).filter((e) => e.kind === "comment.create")).toHaveLength(2)
  })

  it("is idempotent", () => {
    expect(mapComments(file(), OPTS)).toEqual(mapComments(file(), OPTS))
  })
})
