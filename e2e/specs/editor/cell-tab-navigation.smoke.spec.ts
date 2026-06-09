import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * TranslatedEditor — Tab / Shift+Tab cell navigation.
 *
 * TranslatedEditor.tsx registers a TipTap keydown extension:
 *   Tab → navigate("next") — moves focus to the next target cell
 *   Shift+Tab → navigate("prev") — moves focus to the previous target cell
 *   ArrowDown (at last visual line) → navigate("next")
 *   ArrowUp (at first visual line) → navigate("prev")
 *
 * This spec:
 *   1. Imports sample.md (has ≥3 cells).
 *   2. Clicks into the first target cell to focus it.
 *   3. Presses Tab → verifies a different cell is now active
 *      (the first cell's editor no longer has focus, or the cursor moved down).
 *   4. Presses Shift+Tab → verifies focus returns to the previous cell.
 */
test("Tab moves focus to the next target cell; Shift+Tab returns to previous", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TabNav ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Click into the first target cell to open its editor.
  await ws.editCell(0, "")

  // The first cell's target editor should be focused.
  // TipTap editors are div[contenteditable="true"].
  const editors = alice.locator('[contenteditable="true"]')
  const firstEditor = editors.first()
  await expect(firstEditor).toBeFocused({ timeout: 5_000 })

  // Press Tab — should navigate to the next cell.
  await alice.keyboard.press("Tab")

  // After Tab, the first editor should no longer have focus
  // (or a second editor is focused). We verify that some contenteditable
  // other than the first is now focused.
  await alice.waitForTimeout(300)

  // Check focus moved: the active element should not be the first editor.
  // We verify by checking the focused element's index is not 0.
  const focusedIsFirst = await firstEditor.evaluate(
    (el) => el === document.activeElement
  )
  expect(focusedIsFirst).toBe(false)

  // Press Shift+Tab — should navigate back to the previous (first) cell.
  await alice.keyboard.press("Shift+Tab")
  await alice.waitForTimeout(300)

  // Now the first editor should be focused again.
  await expect(firstEditor).toBeFocused({ timeout: 5_000 })
})
