import { test, expect } from "@playwright/test"
import { resetBackend } from "../../helpers/seed"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { openSeededProject, readProjectedCells } from "../../helpers/seed-project"
import { seedTranslatedProject } from "../../helpers/seed-forecast"
import { TypingAssist } from "../../helpers/page-objects/TypingAssist"

/**
 * BIA forecasting in the editor, end to end: the model learns from the
 * project's validated target cells (sync-worker projection → SPA read →
 * forecast worker), the ghost suggestion never reaches the document until Tab
 * accepts it, the accepted text commits through `POST /events` into the
 * projection, and "words that fit here" swaps a word through the same path.
 *
 * Not a smoke: a translator loses nothing if ghost text breaks (it is an aid,
 * never a write on its own); the RTL tests cover the never-mutates contract.
 */

const HELD_OUT_REF = "GEN 1:25" // "E hizo Dios animales de la tierra según su género, …"

test("ghost text learns from validated cells; Tab and words-that-fit commit like typing", async ({ page }) => {
  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.goto("/")
  await injectSession(page, session)
  const seeded = await seedTranslatedProject(session.jwt, "alice", { heldOut: [HELD_OUT_REF] })
  const cellId = seeded.cellIds[seeded.rowOf(HELD_OUT_REF)]
  const ws = await openSeededProject(page, seeded)
  const assist = new TypingAssist(page, ws)

  const editor = await assist.openNextUnfinished(cellId)
  await assist.type("E hizo Dios animales ")

  // Learned from the other validated verses ("… animales de la tierra …").
  // The forecast worker indexes the file's cells shortly after they load and a
  // suggestion is asked for on each keystroke, so re-type the last space until
  // the index has answered rather than sleeping.
  await expect(async () => {
    await page.keyboard.press("Backspace")
    await page.keyboard.type(" ")
    await expect(assist.ghost(cellId)).toHaveText("de la", { timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  // A decoration, not text: the editor's document does not contain it.
  expect(await editor.evaluate((el) => (el as HTMLElement & { editor: { getText: () => string } }).editor.getText()))
    .toBe("E hizo Dios animales ")

  await assist.acceptSuggestion()
  await expect(editor).toContainText("E hizo Dios animales de la")
  // The next suggestion continues with the next word.
  await expect(assist.ghost(cellId)).toHaveText(/^ tierra/)
  await assist.acceptNextWord()
  await assist.type(" según su género, y ganado")

  // Words that fit here: swap "género" for a word the project uses in the same slots.
  await assist.selectWord(cellId, "género")
  const panel = await assist.openWordsThatFit()
  await expect(panel.getByRole("button", { name: "Replace with especie" })).toBeVisible()
  await assist.replaceWith("especie")
  const expected = "E hizo Dios animales de la tierra según su especie, y ganado"
  await expect(editor).toHaveText(expected)

  await ws.blurEditor()
  await expect.poll(async () => {
    const rows = await readProjectedCells(session.jwt, seeded, "target")
    return rows.find((row) => row.cellId === cellId)?.value
  }, { timeout: 15_000 }).toBe(expected)
})
