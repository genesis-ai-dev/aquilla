import { describe, it, expect } from "vitest"
import { sanitizeParseDetail, sanitizeThrownDetail } from "./parse-error-detail"

describe("sanitizeParseDetail", () => {
  it("strips the document slice V8 quotes mid-document", () => {
    // Exactly what `JSON.parse('{"verse": The LORD is my shepherd}')` throws.
    const detail = `Unexpected token 'T', ..."{"verse": The LORD i"... is not valid JSON`
    const out = sanitizeParseDetail(detail)
    expect(out).not.toContain("LORD")
    expect(out).toBe("Unexpected token 'T', … is not valid JSON")
  })

  it("strips the document slice V8 quotes at the start of the input", () => {
    const detail = `Unexpected token 'I', "In the beg"... is not valid JSON`
    const out = sanitizeParseDetail(detail)
    expect(out).not.toContain("In the beg")
    expect(out).toBe("Unexpected token 'I', … is not valid JSON")
  })

  it("keeps position-only messages, which carry no content", () => {
    const detail = "Expected ',' or '}' after property value in JSON at position 56 (line 1 column 57)"
    expect(sanitizeParseDetail(detail)).toBe(detail)
  })

  it("collapses the whitespace a <parsererror> body arrives with", () => {
    const detail = "This page contains the following errors:\nerror on line 3 at column 12:\n  mismatched tag"
    expect(sanitizeParseDetail(detail)).toBe(
      "This page contains the following errors: error on line 3 at column 12: mismatched tag",
    )
  })

  it("strips a quoted markup slice from an XML parser message", () => {
    const detail = `parse error near ..."<seg>In the beginning</seg>"... unexpected`
    const out = sanitizeParseDetail(detail)
    expect(out).not.toContain("In the beginning")
    expect(out).toBe("parse error near … unexpected")
  })
})

describe("sanitizeThrownDetail", () => {
  it("accepts an Error", () => {
    expect(sanitizeThrownDetail(new Error(`Unexpected token 'I', "In the beg"... is not valid JSON`)))
      .toBe("Unexpected token 'I', … is not valid JSON")
  })

  it("accepts a non-Error throw", () => {
    expect(sanitizeThrownDetail("plain failure")).toBe("plain failure")
  })
})
