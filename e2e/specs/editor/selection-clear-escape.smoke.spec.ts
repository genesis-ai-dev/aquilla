import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * SelectionBar — Escape key clears selection when no editable is focused.
 *
 * SelectionBar.tsx listens to window "keydown" for Escape. When Escape is
 * pressed and no INPUT/TEXTAREA/contenteditable has focus, clearSelection()
 * is called and the bar disappears.
 *
 * This spec:
 *   1. Select a cell → SelectionBar appears.
 *   2. Click outside any editable (body or the editor container — not a cell).
 *   3. Press Escape → SelectionBar disappears.
 *
 * This covers the keyboard dismiss path, distinct from the "Clear selection"
 * button click tested in selection-bar.smoke.spec.ts.
 */
test("Escape key clears selection when no editable is focused", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SelectEsc ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Hover first row to reveal the selection checkbox.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  // Select the cell.
  const selCheckbox = row.getByRole("checkbox", { name: /Select cell/i })
  await expect(selCheckbox).toBeVisible({ timeout: 3_000 })
  await selCheckbox.click()

  // SelectionBar should appear.
  const bar = alice.locator('[aria-label="Selection actions"]')
  await expect(bar).toBeVisible({ timeout: 3_000 })

  // Click something neutral (not an editable) so no editable is focused.
  // The page heading "h1" is a safe focus-neutral target.
  await alice.locator("h1").first().click()

  // Press Escape — SelectionBar should disappear.
  await alice.keyboard.press("Escape")
  await expect(bar).not.toBeVisible({ timeout: 3_000 })
})
