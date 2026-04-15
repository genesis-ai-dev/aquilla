import { describe, it, expect } from "vitest"
import { mergeValidatedByLists, isValidValidationEntry } from "../validators"
import type { ValidationEntry } from "@/lib/codex-editor/types"

describe("isValidValidationEntry", () => {
  it("accepts a well-formed entry", () => {
    expect(isValidValidationEntry({
      username: "alice",
      creationTimestamp: 1, updatedTimestamp: 2, isDeleted: false,
    })).toBe(true)
  })
  it("rejects junk", () => {
    expect(isValidValidationEntry(null)).toBe(false)
    expect(isValidValidationEntry({ username: "x" })).toBe(false)
  })
})

describe("mergeValidatedByLists", () => {
  it("dedupes by username, keeps latest updatedTimestamp, preserves earliest creation", () => {
    const a = [{ username: "alice", creationTimestamp: 100, updatedTimestamp: 200, isDeleted: false }]
    const b = [{ username: "alice", creationTimestamp: 150, updatedTimestamp: 300, isDeleted: false }]
    const merged = mergeValidatedByLists(a, b)
    expect(merged).toHaveLength(1)
    expect(merged[0].creationTimestamp).toBe(100)
    expect(merged[0].updatedTimestamp).toBe(300)
  })

  it("unions distinct usernames, sorts alphabetically", () => {
    const a = [{ username: "bob", creationTimestamp: 1, updatedTimestamp: 1, isDeleted: false }]
    const b = [{ username: "alice", creationTimestamp: 1, updatedTimestamp: 1, isDeleted: false }]
    const merged = mergeValidatedByLists(a, b)
    expect(merged.map(e => e.username)).toEqual(["alice", "bob"])
  })

  it("upgrades string usernames to entries", () => {
    const merged = mergeValidatedByLists(["alice"] as unknown as ValidationEntry[], [])
    expect(merged[0].username).toBe("alice")
    expect(typeof merged[0].creationTimestamp).toBe("number")
  })

  it("handles undefined inputs", () => {
    expect(mergeValidatedByLists(undefined, undefined)).toEqual([])
  })
})
