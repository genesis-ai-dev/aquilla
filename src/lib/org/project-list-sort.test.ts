import { describe, it, expect, beforeEach } from "vitest"
import { DEFAULT_PROJECT_SORT, readProjectSort, writeProjectSort } from "./project-list-sort"

beforeEach(() => localStorage.clear())

describe("the project list's one saved sort (AQU-2259)", () => {
  it("opens on Recently updated when nothing was chosen", () => {
    expect(readProjectSort()).toEqual(DEFAULT_PROJECT_SORT)
  })

  it("reads back what was written", () => {
    writeProjectSort({ column: "pm", desc: false })
    expect(readProjectSort()).toEqual({ column: "pm", desc: false })
  })

  it("ignores a column outside the set, and a malformed value", () => {
    writeProjectSort({ column: "actions", desc: true })
    expect(readProjectSort()).toEqual(DEFAULT_PROJECT_SORT)
    localStorage.setItem("aq.project-list-sort.v1", "{nope")
    expect(readProjectSort()).toEqual(DEFAULT_PROJECT_SORT)
  })

  it("maps both old sets of named views onto columns", () => {
    for (const [lens, sort] of [
      ["recent", { column: "edited", desc: true }],
      ["overdue", { column: "status", desc: true }],
      ["most-progress", { column: "translated", desc: true }],
      ["pm", { column: "pm", desc: false }],
    ] as const) {
      localStorage.clear()
      localStorage.setItem("org:all-projects:view", lens)
      expect(readProjectSort()).toEqual(sort)
    }
  })

  it("prefers a sort chosen now over an old named view", () => {
    localStorage.setItem("org:all-projects:view", "pm")
    writeProjectSort({ column: "name", desc: false })
    expect(readProjectSort()).toEqual({ column: "name", desc: false })
  })
})
