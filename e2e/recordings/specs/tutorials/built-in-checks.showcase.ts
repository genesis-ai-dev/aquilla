import { expect } from "@playwright/test"
import { Workspace } from "../../../helpers/page-objects/Workspace"
import { tutorial } from "../../tutorials/tutorial"

/** John 1:2. Its source ends with a period, and so does its translation. */
const VERSE = 1
const WITHOUT_PERIOD = "Elle était au commencement avec Dieu"

tutorial("built-in-checks", async (t) => {
  const { page, show } = t
  const ws = new Workspace(page)
  const row = ws.cellRow(VERSE)
  const target = row.locator('[data-cell-type="target"]').first()
  const flag = row.getByRole("img", { name: /^Line 2\. End punctuation/ })

  await t.say("intro")

  // Take the period off the end, as a translator might by accident.
  await show.point(target)
  await ws.activateTargetCell(VERSE)
  await page.keyboard.press("End")
  await page.keyboard.press("Backspace")
  await ws.blurEditor()
  await expect(target).toContainText(WITHOUT_PERIOD)
  await expect(flag).toBeVisible({ timeout: 10_000 })

  await t.closeUp(flag, async () => {
    await show.point(flag)
    await t.say("flag")
    await show.click(flag)
    await t.say("open")
    await t.say("example")
  }, 1.6)
  await page.keyboard.press("Escape")

  const fileOptions = page.getByRole("button", { name: /^File options$/ })
  await show.click(fileOptions)
  const checkFile = page.getByRole("menuitemcheckbox", { name: /^Check file/ })
  await expect(checkFile).toBeVisible()
  await show.point(checkFile)
  await t.say("file")
  await show.click(checkFile)
  await page.keyboard.press("Escape")
  const report = page.getByText("File check", { exact: true })
  await expect(report).toBeVisible()
  await show.point(page.getByText("End punctuation", { exact: true }).last())

  // Put the period back: the flag goes.
  await ws.activateTargetCell(VERSE)
  await page.keyboard.press("End")
  await page.keyboard.type(".")
  await ws.blurEditor()
  await expect(flag).toBeHidden({ timeout: 10_000 })
  await show.point(row.getByLabel(/^Line 2/))
  await t.say("outro")
})
