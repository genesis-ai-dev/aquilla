import { describe, it, expect } from "vitest"
import { pickRestoreFileId, type RestoreFileInput } from "./restore-file"

const BASE: RestoreFileInput = {
  fileIds: ["a", "b", "c"],
  savedFileId: null,
  lastActiveFileId: null,
  firstOpenTabFileId: null,
  firstProjectFileId: "a",
}

describe("pickRestoreFileId", () => {
  it("prefers the remembered per-user location", () => {
    expect(
      pickRestoreFileId({ ...BASE, savedFileId: "b", lastActiveFileId: "c", firstOpenTabFileId: "a" }),
    ).toBe("b")
  })

  it("falls back to the legacy last-active file when no saved location", () => {
    expect(pickRestoreFileId({ ...BASE, lastActiveFileId: "c", firstOpenTabFileId: "b" })).toBe("c")
  })

  it("falls back to the first open tab when nothing is remembered", () => {
    expect(pickRestoreFileId({ ...BASE, firstOpenTabFileId: "b" })).toBe("b")
  })

  // AQU-339: cold load of a multi-file project (no saved location, no open
  // tab) must still auto-select a file rather than leaving the editor blank.
  it("falls back to the first project file on a cold load of a multi-file project", () => {
    expect(pickRestoreFileId(BASE)).toBe("a")
  })

  it("ignores remembered candidates that no longer exist in the project", () => {
    expect(
      pickRestoreFileId({ ...BASE, savedFileId: "gone", lastActiveFileId: "also-gone" }),
    ).toBe("a")
  })

  it("returns null when the project has no files (preserves the import empty state)", () => {
    expect(
      pickRestoreFileId({ fileIds: [], savedFileId: null, lastActiveFileId: null, firstOpenTabFileId: null, firstProjectFileId: null }),
    ).toBeNull()
  })
})
