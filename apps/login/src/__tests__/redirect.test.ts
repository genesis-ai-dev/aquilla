import { describe, it, expect } from "vitest"
import { sanitizeReturnUrl } from "../redirect"

describe("sanitizeReturnUrl", () => {
  const origin = "https://aquilla.app"
  const fallback = "/projects"

  it("returns relative path as-is", () => {
    expect(sanitizeReturnUrl("/w/abc", fallback, origin)).toBe("/w/abc")
  })

  it("preserves query+hash on relative path", () => {
    expect(sanitizeReturnUrl("/w/abc?x=1#y", fallback, origin)).toBe(
      "/w/abc?x=1#y",
    )
  })

  it("rejects protocol-relative", () => {
    expect(sanitizeReturnUrl("//evil.com/pwn", fallback, origin)).toBe(fallback)
  })

  it("rejects cross-origin absolute URL", () => {
    expect(sanitizeReturnUrl("https://evil.com/pwn", fallback, origin)).toBe(
      fallback,
    )
  })

  it("strips origin on same-origin absolute URL", () => {
    expect(
      sanitizeReturnUrl("https://aquilla.app/projects/9?z=1", fallback, origin),
    ).toBe("/projects/9?z=1")
  })

  it("empty returns fallback", () => {
    expect(sanitizeReturnUrl("", fallback, origin)).toBe(fallback)
  })

  it("treats bare strings as a relative path on the current origin", () => {
    // `new URL("not a url", origin)` parses as a same-origin URL — the
    // browser percent-encodes the spaces and we strip the origin. Document
    // the actual behavior so a future "tighten this" doesn't regress.
    expect(sanitizeReturnUrl("not a url", fallback, origin)).toBe(
      "/not%20a%20url",
    )
  })
})
