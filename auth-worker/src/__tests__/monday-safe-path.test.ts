import { describe, it, expect } from "vitest"
import { isSafeAppPath } from "../routes/monday"

describe("isSafeAppPath (open-redirect guard)", () => {
  it("accepts app-relative paths", () => {
    expect(isSafeAppPath("/settings/monday")).toBe(true)
    expect(isSafeAppPath("/org/1?tab=x")).toBe(true)
  })
  it.each(["//evil.com", "/\\evil.com", "/\t/evil.com", "/\n/evil.com", "https://evil.com", "evil.com"])(
    "rejects %j",
    (p) => expect(isSafeAppPath(p)).toBe(false),
  )
})
