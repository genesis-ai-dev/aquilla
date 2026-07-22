import { test, expect } from "../../helpers/multi-user"
import { formattingBubbleButton, selectEditorContents } from "../../helpers/editor-selection"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

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
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `UndStrike ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  const targetCell = await ws.activateTargetCell(0)

  // Type text.
  await alice.keyboard.type("underline strikethrough test")

  // Select all to trigger BubbleMenu.
  await selectEditorContents(targetCell)

  // --- Underline ---
  const underlineBtn = formattingBubbleButton(alice, "Underline")
  await expect(underlineBtn).toBeVisible({ timeout: 5_000 })
  await expect(underlineBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 2_000 })

  await underlineBtn.click()
  await expect(underlineBtn).toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })

  await underlineBtn.click()
  await expect(underlineBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })

  // --- Strikethrough ---
  const strikeBtn = formattingBubbleButton(alice, "Strikethrough")
  await expect(strikeBtn).toBeVisible({ timeout: 5_000 })
  await expect(strikeBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 2_000 })

  await strikeBtn.click()
  await expect(strikeBtn).toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })

  await strikeBtn.click()
  await expect(strikeBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })
})
