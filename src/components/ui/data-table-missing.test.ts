import { describe, it, expect } from "vitest"
import { missingLast, SORT_MISSING_LAST } from "./data-table-missing"

describe("data-table-missing", () => {
  it("exposes the TanStack direction-immune sentinel", () => {
    expect(SORT_MISSING_LAST).toBe("last")
  })

  it("coerces null, undefined, and blank strings to undefined", () => {
    expect(missingLast(null)).toBeUndefined()
    expect(missingLast(undefined)).toBeUndefined()
    expect(missingLast("")).toBeUndefined()
    expect(missingLast("   ")).toBeUndefined()
  })

  it("passes through real string and number values", () => {
    expect(missingLast("alice")).toBe("alice")
    expect(missingLast(0)).toBe(0)
    expect(missingLast(1_700_000_000_000)).toBe(1_700_000_000_000)
  })
})
