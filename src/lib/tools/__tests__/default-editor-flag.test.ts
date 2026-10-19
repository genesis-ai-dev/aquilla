import { describe, it, expect } from "vitest"
import { defaultEditorExtensionEnabled, DEFAULT_EDITOR_FLAG_KEY } from "../default-editor-flag"
import { STANDARD_EDITOR, chooseEditor, chooseOriginalEditor, resolveEditor } from "../editor-choice"

const storage = (value: string | null) => ({ getItem: (k: string) => (k === DEFAULT_EDITOR_FLAG_KEY ? value : null) })
const EXT = "first-party-editor"

describe("default editor: the Smart Extension, with the original one click away", () => {
  it("is the extension editor with no override (Daniel, 2026-10-12)", () => {
    expect(defaultEditorExtensionEnabled(storage(null), undefined)).toBe(true)
    expect(defaultEditorExtensionEnabled(null, undefined)).toBe(true)
  })

  it("turns off per browser or per build (the e2e build pins it off for the native journeys)", () => {
    expect(defaultEditorExtensionEnabled(storage("off"), undefined)).toBe(false)
    expect(defaultEditorExtensionEnabled(storage(null), "off")).toBe(false)
    // The per-browser choice wins over the build (E2E_EDITOR=extension).
    expect(defaultEditorExtensionEnabled(storage("on"), "off")).toBe(true)
  })

  it("survives blocked storage", () => {
    const blocked = { getItem: () => { throw new Error("SecurityError") } }
    expect(defaultEditorExtensionEnabled(blocked, undefined)).toBe(true)
  })

  it("a user who never chose gets the extension when it is installed, else the original", () => {
    expect(resolveEditor({ project: null, files: {} }, "f1", [EXT], EXT)).toBe(EXT)
    expect(resolveEditor({ project: null, files: {} }, "f1", [], EXT)).toBe(STANDARD_EDITOR)
  })

  it("'Use the original Aquilla editor' wins over the default for every file of the project", () => {
    const original = chooseOriginalEditor()
    expect(resolveEditor(original, "f1", [EXT], EXT)).toBe(STANDARD_EDITOR)
    expect(resolveEditor(original, "f2", [EXT], EXT)).toBe(STANDARD_EDITOR)
    // …and the extension is one pick away again.
    expect(resolveEditor(chooseEditor(original, "f1", EXT, true), "f2", [EXT], EXT)).toBe(EXT)
  })

  it("falls back to the original editor when the extension failed to load, even if chosen explicitly", () => {
    const failed = new Set([EXT])
    expect(resolveEditor({ project: null, files: {} }, "f1", [EXT], EXT, failed)).toBe(STANDARD_EDITOR)
    expect(resolveEditor(chooseEditor({ project: null, files: {} }, "f1", EXT, false), "f1", [EXT], EXT, failed)).toBe(STANDARD_EDITOR)
    // A remembered extension that is merely gone still resolves to the default.
    expect(resolveEditor({ project: "removed", files: {} }, "f1", [EXT], EXT)).toBe(EXT)
  })
})
