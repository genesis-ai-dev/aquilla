import type { Locator } from "@playwright/test"

export function editorShortcut(key: string): string {
  return `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`
}

export async function selectEditorContents(editor: Locator): Promise<void> {
  await editor.click()
  await editor.press(editorShortcut("A"))
}
