import { describe, expect, it } from "vitest"
import { isExcludedFromWork } from "./excluded-cell"

describe("isExcludedFromWork (AQU-1083 + AQU-1424)", () => {
  it("excludes a heading only when the project does not count them", () => {
    expect(isExcludedFromWork({ type: "heading" }, false)).toBe(true)
    expect(isExcludedFromWork({ type: "heading" }, true)).toBe(false)
  })

  it("excludes a parked cell whatever the structural policy says", () => {
    // The regression the module's header warns about: a project that counts
    // headings must not thereby start counting hidden cells.
    expect(isExcludedFromWork({ type: "verse", hidden: true }, true)).toBe(true)
    expect(isExcludedFromWork({ type: "heading", hidden: true }, true)).toBe(true)
    expect(isExcludedFromWork({ type: "verse", hidden: true }, false)).toBe(true)
  })

  it("counts an ordinary visible verse under either policy", () => {
    expect(isExcludedFromWork({ type: "verse" }, true)).toBe(false)
    expect(isExcludedFromWork({ type: "verse" }, false)).toBe(false)
  })

  it("treats an untyped cell as content, matching the SQL predicate's COALESCE", () => {
    expect(isExcludedFromWork({}, false)).toBe(false)
  })

  it("keeps drawing a vanished cell the way it was drawn before", () => {
    expect(isExcludedFromWork(undefined, false)).toBe(false)
    expect(isExcludedFromWork(null, true)).toBe(false)
  })
})
