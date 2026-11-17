import { expect } from "@playwright/test"
import { Workspace } from "../../../helpers/page-objects/Workspace"
import { tutorial } from "../../tutorials/tutorial"

// John 1:6, Louis Segond 1910 (public domain), as the demo's other verses are.
const TRANSLATION = "Il y eut un homme envoyé de Dieu: son nom était Jean."
/** The demo's sixth verse is the one left without a translation. */
const EMPTY_VERSE = 5

tutorial("translate-a-verse", async (t) => {
  const { page, show } = t
  const ws = new Workspace(page)
  const row = ws.cellRow(EMPTY_VERSE)
  const target = row.locator('[data-cell-type="target"]').first()

  await t.say("intro")

  await row.scrollIntoViewIfNeeded()
  await show.point(row.locator('[data-showcase="editor.source"]').first())
  await t.say("find")

  await show.point(target)
  await t.say("click")
  await ws.activateTargetCell(EMPTY_VERSE)

  // Typed while the line is said, at a pace a person can follow.
  const typing = page.keyboard.type(TRANSLATION, { delay: 45 })
  await t.say("type")
  await typing

  // Leaving the cell saves it: wait for the server to take the write.
  const saved = page.waitForResponse(
    (response) => response.ok() && response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/events"),
    { timeout: 20_000 },
  )
  await ws.blurEditor()
  await saved
  await expect(target).toContainText(TRANSLATION)
  await t.say("save")

  await ws.expectSelfValidated(EMPTY_VERSE)
  await t.closeUp(target, async () => {
    await t.say("outro")
  })
})
