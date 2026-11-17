import { expect } from "@playwright/test"
import { tutorial } from "../../tutorials/tutorial"

tutorial("export-your-work", async (t) => {
  const { page, show } = t
  const fileOptions = page.getByRole("button", { name: /^File options$/ })
  const dialog = page.getByRole("dialog", { name: "Export", exact: true })

  await t.say("intro")

  await show.point(fileOptions)
  await t.say("menu")
  await show.click(fileOptions)

  const exportItem = page.getByRole("menuitem", { name: /^Export$/ })
  await expect(exportItem).toBeVisible()
  await show.point(exportItem)
  await t.say("choose")
  await show.click(exportItem)
  await expect(dialog.getByRole("heading", { name: "Export", exact: true })).toBeVisible()

  // The radio's name is its label followed by its description: match the start.
  const csv = dialog.getByRole("radio", { name: /^Bilingual CSV \(\.csv\)/ }).first()
  await show.point(dialog.getByRole("radiogroup", { name: "Export format" }))
  await t.say("format")
  await show.click(csv)
  await expect(csv).toBeChecked()

  const exportButton = dialog.getByRole("button", { name: /^Export$/ })
  await show.point(exportButton)
  await t.say("download")
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15_000 }),
    show.click(exportButton),
  ])
  expect(download.suggestedFilename()).toMatch(/\.csv$/)
  await expect(dialog.getByText(/Downloaded .+\.csv/i)).toBeVisible()

  await t.say("outro")
})
