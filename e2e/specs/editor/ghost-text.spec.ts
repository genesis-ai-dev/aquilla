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
 * The second test covers the source-aware path: the suggestion comes from the
 * cell's own source verse through the project-learned lexicon.
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

  await assist.openNextUnfinished(cellId)
  await assist.type("E hizo Dios animales de ")

  // Learned from the other validated verses ("… de la tierra …").
  // The forecast worker indexes the file's cells shortly after they load and a
  // suggestion is asked for on each keystroke, so re-type the last space until
  // the index has answered rather than sleeping.
  await expect(async () => {
    await page.keyboard.press("Backspace")
    await page.keyboard.type(" ")
    await expect(assist.ghost(cellId)).toHaveText("la tierra", { timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  // A decoration, not text: the editor's document does not contain it.
  expect(await assist.documentText(cellId))
    .toBe("E hizo Dios animales de ")

  await assist.acceptSuggestion()
  await expect.poll(() => assist.documentText(cellId)).toBe("E hizo Dios animales de la tierra")
  await assist.type(" según ")
  await expect(assist.ghost(cellId)).toHaveText("su género")
  // →: just the next word.
  await assist.acceptNextWord()
  await expect.poll(() => assist.documentText(cellId)).toBe("E hizo Dios animales de la tierra según su")
  await assist.type(" género, y ganado")

  // Words that fit here: swap "género" for a word the project uses in the same slots.
  await assist.selectWord(cellId, "género")
  const panel = await assist.openWordsThatFit()
  await expect(panel.getByRole("button", { name: "Replace with especie" })).toBeVisible()
  await assist.replaceWith("especie")
  const expected = "E hizo Dios animales de la tierra según su especie, y ganado"
  await expect.poll(() => assist.documentText(cellId)).toBe(expected)

  await ws.blurEditor()
  await expect.poll(async () => {
    const rows = await readProjectedCells(session.jwt, seeded, "target")
    return rows.find((row) => row.cellId === cellId)?.value
  }, { timeout: 15_000 }).toBe(expected)
})

// Genesis 1:22: "God blessed them, saying, “Be fruitful, and multiply, …”".
// No other verse continues "… bendijo diciendo:" with "Fructificad", so the
// only way the editor can offer it is from this cell's own SOURCE verse,
// aligned through the project-learned lexicon (source cells ride the same feed).
const SOURCE_DRIVEN_REF = "GEN 1:22"

test("ghost text uses the cell's source verse: an empty cell's first word, and a key term", async ({ page }) => {
  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.goto("/")
  await injectSession(page, session)
  const seeded = await seedTranslatedProject(session.jwt, "alice", { heldOut: [SOURCE_DRIVEN_REF] })
  const cellId = seeded.cellIds[seeded.rowOf(SOURCE_DRIVEN_REF)]
  const ws = await openSeededProject(page, seeded)
  const assist = new TypingAssist(page, ws)
  await assist.openNextUnfinished(cellId)

  // Empty cell: "God blessed …" → "bendijo". Re-type a space and remove it
  // until the worker has indexed the file (no sleeping; see the test above).
  await expect(async () => {
    await page.keyboard.type(" ")
    await page.keyboard.press("Backspace")
    await expect(assist.ghost(cellId)).toHaveText(/^bendijo/, { timeout: 1_000 })
  }).toPass({ timeout: 15_000 })

  await assist.type("Y Dios los bendijo diciendo: ")
  // "Be fruitful" → "Fructificad", a word no earlier verse puts here.
  await expect(assist.ghost(cellId)).toHaveText(/^Fructificad/)
  await assist.acceptNextWord()
  const expected = "Y Dios los bendijo diciendo: Fructificad"
  await expect.poll(() => assist.documentText(cellId)).toBe(expected)

  await ws.blurEditor()
  await expect.poll(async () => {
    const rows = await readProjectedCells(session.jwt, seeded, "target")
    return rows.find((row) => row.cellId === cellId)?.value
  }, { timeout: 15_000 }).toBe(expected)
})
