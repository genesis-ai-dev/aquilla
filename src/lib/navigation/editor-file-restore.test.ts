import { describe, expect, it } from "vitest"
import { resolveEditorFileId } from "./editor-file-restore"

describe("resolveEditorFileId (AQU-1537)", () => {
  it("opens the single file of a one-file project with no history at all", () => {
    expect(resolveEditorFileId({ knownFileIds: ["only"] })).toBe("only")
  })

  it("opens the single file even when the remembered file was deleted", () => {
    expect(resolveEditorFileId({
      savedFileId: "gone",
      legacyFileId: "gone-too",
      firstOpenTabFileId: "gone-as-well",
      knownFileIds: ["only"],
    })).toBe("only")
  })

  it("returns the file this user last had open, over any other evidence", () => {
    expect(resolveEditorFileId({
      savedFileId: "f2",
      legacyFileId: "f1",
      firstOpenTabFileId: "f3",
      knownFileIds: ["f1", "f2", "f3"],
    })).toBe("f2")
  })

  it("falls back to the legacy last-active file when there is no per-user record", () => {
    expect(resolveEditorFileId({
      savedFileId: null,
      legacyFileId: "f1",
      firstOpenTabFileId: "f3",
      knownFileIds: ["f1", "f2", "f3"],
    })).toBe("f1")
  })

  it("falls back to the first open tab when nothing is remembered", () => {
    expect(resolveEditorFileId({
      firstOpenTabFileId: "f3",
      knownFileIds: ["f1", "f2", "f3"],
    })).toBe("f3")
  })

  it("skips remembered ids the project no longer has", () => {
    expect(resolveEditorFileId({
      savedFileId: "deleted",
      legacyFileId: "other-project",
      firstOpenTabFileId: "f2",
      knownFileIds: ["f1", "f2"],
    })).toBe("f2")
  })

  it("keeps the empty state for a multi-file project with no history", () => {
    expect(resolveEditorFileId({ knownFileIds: ["f1", "f2"] })).toBeNull()
  })

  it("keeps the empty state while the project has no files", () => {
    expect(resolveEditorFileId({ savedFileId: "f1", knownFileIds: [] })).toBeNull()
  })
})
