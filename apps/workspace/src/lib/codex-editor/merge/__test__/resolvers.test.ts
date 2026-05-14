import { describe, it, expect } from "vitest"
import { resolveTwoWay } from "../resolvers"

describe("resolveTwoWay", () => {
  it("routes .codex paths to resolveCodexTwoWay", async () => {
    const ours = JSON.stringify({ cells: [], metadata: { id: "f", originalName: "f" } })
    const theirs = JSON.stringify({ cells: [], metadata: { id: "f", originalName: "f" } })
    const out = await resolveTwoWay("files/target/gen.codex", ours, theirs)
    expect(JSON.parse(out).cells).toEqual([])
  })

  it("routes comments.json to resolveCommentsTwoWay", async () => {
    const ours = JSON.stringify({})
    const theirs = JSON.stringify({})
    const out = await resolveTwoWay(".project/comments.json", ours, theirs)
    expect(JSON.parse(out)).toEqual({})
  })

  it("takes ours for IGNORE strategy", async () => {
    const out = await resolveTwoWay("complete_drafts.txt", "ours", "theirs")
    expect(out).toBe("ours")
  })

  it("takes theirs for OVERRIDE strategy", async () => {
    const out = await resolveTwoWay("files/media/clip.mp4", "ours", "theirs")
    expect(out).toBe("theirs")
  })
})
