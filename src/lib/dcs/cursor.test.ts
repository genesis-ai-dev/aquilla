import { describe, it, expect } from "vitest"
import { readCursor, buildCursor, DCS_UPSTREAM_KEY } from "./cursor"
import type { DcsCatalogEntry } from "./types"

const ENTRY: DcsCatalogEntry = {
  name: "en_ult",
  owner: "unfoldingWord",
  fullName: "unfoldingWord/en_ult",
  subject: "Aligned Bible",
  contentFormat: "usfm",
  ref: "v89",
  refType: "tag",
  commitSha: "84c73ba0",
  released: "2026-06-23T22:01:02Z",
  zipballUrl: "z",
  metadataUrl: "m",
  language: "en",
}

describe("readCursor", () => {
  it("returns null when the settings blob is absent", () => {
    expect(readCursor(undefined)).toBeNull()
    expect(readCursor({})).toBeNull()
    expect(readCursor(null)).toBeNull()
  })

  it("reads the dcsUpstream cursor from a settings object", () => {
    const cursor = {
      owner: "unfoldingWord",
      repo: "en_ult",
      subject: "Aligned Bible",
      contentFormat: "usfm",
      trackMode: "release",
      ref: "v88",
      commitSha: "aaa111",
      released: "2026-05-01T00:00:00Z",
      importedAt: "2026-07-01T00:00:00Z",
    }
    expect(readCursor({ [DCS_UPSTREAM_KEY]: cursor })).toEqual(cursor)
  })

  it("returns null for a malformed cursor (missing owner/repo)", () => {
    expect(readCursor({ [DCS_UPSTREAM_KEY]: { ref: "v1" } })).toBeNull()
  })
})

describe("buildCursor", () => {
  it("derives a DcsCursor from a catalog entry + trackMode", () => {
    const cursor = buildCursor(ENTRY, "release")
    expect(cursor).toMatchObject({
      owner: "unfoldingWord",
      repo: "en_ult",
      subject: "Aligned Bible",
      contentFormat: "usfm",
      trackMode: "release",
      ref: "v89",
      commitSha: "84c73ba0",
      released: "2026-06-23T22:01:02Z",
    })
    // importedAt is stamped with a real ISO timestamp.
    expect(new Date(cursor.importedAt).toString()).not.toBe("Invalid Date")
  })

  it("round-trips through readCursor", () => {
    const cursor = buildCursor(ENTRY, "head")
    expect(readCursor({ [DCS_UPSTREAM_KEY]: cursor })).toEqual(cursor)
    expect(cursor.trackMode).toBe("head")
  })
})
