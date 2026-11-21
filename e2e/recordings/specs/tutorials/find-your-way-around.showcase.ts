import { expect } from "@playwright/test"
import { tutorial } from "../../tutorials/tutorial"

tutorial("find-your-way-around", async (t) => {
  const { page, show } = t
  const chapterPicker = page.getByRole("combobox", { name: /Current chapter/ })
  // The app wraps its numbers in bidi isolates, so "6 cells" is not /\d+ cells/.
  const progress = page.getByText(/cells ·.*translated/).first()

  await t.say("intro")

  await show.point("@sidebar.file")
  await t.say("files")
  await show.click("@sidebar.file")
  await expect(page.locator('[data-showcase="editor.source"]').first()).toContainText("In the beginning")

  await t.closeUp("@editor.source", async () => {
    await show.point("@editor.source")
    await show.point("@editor.target")
    await t.say("columns")
  })

  await show.click(chapterPicker)
  await expect(page.getByRole("option", { name: /John 1/ })).toBeVisible()
  await t.say("chapter")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("option", { name: /John 1/ })).toBeHidden()

  await t.closeUp(progress, async () => {
    await show.point(progress)
    await t.say("progress")
  })

  await expect(progress).toContainText(/translated/)
  await t.say("outro")
})
