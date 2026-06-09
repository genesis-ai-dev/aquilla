import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * TranslatedEditor — Bold keyboard shortcut (Ctrl+B / Cmd+B).
 *
 * TipTap wires Ctrl+B (Win/Linux) and Cmd+B (Mac) to the Bold mark via
 * the StarterKit extension. After typing text and applying Ctrl+B, the
 * bubble menu "Bold (Cmd+B)" button should show an active background.
 *
 * This spec:
 *   1. Import a file and open the editor.
 *   2. Click the translation cell and type some text.
 *   3. Select all (Ctrl+A).
 *   4. Press Ctrl+B (keyboard shortcut — not the toolbar button).
 *   5. Verify the Bold button shows active state (has bg-accent class).
 */
test("formatting bold keyboard shortcut (Ctrl+B) toggles bold mark", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `BoldKb ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Click into the first translation cell and type text.
  const row = ws.cellRow(0)
  const translationArea = row.locator('[contenteditable="true"]').last()
  await translationArea.click()
  await alice.keyboard.insertText("keyboard bold test")

  // Select all text in this editor.
  await alice.keyboard.press("Control+A")

  // The bubble menu should appear. Wait for Bold button.
  const boldBtn = alice.locator('button[title="Bold (Cmd+B)"]')
  await expect(boldBtn).toBeVisible({ timeout: 5_000 })

  // Press Ctrl+B (keyboard shortcut — distinct from clicking the button).
  await alice.keyboard.press("Control+B")

  // The Bold button should now show active state.
  await expect(boldBtn).toHaveClass(/bg-accent/, { timeout: 3_000 })
})
