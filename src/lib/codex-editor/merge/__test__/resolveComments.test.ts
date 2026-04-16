import { describe, it, expect } from "vitest"
import { resolveCommentsTwoWay } from "../resolveComments"
import type { CodexCommentThread, CodexComment } from "@/lib/codex-editor/types"

const c = (id: string, body: string, ts: number, author = "a"): CodexComment => ({
  id, body, timestamp: ts, mode: 0, deleted: false, author: { name: author },
})

const thread = (id: string, comments: CodexComment[], extras: Partial<CodexCommentThread> = {}): CodexCommentThread => ({
  id,
  cellId: { cellId: "cell-1" },
  comments,
  collapsibleState: 0,
  canReply: true,
  ...extras,
})

const file = (threads: CodexCommentThread[]) => JSON.stringify(
  Object.fromEntries(threads.map(t => [t.id, t])),
)

describe("resolveCommentsTwoWay", () => {
  it("unions disjoint threads", async () => {
    const ours = file([thread("t1", [c("c1", "hi", 1)])])
    const theirs = file([thread("t2", [c("c2", "hey", 2)])])
    const merged = JSON.parse(await resolveCommentsTwoWay(ours, theirs))
    expect(Object.keys(merged).sort()).toEqual(["t1", "t2"])
  })

  it("unions comments inside a shared thread by id", async () => {
    const ours = file([thread("t1", [c("c1", "hi", 1)])])
    const theirs = file([thread("t1", [c("c2", "hey", 2)])])
    const merged = JSON.parse(await resolveCommentsTwoWay(ours, theirs))
    expect(merged.t1.comments.map((x: CodexComment) => x.id).sort()).toEqual(["c1", "c2"])
  })

  it("dedupes legacy comments by (body, author)", async () => {
    const ours = file([thread("t1", [{ ...c("", "same", 1), id: "" }])])
    const theirs = file([thread("t1", [{ ...c("", "same", 1), id: "" }])])
    const merged = JSON.parse(await resolveCommentsTwoWay(ours, theirs))
    expect(merged.t1.comments).toHaveLength(1)
  })

  it("takes thread-level metadata from side with newer comment", async () => {
    const ours = file([thread("t1", [c("c1", "hi", 10)], { threadTitle: "Old" })])
    const theirs = file([thread("t1", [c("c2", "hey", 20)], { threadTitle: "New" })])
    const merged = JSON.parse(await resolveCommentsTwoWay(ours, theirs))
    expect(merged.t1.threadTitle).toBe("New")
  })

  it("unions deletionEvent arrays", async () => {
    const ev1 = { timestamp: 5, author: { name: "a" }, deleted: true }
    const ev2 = { timestamp: 7, author: { name: "b" }, deleted: true }
    const ours = file([thread("t1", [c("c1", "x", 1)], { deletionEvent: [ev1] })])
    const theirs = file([thread("t1", [c("c1", "x", 1)], { deletionEvent: [ev2] })])
    const merged = JSON.parse(await resolveCommentsTwoWay(ours, theirs))
    expect(merged.t1.deletionEvent).toHaveLength(2)
  })

  it("returns theirs when ours is empty", async () => {
    const out = await resolveCommentsTwoWay("", file([thread("t1", [])]))
    expect(JSON.parse(out).t1).toBeTruthy()
  })
})
