import { describe, it, expect, beforeEach } from "vitest"
import { readLastCell, readLastLocation, writeLastCell, writeLastLocation } from "./last-location-store"

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

describe("per-file last cell", () => {
  // The point of the per-file trace: going back to a file resumes where you
  // were IN THAT FILE, not wherever you last were in the project.
  it("remembers a cell for each file independently", () => {
    writeLastCell("alice", "proj-1", "file-a", "a-7")
    writeLastCell("alice", "proj-1", "file-b", "b-3")
    expect(readLastCell("alice", "proj-1", "file-a")).toBe("a-7")
    expect(readLastCell("alice", "proj-1", "file-b")).toBe("b-3")
  })

  it("keeps only the latest cell for a file", () => {
    writeLastCell("alice", "proj-1", "file-a", "a-1")
    writeLastCell("alice", "proj-1", "file-a", "a-9")
    expect(readLastCell("alice", "proj-1", "file-a")).toBe("a-9")
  })

  it("does not leak across users or projects", () => {
    writeLastCell("alice", "proj-1", "file-a", "a-1")
    expect(readLastCell("bob", "proj-1", "file-a")).toBeNull()
    expect(readLastCell("alice", "proj-2", "file-a")).toBeNull()
  })

  it("evicts the least-recently-used file past the cap", () => {
    writeLastCell("alice", "proj-1", "oldest", "c")
    for (let i = 0; i < 300; i++) writeLastCell("alice", "proj-1", `f-${i}`, "c")
    expect(readLastCell("alice", "proj-1", "oldest")).toBeNull()
    expect(readLastCell("alice", "proj-1", "f-299")).toBe("c")
  })
})
