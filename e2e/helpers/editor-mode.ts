/**
 * Which editor a run drives (AQU-1793). The product's default editor is the
 * first-party Smart Extension; the e2e stack builds with it OFF so journeys
 * guard the built-in editor by default. `E2E_EDITOR=extension` opts every
 * authed page into the extension editor (localStorage, before the app loads)
 * and points the Workspace page object at its sandboxed frame — the same
 * journeys then prove the extension does the same job.
 */
export type EditorUnderTest = "builtin" | "extension"

export function editorUnderTest(): EditorUnderTest {
  return process.env.E2E_EDITOR === "extension" ? "extension" : "builtin"
}

/** The first-party editor extension's frame (ToolFrame title). */
export const EXTENSION_EDITOR_FRAME = 'iframe[title="Aquilla Editor (sandboxed extension)"]'

/** Init-script source that opts a browser context into the extension editor. */
export function editorOptInScript(): string {
  const value = editorUnderTest() === "extension" ? "on" : "off"
  return `try { localStorage.setItem("aquilla.extensions.defaultEditor", ${JSON.stringify(value)}) } catch {}`
}
