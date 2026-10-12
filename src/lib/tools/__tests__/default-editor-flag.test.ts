import { describe, it, expect } from "vitest"
import { defaultEditorExtensionEnabled, DEFAULT_EDITOR_FLAG_KEY } from "../default-editor-flag"
import { STANDARD_EDITOR, chooseEditor, resolveEditor } from "../editor-choice"

const storage = (value: string | null) => ({ getItem: (k: string) => (k === DEFAULT_EDITOR_FLAG_KEY ? value : null) })

describe("default editor: native unless opted in", () => {
  it("is the native editor with no flag and no build override", () => {
    expect(defaultEditorExtensionEnabled(storage(null), undefined)).toBe(false)
    expect(defaultEditorExtensionEnabled(null, undefined)).toBe(false)
    expect(defaultEditorExtensionEnabled(storage(null), "off")).toBe(false)
  })

  it("opts into the extension editor per browser, or per build", () => {
    expect(defaultEditorExtensionEnabled(storage("on"), undefined)).toBe(true)
    expect(defaultEditorExtensionEnabled(storage(null), "on")).toBe(true)
    // The per-browser choice wins over the build.
    expect(defaultEditorExtensionEnabled(storage("off"), "on")).toBe(false)
  })

  it("survives blocked storage", () => {
    const blocked = { getItem: () => { throw new Error("SecurityError") } }
    expect(defaultEditorExtensionEnabled(blocked, undefined)).toBe(false)
  })

  it("an existing project that never chose an editor gets the native one, even with the first-party editor installed", () => {
    // The workspace passes defaultEditorId = null while the flag is off.
    expect(resolveEditor({ project: null, files: {} }, "f1", ["first-party-editor"], null)).toBe(STANDARD_EDITOR)
  })

  it("the extension editor is one pick away, per file or for the whole project", () => {
    const perFile = chooseEditor({ project: null, files: {} }, "f1", "first-party-editor", false)
    expect(resolveEditor(perFile, "f1", ["first-party-editor"], null)).toBe("first-party-editor")
    expect(resolveEditor(perFile, "f2", ["first-party-editor"], null)).toBe(STANDARD_EDITOR)
    const project = chooseEditor({ project: null, files: {} }, "f1", "first-party-editor", true)
    expect(resolveEditor(project, "f2", ["first-party-editor"], null)).toBe("first-party-editor")
  })
})
