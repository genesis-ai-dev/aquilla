import { test, expect } from "../../helpers/multi-user"
import { editorShortcut, formattingBubbleButton, selectEditorContents } from "../../helpers/editor-selection"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

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
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `BoldKb ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Click into the first translation cell and type text.
  const translationArea = await ws.activateTargetCell(0)
  await alice.keyboard.insertText("keyboard bold test")

  // Select all text in this editor.
  await selectEditorContents(translationArea)

  // The bubble menu should appear. Wait for Bold button.
  const boldBtn = formattingBubbleButton(alice, "Bold")
  await expect(boldBtn).toBeVisible({ timeout: 5_000 })

  // Press Ctrl+B (keyboard shortcut — distinct from clicking the button).
  await alice.keyboard.press(editorShortcut("B"))

  // The Bold button should now show active state.
  await expect(boldBtn).toHaveClass(/bg-accent/, { timeout: 3_000 })
})
