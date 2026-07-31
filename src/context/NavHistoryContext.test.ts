import { describe, it, expect } from "vitest"
import { syncToLocation, initialState, type HistoryState, type NavLoc } from "./NavHistoryContext"

// These tests pin the cursor model that makes back/forward behave like the
// browser's own history while still exposing human-readable labels. The risk
// they guard is subtle: a wrong PUSH/POP/REPLACE classification silently
// corrupts the stack (e.g. a redirect truncating the forward history), which is
// exactly the bug class that surfaced during manual QA.

function loc(key: string, pathname: string, search = ""): NavLoc {
  return { key, pathname, search }
}

function titlesAt(state: HistoryState): { titles: string[]; index: number } {
  return { titles: state.entries.map((e) => e.pathname), index: state.index }
}

describe("initialState", () => {
  it("starts a fresh stack at the current location", () => {
    const s = initialState(loc("a", "/projects"))
    expect(s.entries).toHaveLength(1)
    expect(s.entries[0].pathname).toBe("/projects")
    expect(s.index).toBe(0)
  })
})

describe("syncToLocation", () => {
  it("PUSH appends a new entry and advances the cursor", () => {
    let s = initialState(loc("a", "/projects"))
    s = syncToLocation(s, loc("b", "/project/x/editor"), "PUSH")
    expect(titlesAt(s)).toEqual({ titles: ["/projects", "/project/x/editor"], index: 1 })
  })

  it("POP back to a known key moves the cursor without mutating the stack", () => {
    let s = initialState(loc("a", "/projects"))
    s = syncToLocation(s, loc("b", "/project/x/editor"), "PUSH")
    // Browser/our-button back: React Router restores key "a".
    s = syncToLocation(s, loc("a", "/projects"), "POP")
    expect(titlesAt(s)).toEqual({ titles: ["/projects", "/project/x/editor"], index: 0 })
  })

  it("PUSH after going back truncates the forward history (browser semantics)", () => {
    let s = initialState(loc("a", "/projects"))
    s = syncToLocation(s, loc("b", "/project/x/editor"), "PUSH")
    s = syncToLocation(s, loc("c", "/project/x/comments"), "PUSH")
    s = syncToLocation(s, loc("b", "/project/x/editor"), "POP") // back to index 1
    // New navigation from the middle drops the forward entry "c".
    s = syncToLocation(s, loc("d", "/project/x/settings"), "PUSH")
    expect(titlesAt(s)).toEqual({
      titles: ["/projects", "/project/x/editor", "/project/x/settings"],
      index: 2,
    })
  })

  it("REPLACE swaps the current entry in place and preserves the surrounding stack", () => {
    let s = initialState(loc("a", "/projects"))
    s = syncToLocation(s, loc("b", "/project/x/editor"), "PUSH")
    s = syncToLocation(s, loc("c", "/project/x/comments"), "PUSH")
    s = syncToLocation(s, loc("b", "/project/x/editor"), "POP") // back to index 1
    // A redirect (e.g. editor-root bouncing to a remembered file) must NOT
    // truncate the forward entry "c" — this was the QA-found bug.
    s = syncToLocation(s, loc("redir", "/project/x/editor/file/7"), "REPLACE")
    expect(titlesAt(s)).toEqual({
      titles: ["/projects", "/project/x/editor/file/7", "/project/x/comments"],
      index: 1,
    })
  })

  it("treats revisiting the same location with a new key as a distinct PUSH", () => {
    let s = initialState(loc("a", "/projects"))
    s = syncToLocation(s, loc("b", "/project/x/editor"), "PUSH")
    s = syncToLocation(s, loc("c", "/projects"), "PUSH") // same path, new key
    expect(s.entries).toHaveLength(3)
    expect(s.index).toBe(2)
  })
})
