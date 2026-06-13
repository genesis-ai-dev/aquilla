import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * TranslatedEditor BubbleMenu — Underline and Strikethrough buttons.
 *
 * TranslatedEditor.tsx renders a BubbleMenu on text selection with:
 *   - Underline button (title="Underline (Cmd+U)")
 *   - Strikethrough button (title="Strikethrough")
 *
 * Both get class "bg-accent" when active. Clicking toggles them.
 *
 * This spec: edit a cell → select text → verify both buttons appear →
 * toggle Underline on and off → toggle Strikethrough on and off.
 *
 * The buttons' BASE class always contains "hover:bg-accent", so a bare
 * /bg-accent/ regex matches even when inactive — anchor the token to
 * whitespace/string boundaries to test only the standalone active class.
 */
const ACTIVE_CLASS = /(?:^|\s)bg-accent(?:\s|$)/

test("formatting bubble menu Underline and Strikethrough toggle on and off", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `UndStrike ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()

  // Double-click to enter edit mode.
  const targetCell = row.locator('[contenteditable="true"]').first()
  await targetCell.dblclick()

  // Clear and type text.
  await alice.keyboard.press("Control+a")
  await alice.keyboard.type("underline strikethrough test")

  // Select all to trigger BubbleMenu.
  await alice.keyboard.press("Control+a")

  // --- Underline ---
  const underlineBtn = alice.locator('button[title="Underline (Cmd+U)"]')
  await expect(underlineBtn).toBeVisible({ timeout: 5_000 })
  await expect(underlineBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 2_000 })

  await underlineBtn.click()
  await expect(underlineBtn).toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })

  await underlineBtn.click()
  await expect(underlineBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })

  // --- Strikethrough ---
  const strikeBtn = alice.locator('button[title="Strikethrough"]')
  await expect(strikeBtn).toBeVisible({ timeout: 5_000 })
  await expect(strikeBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 2_000 })

  await strikeBtn.click()
  await expect(strikeBtn).toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })

  await strikeBtn.click()
  await expect(strikeBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })
})
