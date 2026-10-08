import { test, expect } from "@playwright/test"
import { resetBackend } from "../../helpers/seed"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { openSeededProject, readProjectedCells } from "../../helpers/seed-project"
import { seedTranslatedProject } from "../../helpers/seed-forecast"
import { TypingAssist } from "../../helpers/page-objects/TypingAssist"
import { Showcase } from "../helpers/showcase"

/**
 * BIA + source verse · documentation take (1280×720).
 *
 * Money moment: on a fresh verse (Genesis 1:22) the very first ghost word, and
 * the key term "Fructificad", come from the cell's own SOURCE verse ("God
 * blessed them … Be fruitful") through the lexicon the project learned from
 * its validated verses — no earlier verse continues the target that way. The
 * take asserts the accepted text landed in the projection before it calls
 * itself verified. Same journey as the second test in
 * e2e/specs/editor/ghost-text.spec.ts, paced for viewers.
 */

const FRAME = { width: 1280, height: 720 }
test.use({ viewport: FRAME, video: { mode: "on", size: FRAME } })

const REF = "GEN 1:22"

test("BIA · ghost text that reads the source verse", async ({ page }) => {
  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.goto("/")
  await injectSession(page, session)
  const seeded = await seedTranslatedProject(session.jwt, "alice", { heldOut: [REF], name: "Génesis — RV1909" })
  const cellId = seeded.cellIds[seeded.rowOf(REF)]
  const ws = await openSeededProject(page, seeded)
  const assist = new TypingAssist(page, ws)

  const show = new Showcase(page, {
    persona: "p1-field-translator",
    feature: "bia-source-ghost-text",
    title: "Ghost text that reads the source verse",
    cta: "Aquilla aligns the source to your project's own translations to suggest the next word.",
    mode: "doc",
  })

  let verified = false
  try {
    await show.chapter("Suggestions from the source", "Genesis 1:22 — “God blessed them, saying, ‘Be fruitful…’”")
    await assist.openNextUnfinished(cellId)
    await expect(async () => {
      await page.keyboard.type(" ")
      await page.keyboard.press("Backspace")
      await expect(assist.ghost(cellId)).toHaveText(/^bendijo/, { timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
    await show.caption("An empty cell: the source says “God blessed”, so the first suggestion is “bendijo”.")
    await show.beat(2600)

    await assist.type("Y Dios los bendijo diciendo: ", 60)
    await expect(assist.ghost(cellId)).toHaveText(/^Fructificad/)
    await show.caption("“Be fruitful” → “Fructificad”: learned from this project's verses, not from any earlier context.")
    await show.beat(2600)
    await assist.acceptNextWord()
    await show.beat(700)

    await assist.type(" y multiplicad, y henchid las aguas en los mares, y las ", 45)
    await expect(assist.ghost(cellId)).toHaveText(/^aves/)
    await show.caption("“birds” in the source → “aves”. → accepts one word.")
    await show.beat(2200)
    await assist.acceptNextWord()
    await show.beat(800)

    const expected = "Y Dios los bendijo diciendo: Fructificad y multiplicad, y henchid las aguas en los mares, y las aves"
    await expect.poll(() => assist.documentText(cellId)).toBe(expected)
    await ws.blurEditor()
    await expect.poll(async () => {
      const rows = await readProjectedCells(session.jwt, seeded, "target")
      return rows.find((row) => row.cellId === cellId)?.value
    }, { timeout: 15_000 }).toBe(expected)
    verified = true
    await show.caption("Accepted words commit like typed ones. Nothing is written until you accept.")
    await show.beat(2200)
  } finally {
    await show.save(verified)
  }
  expect(verified).toBe(true)
})
