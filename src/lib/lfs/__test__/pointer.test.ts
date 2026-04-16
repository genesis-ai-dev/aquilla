import { describe, it, expect } from "vitest"
import { parsePointerContent, isLfsPointerContent } from "../pointer"

const VALID = `version https://git-lfs.github.com/spec/v1
oid sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
size 45812
`

describe("parsePointerContent", () => {
  it("parses a valid pointer", () => {
    expect(parsePointerContent(VALID)).toEqual({
      oid: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      size: 45812,
      version: "https://git-lfs.github.com/spec/v1",
    })
  })

  it("returns null for missing version", () => {
    expect(parsePointerContent("oid sha256:abc\nsize 1\n")).toBeNull()
  })

  it("returns null for missing oid", () => {
    expect(parsePointerContent("version https://git-lfs.github.com/spec/v1\nsize 1\n")).toBeNull()
  })

  it("returns null for missing size", () => {
    expect(parsePointerContent(
      "version https://git-lfs.github.com/spec/v1\noid sha256:abc\n"
    )).toBeNull()
  })

  it("returns null for short-hash oid (not 64 chars)", () => {
    expect(parsePointerContent(
      "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n"
    )).toBeNull()
  })
})

describe("isLfsPointerContent", () => {
  it("recognizes a pointer as bytes", () => {
    const bytes = new TextEncoder().encode(VALID)
    expect(isLfsPointerContent(bytes)).toBe(true)
  })

  it("rejects bytes over 400 length as non-pointer (cheap guard)", () => {
    const big = new Uint8Array(500)
    expect(isLfsPointerContent(big)).toBe(false)
  })

  it("rejects small bytes lacking the LFS signature", () => {
    const bytes = new TextEncoder().encode("hello world")
    expect(isLfsPointerContent(bytes)).toBe(false)
  })
})
