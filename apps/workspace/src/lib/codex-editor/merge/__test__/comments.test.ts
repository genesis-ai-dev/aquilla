import { describe, it, expect } from "vitest"
import { areCommentsDuplicate, generateCommentId } from "../comments"

describe("generateCommentId", () => {
  it("returns a non-empty unique-ish string", () => {
    const a = generateCommentId()
    const b = generateCommentId()
    expect(a).toMatch(/.+/)
    expect(a).not.toBe(b)
  })
})

describe("areCommentsDuplicate", () => {
  it("matches by id", () => {
    expect(areCommentsDuplicate(
      { id: "1", body: "hi", author: { name: "a" }, timestamp: 1, mode: 0, deleted: false },
      { id: "1", body: "different", author: { name: "b" }, timestamp: 2, mode: 0, deleted: false },
    )).toBe(true)
  })
  it("matches by body+author when ids differ (legacy)", () => {
    expect(areCommentsDuplicate(
      { id: "1", body: "hi", author: { name: "a" }, timestamp: 1, mode: 0, deleted: false },
      { id: "2", body: "hi", author: { name: "a" }, timestamp: 9, mode: 0, deleted: false },
    )).toBe(true)
  })
  it("rejects different content", () => {
    expect(areCommentsDuplicate(
      { id: "1", body: "x", author: { name: "a" }, timestamp: 1, mode: 0, deleted: false },
      { id: "2", body: "y", author: { name: "a" }, timestamp: 1, mode: 0, deleted: false },
    )).toBe(false)
  })
})
