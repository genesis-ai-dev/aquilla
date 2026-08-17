import { test, expect } from "../../helpers/multi-user"
import {
  editorShortcut,
  formattingBubbleButton,
  selectEditorContents,
} from "../../helpers/editor-selection"
import {
  jwtFor,
  openSeededProject,
  seedProjectWithFile,
} from "../../helpers/seed-project"

/**
 * Surface session: TranslatedEditor BubbleMenu formatting + formatting-loss
 * warning. One `{ alice }` fixture → one resetBackend(); steps use distinct
 * cells so mutations do not conflict.
 *
 * The button's BASE class always contains "hover:bg-accent", so a bare
 * /bg-accent/ regex matches even when inactive — anchor the token to
 * whitespace/string boundaries to test only the standalone active class.
 */
const ACTIVE_CLASS = /(?:^|\s)bg-accent(?:\s|$)/

test("formatting bubble menu and loss warning surface session", async ({ alice }) => {
  // Several editor interactions in one session — above the 60s default ceiling.
  test.setTimeout(120_000)

  const seeded = await seedProjectWithFile(await jwtFor(alice.username), {
    name: `Formatting ${Date.now()}`,
  })
  const ws = await openSeededProject(alice, seeded)

  await test.step("bubble menu appears on selection; Bold click keeps it visible", async () => {
    const targetCell = await ws.activateTargetCell(0)
    await expect(targetCell).toBeFocused({ timeout: 3_000 })
    await alice.keyboard.insertText("bubble menu test")
    await selectEditorContents(targetCell)

    const boldBtn = formattingBubbleButton(alice, "Bold")
    await expect(boldBtn).toBeVisible({ timeout: 5_000 })
    await boldBtn.click()
    await expect(boldBtn).toBeVisible({ timeout: 2_000 })
  })

  await test.step("Ctrl+B toggles bold mark active class", async () => {
    const translationArea = await ws.activateTargetCell(2)
    await alice.keyboard.insertText("keyboard bold test")
    await selectEditorContents(translationArea)

    const boldBtn = formattingBubbleButton(alice, "Bold")
    await expect(boldBtn).toBeVisible({ timeout: 5_000 })
    await alice.keyboard.press(editorShortcut("B"))
    await expect(boldBtn).toHaveClass(/bg-accent/, { timeout: 3_000 })
  })

  await test.step("Italic button toggles on and off", async () => {
    const targetCell = await ws.activateTargetCell(3)
    await targetCell.type("Hello world")
    await selectEditorContents(targetCell)

    const italicBtn = formattingBubbleButton(alice, "Italic")
    await expect(italicBtn).toBeVisible({ timeout: 5_000 })
    await italicBtn.click()
    await expect(italicBtn).toHaveClass(ACTIVE_CLASS, { timeout: 2_000 })
    await italicBtn.click()
    await expect(italicBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 2_000 })
  })

  await test.step("Underline and Strikethrough toggle on and off", async () => {
    const targetCell = await ws.activateTargetCell(4)
    await alice.keyboard.type("underline strikethrough test")
    await selectEditorContents(targetCell)

    const underlineBtn = formattingBubbleButton(alice, "Underline")
    await expect(underlineBtn).toBeVisible({ timeout: 5_000 })
    await expect(underlineBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 2_000 })
    await underlineBtn.click()
    await expect(underlineBtn).toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })
    await underlineBtn.click()
    await expect(underlineBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })

    const strikeBtn = formattingBubbleButton(alice, "Strikethrough")
    await expect(strikeBtn).toBeVisible({ timeout: 5_000 })
    await expect(strikeBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 2_000 })
    await strikeBtn.click()
    await expect(strikeBtn).toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })
    await strikeBtn.click()
    await expect(strikeBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })
  })

  await test.step("Inline code button toggles on and off", async () => {
    const targetCell = await ws.activateTargetCell(5)
    await alice.keyboard.type("code_sample text")
    await selectEditorContents(targetCell)

    const codeBtn = formattingBubbleButton(alice, "Inline code")
    await expect(codeBtn).toBeVisible({ timeout: 5_000 })
    await expect(codeBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 2_000 })
    await codeBtn.click()
    await expect(codeBtn).toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })
    await codeBtn.click()
    await expect(codeBtn).not.toHaveClass(ACTIVE_CLASS, { timeout: 3_000 })
  })

  await test.step("formatting loss warning when target drops source bold", async () => {
    // sample.md row index 1 (0-based) contains the bold word in source.
    const row = ws.cellRow(1)
    await row.scrollIntoViewIfNeeded()
    await ws.editCell(1, "plain translation without bold")

    const warningIcon = row.getByTestId("formatting-loss-warning")
    await expect(warningIcon).toBeVisible({ timeout: 8_000 })
    await warningIcon.hover()
    await expect(
      alice.getByRole("tooltip", {
        name: /Source has inline formatting that the target does not preserve/i,
      }),
    ).toBeVisible({ timeout: 3_000 })
  })
})
