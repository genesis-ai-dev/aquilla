import { describe, it, expect, vi } from "vitest"
import { resolveJsonMergeTwoWay } from "../resolveJsonMerge"

describe("resolveJsonMergeTwoWay", () => {
  it("deep-merges nested objects", async () => {
    const ours = JSON.stringify({ a: { x: 1 }, b: 2 })
    const theirs = JSON.stringify({ a: { y: 2 }, c: 3 })
    const merged = JSON.parse(await resolveJsonMergeTwoWay(ours, theirs))
    expect(merged).toEqual({ a: { x: 1, y: 2 }, b: 2, c: 3 })
  })

  it("concatenates and dedupes arrays", async () => {
    const ours = JSON.stringify({ tags: ["a", "b"] })
    const theirs = JSON.stringify({ tags: ["b", "c"] })
    const merged = JSON.parse(await resolveJsonMergeTwoWay(ours, theirs))
    expect(merged.tags).toEqual(["a", "b", "c"])
  })

  it("takes theirs on scalar conflict and logs a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const ours = JSON.stringify({ k: "ours" })
    const theirs = JSON.stringify({ k: "theirs" })
    const merged = JSON.parse(await resolveJsonMergeTwoWay(ours, theirs))
    expect(merged.k).toBe("theirs")
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("returns theirs when ours is empty", async () => {
    const out = await resolveJsonMergeTwoWay("", JSON.stringify({ a: 1 }))
    expect(JSON.parse(out)).toEqual({ a: 1 })
  })
})
