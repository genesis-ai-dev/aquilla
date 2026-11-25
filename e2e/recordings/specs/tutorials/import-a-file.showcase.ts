import { expect } from "@playwright/test"
import { PSALM_23 } from "../../tutorials/setup"
import { tutorial } from "../../tutorials/tutorial"

tutorial("import-a-file", async (t) => {
  const { page, show } = t
  const importButton = page.getByRole("button", { name: /^Import$/ }).first()

  await t.say("intro")

  await show.point(importButton)
  await t.say("open")
  await show.click(importButton)
  const dialog = page.getByRole("dialog", { name: "Import" })
  await expect(dialog.getByText("What are you importing?")).toBeVisible()

  const newSource = dialog.getByRole("radio", { name: "New source text" })
  const upload = dialog.getByRole("button", { name: /^Upload files/ })
  await show.point(newSource)
  await show.point(upload)
  await t.say("choose")

  await show.click(upload)
  const formats = page.getByText(/^Scripture — USFM/)
  await expect(formats).toBeVisible()
  await t.closeUp(formats, async () => {
    await show.point(formats)
    await t.say("formats")
  }, 1.4)

  const picker = page.waitForEvent("filechooser")
  await show.click(page.getByRole("button", { name: "Choose files" }))
  await (await picker).setFiles(PSALM_23)
  const confirm = page.getByRole("button", { name: /Confirm import/i })
  await expect(confirm).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/The LORD is my shepherd/).first()).toBeVisible()
  await t.say("preview")

  await show.point(confirm)
  await show.click(confirm)
  await expect(page.getByRole("dialog", { name: "Import" })).toBeHidden({ timeout: 30_000 })
  await expect(page.getByText(/Psalm/).first()).toBeVisible({ timeout: 20_000 })
  await t.say("confirm")
})
