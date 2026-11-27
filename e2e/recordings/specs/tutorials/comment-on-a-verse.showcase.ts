import { expect } from "@playwright/test"
import { Workspace } from "../../../helpers/page-objects/Workspace"
import { tutorial } from "../../tutorials/tutorial"

const VERSE = 1
const COMMENT = "Should this be « Elle » or « Il »? Let's agree before we go on."

tutorial("comment-on-a-verse", async (t) => {
  const { page, show } = t
  const ws = new Workspace(page)
  const row = ws.cellRow(VERSE)
  const drawer = page.locator("[data-testid='comments-drawer']").first()

  await t.say("intro")

  await show.point(row.locator('[data-showcase="editor.target"]').first())
  const addComment = await ws.openRowAction(row, "Add comment")
  await show.point(addComment)
  await t.say("open")
  await show.click(addComment)
  await expect(drawer).toBeVisible()

  const composer = drawer.getByRole("textbox", { name: "New thread" })
  await show.click(composer)
  const typing = composer.pressSequentially(COMMENT, { delay: 35 })
  await t.say("write")
  await typing

  const post = drawer.getByRole("button", { name: "Post" })
  await show.point(post)
  await t.say("post")
  await show.click(post)
  await expect(drawer.getByRole("listitem")).toContainText(COMMENT, { timeout: 10_000 })

  await t.closeUp(drawer.getByRole("listitem").first(), async () => {
    await t.say("outro")
  }, 1.3)
})
