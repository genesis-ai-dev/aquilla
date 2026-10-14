import { test, expect } from "@playwright/test"
import { resetBackend } from "../../helpers/seed"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { openSeededProject, readProjectedCells } from "../../helpers/seed-project"
import { seedTranslatedProject } from "../../helpers/seed-forecast"
import { TypingAssist } from "../../helpers/page-objects/TypingAssist"
import { Showcase } from "../helpers/showcase"

/**
 * BIA forecasting · documentation take (1280×720).
 *
 * Money moment: while a translator types Genesis 1:25 in Spanish, faint ghost
 * text offers the next words — learned only from this project's other
 * validated verses — Tab / → accept them, and "words that fit here" swaps a
 * word for one the project uses in the same places. The take asserts the
 * committed text landed in the projection before it calls itself verified.
 *
 * Same journey as e2e/specs/editor/ghost-text.spec.ts, paced for viewers.
 */

const FRAME = { width: 1280, height: 720 }
test.use({ viewport: FRAME, video: { mode: "on", size: FRAME } })

const HELD_OUT_REF = "GEN 1:25"

test("BIA · ghost-text suggestions and words that fit here", async ({ page }) => {
  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.goto("/")
  await injectSession(page, session)
  const seeded = await seedTranslatedProject(session.jwt, "alice", { heldOut: [HELD_OUT_REF], name: "Génesis — RV1909" })
  const cellId = seeded.cellIds[seeded.rowOf(HELD_OUT_REF)]
  const ws = await openSeededProject(page, seeded)
  const assist = new TypingAssist(page, ws)

  const show = new Showcase(page, {
    persona: "p1-field-translator",
    feature: "bia-ghost-text",
    title: "Ghost text that learns from your own translation",
    cta: "Aquilla suggests the next words from the verses your team already validated.",
    mode: "doc",
  })

  let verified = false
  try {
    await show.chapter("Ghost text", "Genesis 1:25 is the one verse left to translate.")
    await assist.openNextUnfinished(cellId)
    await assist.type("E hizo Dios animales de ", 70)
    await expect(async () => {
      await page.keyboard.press("Backspace")
      await page.keyboard.type(" ")
      await expect(assist.ghost(cellId)).toHaveText("la tierra", { timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
    await show.caption("A faint suggestion, learned from the other 30 validated verses.")
    await show.beat(1400)

    await show.caption("Tab accepts it…")
    await assist.acceptSuggestion()
    await show.beat(900)

    await assist.type(" según ", 70)
    await expect(assist.ghost(cellId)).toHaveText("su género")
    await show.caption("…→ takes just the next word.")
    await show.beat(600)
    await assist.acceptNextWord()
    await assist.type(" género", 70)
    await assist.type(", y ganado según ", 60)
    await expect(assist.ghost(cellId)).toHaveText("su género")
    await show.beat(600)
    await assist.acceptSuggestion()
    await show.beat(800)

    await show.chapter("Words that fit here", "The same engine, with the word blanked out.")
    await assist.selectWord(cellId, "género")
    await show.click('[data-testid="words-that-fit-button"]')
    await expect(page.getByTestId("words-that-fit-panel").getByRole("button", { name: "Replace with especie" })).toBeVisible()
    await show.caption("Words this project uses in the same places — click one to swap it in.")
    await show.beat(1600)
    await show.click('[data-testid="words-that-fit-panel"] button[aria-label="Replace with especie"]')
    const expected = "E hizo Dios animales de la tierra según su especie, y ganado según su género"
    await expect.poll(() => assist.documentText(cellId)).toBe(expected)
    await show.beat(1200)

    await ws.blurEditor()
    await expect.poll(async () => {
      const rows = await readProjectedCells(session.jwt, seeded, "target")
      return rows.find((row) => row.cellId === cellId)?.value
    }, { timeout: 15_000 }).toBe(expected)
    verified = true
    await show.caption("Accepted words commit like typed ones. Nothing is written until you accept.")
    await show.beat(1800)
  } finally {
    await show.save(verified)
  }
  expect(verified).toBe(true)
})
