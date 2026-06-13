import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * TranslatedEditor BubbleMenu — Italic toggle button.
 *
 * TranslatedEditor.tsx renders a BubbleMenu on text selection with
 * formatting buttons. The Italic button has title="Italic (Cmd+I)".
 * When the cursor is inside italic text, the button gets class "bg-accent".
 *
 * This spec: edit a cell → type text → select it → click Italic →
 * verify the italic button has "bg-accent" class (is active) →
 * click it again to toggle off → verify class is gone.
 *
 * The button's BASE class always contains "hover:bg-accent", so a bare
 * /bg-accent/ regex matches even when inactive — anchor the token to
 * whitespace/string boundaries to test only the standalone active class.
 */
const ACTIVE_CLASS = /(?:^|\s)bg-accent(?:\s|$)/

test("formatting bubble menu Italic button toggles on and off", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `FmtItalic ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Click into the first translated cell to start editing.
  const row = ws.cellRow(0)
  const targetCell = row.locator('[contenteditable="true"], .ProseMirror').first()
  await expect(targetCell).toBeVisible({ timeout: 5_000 })
  await targetCell.click()
  await alice.keyboard.press("Control+A")
  await targetCell.type("Hello world")

  // Select all the text.
  await alice.keyboard.press("Control+A")

  // The bubble menu should appear.
  const italicBtn = alice.locator('button[title="Italic (Cmd+I)"]')
  await expect(italicBtn).toBeVisible({ timeout: 5_000 })

  // Toggle italic on.
  await italicBtn.click()
  await expect(italicBtn).toHaveClass(ACTIVE_CLASS, { timeout: 2_000 })

  // Toggle italic off.
  await italicBtn.click()
  await expect(italicBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 2_000 })
})
