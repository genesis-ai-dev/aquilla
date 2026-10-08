import { describe, it, expect } from "vitest"
import { STANDARD_EDITOR, chooseEditor, readEditorChoice, resolveEditor, writeEditorChoice } from "../editor-choice"

describe("extension editor choice", () => {
  it("defaults to the standard editor", () => {
    expect(resolveEditor({ project: null, files: {} }, "f1", ["ext-1"])).toBe(STANDARD_EDITOR)
  })

  it("remembers per file, with a project-wide default that per-file picks override", () => {
    let s = chooseEditor({ project: null, files: {} }, "f1", "ext-1", false)
    expect(resolveEditor(s, "f1", ["ext-1"])).toBe("ext-1")
    expect(resolveEditor(s, "f2", ["ext-1"])).toBe(STANDARD_EDITOR)
    s = chooseEditor(s, "f2", "ext-1", true)
    expect(resolveEditor(s, "f3", ["ext-1"])).toBe("ext-1")
    s = chooseEditor(s, "f3", STANDARD_EDITOR, false)
    expect(resolveEditor(s, "f3", ["ext-1"])).toBe(STANDARD_EDITOR)
    expect(resolveEditor(s, "f4", ["ext-1"])).toBe("ext-1")
  })

  it("falls back to standard when the remembered extension is gone", () => {
    expect(resolveEditor({ project: "gone", files: {} }, "f1", [])).toBe(STANDARD_EDITOR)
  })

  it("persists per user and project", () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as unknown as Storage
    writeEditorChoice("alice", "p1", { project: null, files: { f1: "ext-1" } }, storage)
    expect(readEditorChoice("alice", "p1", storage).files).toEqual({ f1: "ext-1" })
    expect(readEditorChoice("bob", "p1", storage).files).toEqual({})
  })
})
