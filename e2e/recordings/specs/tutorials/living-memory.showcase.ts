import { expect } from "@playwright/test"
import { tutorial } from "../../tutorials/tutorial"

const INSTRUCTIONS =
  "Plain, everyday French for young adults. Keep names as they appear in the Louis Segond Bible. Prefer short sentences."

tutorial("living-memory", async (t) => {
  const { page, show } = t
  const sidebarLink = page.getByRole("link", { name: "Living Memory" }).or(page.getByRole("button", { name: "Living Memory" })).first()

  await t.say("intro")

  await show.point(sidebarLink)
  await t.say("open")
  await show.click(sidebarLink)
  await expect(page.getByRole("heading", { name: "Living Memory" })).toBeVisible()

  const parts = page.getByText("Instructions", { exact: true }).first()
  await t.closeUp(parts, async () => {
    await show.point(parts)
    await t.say("parts")
  }, 1.3)

  await show.click(parts)
  const box = page.getByPlaceholder(/^For example: Plain/)
  await expect(box).toBeVisible()
  await show.click(box)
  const typing = box.pressSequentially(INSTRUCTIONS, { delay: 30 })
  await t.say("instructions")
  await typing
  await expect(box).toHaveValue(INSTRUCTIONS)

  await t.say("saves")
  await page.getByText("Living Memory", { exact: true }).filter({ visible: true }).first().hover()
  await t.say("outro")
})
