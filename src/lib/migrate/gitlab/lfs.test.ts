// Pure-helper tests for the LFS layer: pointer parsing (the exact 3-line wire
// format committed by Codex), pointers<->files path mapping (must mirror the
// VS Code extension's getFilesPathForPointer so the importer finds real audio),
// sha256 integrity verification (the guard that downloaded bytes match the oid),
// and LFS-server URL derivation (no double ".git"). These encode WHY: a wrong
// pointer parse means missing/garbled media; a wrong path mapping means the
// importer silently imports nothing; a missing oid check means corruption.

import { describe, it, expect } from "vitest"
import {
  parseLfsPointer,
  isLfsPointer,
  pointersToFilesPath,
  isPointerPath,
  sha256Hex,
  verifyOid,
  lfsServerUrl,
  lfsAuthHeader,
} from "./lfs"
import { createHash } from "node:crypto"

// A real pointer captured from a cloned Codex project on disk.
const REAL_POINTER = [
  "version https://git-lfs.github.com/spec/v1",
  "oid sha256:a79eb15cd318315eed2cdf99f17ff7cad1f4b85fdac8f99d303e97acbab8ffcf",
  "size 77336",
  "",
].join("\n")

describe("parseLfsPointer", () => {
  it("parses the real 3-line pointer format into oid + size", () => {
    const parsed = parseLfsPointer(REAL_POINTER)
    expect(parsed).toEqual({
      oid: "a79eb15cd318315eed2cdf99f17ff7cad1f4b85fdac8f99d303e97acbab8ffcf",
      size: 77336,
    })
  })

  it("lowercases an uppercase oid so downstream sha256 comparison matches", () => {
    const upper = REAL_POINTER.replace(
      "a79eb15cd318315eed2cdf99f17ff7cad1f4b85fdac8f99d303e97acbab8ffcf",
      "A79EB15CD318315EED2CDF99F17FF7CAD1F4B85FDAC8F99D303E97ACBAB8FFCF",
    )
    expect(parseLfsPointer(upper)?.oid).toBe(
      "a79eb15cd318315eed2cdf99f17ff7cad1f4b85fdac8f99d303e97acbab8ffcf",
    )
  })

  it("tolerates size-before-oid field ordering", () => {
    const reordered = [
      "version https://git-lfs.github.com/spec/v1",
      "size 42",
      "oid sha256:" + "b".repeat(64),
      "",
    ].join("\n")
    expect(parseLfsPointer(reordered)).toEqual({ oid: "b".repeat(64), size: 42 })
  })

  it("returns null for non-pointer content (a real binary header)", () => {
    // Not a pointer -> must NOT be treated as one, else we'd skip real bytes.
    expect(parseLfsPointer("RIFF....WEBPVP8 binary junk")).toBeNull()
    expect(parseLfsPointer("")).toBeNull()
    expect(parseLfsPointer("just some text")).toBeNull()
  })

  it("returns null when the signature is present but oid is malformed", () => {
    const badOid = [
      "version https://git-lfs.github.com/spec/v1",
      "oid sha256:not-hex",
      "size 10",
    ].join("\n")
    expect(parseLfsPointer(badOid)).toBeNull()
  })

  it("returns null when the signature is present but size is missing", () => {
    const noSize = [
      "version https://git-lfs.github.com/spec/v1",
      "oid sha256:" + "c".repeat(64),
    ].join("\n")
    expect(parseLfsPointer(noSize)).toBeNull()
  })

  it("isLfsPointer agrees with parseLfsPointer", () => {
    expect(isLfsPointer(REAL_POINTER)).toBe(true)
    expect(isLfsPointer("nope")).toBe(false)
  })
})

describe("pointersToFilesPath", () => {
  it("maps a nested pointers path to the parallel files path", () => {
    expect(
      pointersToFilesPath(
        ".project/attachments/pointers/Our-story-abc/audio-xyz.webm",
      ),
    ).toBe(".project/attachments/files/Our-story-abc/audio-xyz.webm")
  })

  it("handles a leading slash variant", () => {
    expect(
      pointersToFilesPath("/.project/attachments/pointers/a/b.webm"),
    ).toBe("/.project/attachments/files/a/b.webm")
  })

  it("normalizes backslashes (Windows-style paths) before mapping", () => {
    expect(
      pointersToFilesPath(".project\\attachments\\pointers\\a\\b.webm"),
    ).toBe(".project/attachments/files/a/b.webm")
  })

  it("only swaps the pointers segment, leaving the filename intact", () => {
    // A filename that itself contains 'pointers' must not be double-rewritten.
    expect(
      pointersToFilesPath(".project/attachments/pointers/x/pointers-note.webm"),
    ).toBe(".project/attachments/files/x/pointers-note.webm")
  })
})

describe("isPointerPath", () => {
  it("recognizes pointer paths and rejects files/other paths", () => {
    expect(isPointerPath(".project/attachments/pointers/a.webm")).toBe(true)
    expect(isPointerPath(".project/attachments/files/a.webm")).toBe(false)
    expect(isPointerPath("metadata.json")).toBe(false)
  })
})

describe("sha256Hex / verifyOid", () => {
  const bytes = new TextEncoder().encode("hello codex")
  const oid = createHash("sha256").update(bytes).digest("hex")

  it("computes sha256 as lowercase hex", () => {
    expect(sha256Hex(bytes)).toBe(oid)
    expect(sha256Hex(bytes)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("verifyOid passes for matching bytes (the integrity guard)", () => {
    expect(verifyOid(bytes, oid)).toBe(true)
    expect(verifyOid(bytes, oid.toUpperCase())).toBe(true)
  })

  it("verifyOid fails for corrupted bytes — corruption must be detectable", () => {
    const corrupted = new TextEncoder().encode("hello codex!")
    expect(verifyOid(corrupted, oid)).toBe(false)
  })
})

describe("lfsServerUrl", () => {
  it("appends .git/info/lfs when the URL has no .git suffix", () => {
    expect(lfsServerUrl("https://gitlab.example.com/grp/proj")).toBe(
      "https://gitlab.example.com/grp/proj.git/info/lfs",
    )
  })

  it("does not double the .git suffix when the URL already ends in .git", () => {
    expect(lfsServerUrl("https://gitlab.example.com/grp/proj.git")).toBe(
      "https://gitlab.example.com/grp/proj.git/info/lfs",
    )
  })
})

describe("lfsAuthHeader", () => {
  it("builds Basic base64(oauth2:<token>)", () => {
    const header = lfsAuthHeader("secret-token")
    expect(header).toBe(
      "Basic " + Buffer.from("oauth2:secret-token").toString("base64"),
    )
    // Round-trips back to the oauth2 form.
    const decoded = Buffer.from(header.replace("Basic ", ""), "base64").toString()
    expect(decoded).toBe("oauth2:secret-token")
  })
})
