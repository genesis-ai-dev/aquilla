import { beforeEach, describe, expect, it } from "vitest"
import {
  dismissMentions,
  getMentionDismissedIds,
  getMentionReadIds,
  markMentionsRead,
  resetMentionReadStateForTests,
} from "./mention-read-state"

describe("mention read state", () => {
  beforeEach(() => {
    localStorage.clear()
    resetMentionReadStateForTests()
  })

  it("remembers opened mentions per project and reader", () => {
    markMentionsRead("proj-1", "alice", ["c1"])
    expect(getMentionReadIds("proj-1", "alice").has("c1")).toBe(true)
    expect(getMentionReadIds("proj-1", "bob").has("c1")).toBe(false)
    expect(getMentionReadIds("proj-2", "alice").has("c1")).toBe(false)
  })

  it("treats a corrupt store as nothing read", () => {
    localStorage.setItem("aq.mention-read.v1:proj-1:alice", "{not-json")
    resetMentionReadStateForTests()
    expect(getMentionReadIds("proj-1", "alice").size).toBe(0)
  })

  it("keeps only the newest ids once the cap is passed", () => {
    const ids = Array.from({ length: 405 }, (_, i) => `c${i}`)
    markMentionsRead("proj-1", "alice", ids)
    const stored = getMentionReadIds("proj-1", "alice")
    expect(stored.size).toBe(400)
    expect(stored.has("c0")).toBe(false)
    expect(stored.has("c404")).toBe(true)
  })

  it("hides dismissed mentions without marking them read", () => {
    dismissMentions("proj-1", "alice", ["c1"])
    expect(getMentionDismissedIds("proj-1", "alice").has("c1")).toBe(true)
    expect(getMentionReadIds("proj-1", "alice").has("c1")).toBe(false)
    expect(getMentionDismissedIds("proj-1", "bob").has("c1")).toBe(false)
  })
})
