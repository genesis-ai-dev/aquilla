import { describe, it, expect, beforeEach } from "vitest"
import {
  readProjectOpenedAt,
  markProjectOpened,
  isProjectNew,
} from "./opened-shared-store"

// jsdom provides localStorage; we reset it between tests.
beforeEach(() => {
  localStorage.clear()
})

describe("opened-shared-store", () => {
  it("returns null when no entry exists", () => {
    expect(readProjectOpenedAt("alice", "proj-1")).toBeNull()
  })

  it("records and reads back an opened timestamp", () => {
    markProjectOpened("alice", "proj-1", 1000)
    expect(readProjectOpenedAt("alice", "proj-1")).toBe(1000)
  })

  it("updates an existing entry to the latest open time", () => {
    markProjectOpened("alice", "proj-1", 1000)
    markProjectOpened("alice", "proj-2", 2000)
    markProjectOpened("alice", "proj-1", 3000)
    expect(readProjectOpenedAt("alice", "proj-1")).toBe(3000)
    expect(readProjectOpenedAt("alice", "proj-2")).toBe(2000)
  })

  it("isolates different users (two invitees are independent)", () => {
    markProjectOpened("bob", "proj-1", 1000)
    // Alice has NOT opened proj-1 even though Bob has.
    expect(readProjectOpenedAt("alice", "proj-1")).toBeNull()
    expect(readProjectOpenedAt("bob", "proj-1")).toBe(1000)
  })

  it("ignores empty userId / projectId", () => {
    markProjectOpened("", "proj-1", 1000)
    markProjectOpened("alice", "", 1000)
    expect(readProjectOpenedAt("", "proj-1")).toBeNull()
    expect(readProjectOpenedAt("alice", "")).toBeNull()
  })

  it("caps the list at MAX_ENTRIES (500)", () => {
    for (let i = 0; i < 505; i++) {
      markProjectOpened("alice", `proj-${i}`, i)
    }
    // The 5 oldest should have been evicted.
    for (let i = 0; i < 5; i++) {
      expect(readProjectOpenedAt("alice", `proj-${i}`)).toBeNull()
    }
    // The most recent 500 remain.
    for (let i = 5; i < 505; i++) {
      expect(readProjectOpenedAt("alice", `proj-${i}`)).toBe(i)
    }
  })
})

describe("isProjectNew", () => {
  const GRANT = "2026-07-24T12:00:00.000Z"
  const grantMs = Date.parse(GRANT)

  it("is new when granted and never opened", () => {
    expect(isProjectNew(GRANT, null)).toBe(true)
  })

  it("is NOT new once opened after the grant", () => {
    expect(isProjectNew(GRANT, grantMs + 1000)).toBe(false)
  })

  it("is new again when last opened before the (re-)grant", () => {
    expect(isProjectNew(GRANT, grantMs - 1000)).toBe(true)
  })

  it("degrades to not-new when the grant timestamp is missing", () => {
    // Older worker / field absent — must never light up every project.
    expect(isProjectNew(null, null)).toBe(false)
    expect(isProjectNew(undefined, null)).toBe(false)
    expect(isProjectNew("", null)).toBe(false)
  })

  it("degrades to not-new when the grant timestamp is unparseable", () => {
    expect(isProjectNew("not-a-date", null)).toBe(false)
  })
})
