import { describe, it, expect } from "vitest"
import { resolveMetadataTwoWay } from "../resolveMetadata"

describe("resolveMetadataTwoWay", () => {
  it("unions metadata.edits by (timestamp, editMap, value)", async () => {
    const ours = JSON.stringify({
      projectName: "proj",
      edits: [{ editMap: ["projectName"], value: "proj", timestamp: 1, author: "a", type: "user-edit" }],
    })
    const theirs = JSON.stringify({
      projectName: "new",
      edits: [{ editMap: ["projectName"], value: "new", timestamp: 10, author: "b", type: "user-edit" }],
    })
    const merged = JSON.parse(await resolveMetadataTwoWay(ours, theirs))
    expect(merged.edits).toHaveLength(2)
    expect(merged.projectName).toBe("new")
  })

  it("prefers theirs for keys with no edit trail", async () => {
    const ours = JSON.stringify({ legacyField: "old" })
    const theirs = JSON.stringify({ legacyField: "theirs-wins" })
    const merged = JSON.parse(await resolveMetadataTwoWay(ours, theirs))
    expect(merged.legacyField).toBe("theirs-wins")
  })

  it("keeps both-sides-only keys", async () => {
    const ours = JSON.stringify({ a: 1 })
    const theirs = JSON.stringify({ b: 2 })
    const merged = JSON.parse(await resolveMetadataTwoWay(ours, theirs))
    expect(merged).toMatchObject({ a: 1, b: 2 })
  })

  it("returns theirs when ours is empty", async () => {
    const out = await resolveMetadataTwoWay("", JSON.stringify({ a: 1 }))
    expect(JSON.parse(out)).toEqual({ a: 1 })
  })
})
