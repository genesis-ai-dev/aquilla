import { expect } from "@playwright/test"
import { uploadSampleRecordings } from "../../tutorials/setup"
import { tutorial } from "../../tutorials/tutorial"

tutorial("media-view", async (t) => {
  const { page, show } = t
  const mediaTab = page.getByRole("tab", { name: "Media" })

  await t.say("intro")

  await show.point(mediaTab)
  await t.say("open")
  await show.click(mediaTab)
  const firstTake = page.getByRole("button", { name: /^Take Play this clip/ }).first()
  await expect(firstTake).toBeVisible({ timeout: 20_000 })

  await t.closeUp(firstTake, async () => {
    await show.point(firstTake)
    await t.say("timeline")
    await show.point(page.getByText("Source text", { exact: true }).first())
    await t.say("source")
  }, 1.4)

  const station = page.getByRole("tab", { name: "Station" })
  await show.point(page.getByRole("tab", { name: "Text" }).filter({ visible: true }).last())
  await show.point(station)
  await t.say("below")

  const panels = page.getByRole("button", { name: /Panels/ }).first()
  await show.click(panels)
  await t.say("panels")
  await page.keyboard.press("Escape")
}, { setup: uploadSampleRecordings })
