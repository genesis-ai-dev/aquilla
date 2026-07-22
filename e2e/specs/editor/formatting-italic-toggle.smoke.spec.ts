import { test, expect } from "../../helpers/multi-user"
import { formattingBubbleButton, selectEditorContents } from "../../helpers/editor-selection"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

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
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `FmtItalic ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Click into the first translated cell to start editing.
  const targetCell = await ws.activateTargetCell(0)
  await targetCell.type("Hello world")

  // Select all the text.
  await selectEditorContents(targetCell)

  // The bubble menu should appear.
  const italicBtn = formattingBubbleButton(alice, "Italic")
  await expect(italicBtn).toBeVisible({ timeout: 5_000 })

  // Toggle italic on.
  await italicBtn.click()
  await expect(italicBtn).toHaveClass(ACTIVE_CLASS, { timeout: 2_000 })

  // Toggle italic off.
  await italicBtn.click()
  await expect(italicBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 2_000 })
})
