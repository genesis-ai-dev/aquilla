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

  it("does not let a __proto__ key repoint the merged object's prototype", async () => {
    const ours = JSON.stringify({ a: 1 })
    const theirs = '{"__proto__":{"polluted":true},"a":2}'
    const out = await resolveJsonMergeTwoWay(ours, theirs)
    const merged = JSON.parse(out) as Record<string, unknown>
    expect(merged.a).toBe(2)
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it("drops constructor/prototype keys instead of merging them", async () => {
    const ours = JSON.stringify({ a: 1 })
    const theirs = JSON.stringify({ constructor: { x: 1 }, prototype: { y: 2 } })
    const merged = JSON.parse(await resolveJsonMergeTwoWay(ours, theirs)) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(merged, "constructor")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(merged, "prototype")).toBe(false)
  })
})
