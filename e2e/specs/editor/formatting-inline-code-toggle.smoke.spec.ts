import { test, expect } from "../../helpers/multi-user"
import { formattingBubbleButton, selectEditorContents } from "../../helpers/editor-selection"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * TranslatedEditor BubbleMenu — Inline code toggle button.
 *
 * TranslatedEditor.tsx renders a BubbleMenu on text selection with a Code
 * button (title="Inline code"). Clicking it calls editor.chain().focus()
 * .toggleCode().run(). When active the button gets class "bg-accent".
 *
 * This spec: edit a cell → type text → select it → bubble menu appears →
 * click "Inline code" → verify the button gets "bg-accent" class (active) →
 * click again → verify class is removed (toggled off).
 *
 * The button's BASE class always contains "hover:bg-accent", so a bare
 * /bg-accent/ regex matches even when inactive — anchor the token to
 * whitespace/string boundaries to test only the standalone active class.
 */
const ACTIVE_CLASS = /(?:^|\s)bg-accent(?:\s|$)/

test("formatting bubble menu Inline code button toggles on and off", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `InlineCode ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  const targetCell = await ws.activateTargetCell(0)

  // Type some text.
  await alice.keyboard.type("code_sample text")

  // Select all text in the cell to trigger the BubbleMenu.
  await selectEditorContents(targetCell)

  // The BubbleMenu should appear with the "Inline code" button.
  const codeBtn = formattingBubbleButton(alice, "Inline code")
  await expect(codeBtn).toBeVisible({ timeout: 5_000 })

  // The button should NOT have "bg-accent" initially.
  await expect(codeBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 2_000 })

  // Click to activate inline code.
  await codeBtn.click()

  // The button should now have "bg-accent" (active state).
  await expect(codeBtn).toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })

  // Click again to deactivate.
  await codeBtn.click()

  // "bg-accent" should be removed.
  await expect(codeBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })
})
