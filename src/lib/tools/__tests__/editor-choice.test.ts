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

  it("defaults to the first-party editor extension when installed; an explicit standard pick wins", () => {
    const fp = "fp-editor"
    expect(resolveEditor({ project: null, files: {} }, "f1", [fp], fp)).toBe(fp)
    // Not installed (removed / flag off upstream) → standard.
    expect(resolveEditor({ project: null, files: {} }, "f1", [], fp)).toBe(STANDARD_EDITOR)
    let s = chooseEditor({ project: null, files: {} }, "f1", STANDARD_EDITOR, false)
    expect(resolveEditor(s, "f1", [fp], fp)).toBe(STANDARD_EDITOR)
    expect(resolveEditor(s, "f2", [fp], fp)).toBe(fp)
    s = chooseEditor(s, "f2", STANDARD_EDITOR, true)
    expect(s.project).toBe(STANDARD_EDITOR)
    expect(resolveEditor(s, "f9", [fp], fp)).toBe(STANDARD_EDITOR)
    // A remembered extension that is gone falls back to the default editor.
    expect(resolveEditor({ project: "gone", files: {} }, "f1", [fp], fp)).toBe(fp)
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
