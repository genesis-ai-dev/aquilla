import { describe, expect, it } from "vitest"
import { resolveOverlayFileId } from "./overlay-file-restore"

const projectId = "p1"
const knownFileIds = ["f1", "f2"]

describe("resolveOverlayFileId (AQU-1496)", () => {
  it("prefers the file named by the URL's ?return= target", () => {
    expect(resolveOverlayFileId({
      projectId,
      returnPath: "/project/p1/editor/file/f1",
      savedFileId: "f2",
      legacyFileId: "f2",
      knownFileIds,
    })).toBe("f1")
  })

  it("falls back to the per-user last location", () => {
    expect(resolveOverlayFileId({
      projectId,
      returnPath: null,
      savedFileId: "f2",
      knownFileIds,
    })).toBe("f2")
  })

  it("falls back to the legacy last-active file", () => {
    expect(resolveOverlayFileId({
      projectId,
      returnPath: null,
      savedFileId: null,
      legacyFileId: "f1",
      knownFileIds,
    })).toBe("f1")
  })

  it("ignores a return target with no file (the bare editor path)", () => {
    expect(resolveOverlayFileId({
      projectId,
      returnPath: "/project/p1/editor",
      savedFileId: "f2",
      knownFileIds,
    })).toBe("f2")
  })

  it("ignores files the project no longer has, at every step", () => {
    expect(resolveOverlayFileId({
      projectId,
      returnPath: "/project/p1/editor/file/gone",
      savedFileId: "also-gone",
      legacyFileId: "f2",
      knownFileIds,
    })).toBe("f2")
  })

  it("ignores a return target pointing at another project's editor", () => {
    expect(resolveOverlayFileId({
      projectId,
      returnPath: "/project/p9/editor/file/f1",
      savedFileId: null,
      knownFileIds,
    })).toBeNull()
  })

  // The genuinely-empty case: nothing was ever opened, so the workbench must
  // keep showing "Choose a file" rather than guessing at the project's files.
  it("returns null with no evidence, even when the project has exactly one file", () => {
    expect(resolveOverlayFileId({
      projectId,
      returnPath: null,
      savedFileId: null,
      legacyFileId: null,
      knownFileIds: ["only-file"],
    })).toBeNull()
  })
})
