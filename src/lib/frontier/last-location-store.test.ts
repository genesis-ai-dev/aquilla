import { describe, it, expect, beforeEach } from "vitest"
import { readLastLocation, writeLastLocation } from "./last-location-store"

// jsdom provides localStorage; we reset it between tests.
beforeEach(() => {
  localStorage.clear()
})

describe("last-location-store", () => {
  it("returns null when no entry exists", () => {
    expect(readLastLocation("alice", "proj-1")).toBeNull()
  })

  it("writes and reads back a location", () => {
    writeLastLocation("alice", "proj-1", { fileId: "file-a", cellId: "cell-1" })
    expect(readLastLocation("alice", "proj-1")).toEqual({
      fileId: "file-a",
      cellId: "cell-1",
    })
  })

  it("updates an existing entry (moves to front)", () => {
    writeLastLocation("alice", "proj-1", { fileId: "file-a" })
    writeLastLocation("alice", "proj-2", { fileId: "file-b" })
    writeLastLocation("alice", "proj-1", { fileId: "file-c" })
    // proj-1 should have the latest value
    expect(readLastLocation("alice", "proj-1")).toEqual({ fileId: "file-c" })
    // proj-2 should still be present
    expect(readLastLocation("alice", "proj-2")).toEqual({ fileId: "file-b" })
  })

  it("isolates different users", () => {
    writeLastLocation("alice", "proj-1", { fileId: "file-a" })
    writeLastLocation("bob", "proj-1", { fileId: "file-b" })
    expect(readLastLocation("alice", "proj-1")).toEqual({ fileId: "file-a" })
    expect(readLastLocation("bob", "proj-1")).toEqual({ fileId: "file-b" })
  })

  it("caps the list at MAX_ENTRIES (50)", () => {
    // Write 55 distinct projects
    for (let i = 0; i < 55; i++) {
      writeLastLocation("alice", `proj-${i}`, { fileId: `file-${i}` })
    }
    // The first 5 (oldest) should have been evicted
    for (let i = 0; i < 5; i++) {
      expect(readLastLocation("alice", `proj-${i}`)).toBeNull()
    }
    // The last 50 should still be present
    for (let i = 5; i < 55; i++) {
      expect(readLastLocation("alice", `proj-${i}`)).toEqual({ fileId: `file-${i}` })
    }
  })

  it("stores canonicalRef when provided", () => {
    writeLastLocation("alice", "proj-1", {
      fileId: "file-a",
      cellId: "cell-1",
      canonicalRef: "GEN 1:1",
    })
    expect(readLastLocation("alice", "proj-1")).toEqual({
      fileId: "file-a",
      cellId: "cell-1",
      canonicalRef: "GEN 1:1",
    })
  })
})
