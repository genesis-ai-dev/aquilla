import { expect, type Page } from "@playwright/test"
import { tutorial } from "../../tutorials/tutorial"

/** A second language lane to manage: a project's only lane can't be archived. */
async function withSpanish(page: Page): Promise<void> {
  await page.goto("/project/demo-john/settings/general")
  await page.getByRole("button", { name: "Add language lane" }).click()
  await page.getByPlaceholder(/Traditional Han/).first().fill("Spanish")
  const match = page.getByRole("option", { name: /^Spanish/ }).first()
  if (await match.waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false)) await match.click()
  await page.getByRole("button", { name: "Add language lane" }).last().click()
  await page.getByRole("button", { name: /^Rename Spanish/ }).waitFor()
}

tutorial("manage-a-language-lane", async (t) => {
  const { page, show } = t
  await t.say("intro")

  const rename = page.getByRole("button", { name: /^Rename Spanish/ })
  await rename.scrollIntoViewIfNeeded()
  await show.click(rename)
  const field = page.getByRole("textbox").filter({ has: page.locator(":focus") }).or(page.locator("input:focus")).first()
  await field.press("ControlOrMeta+a")
  const typing = field.pressSequentially("Spanish (Latin America)", { delay: 60 })
  await t.say("rename")
  await typing
  await field.press("Enter")
  await expect(page.getByRole("button", { name: /^Rename Spanish \(Latin America\)/ })).toBeVisible()

  const delivers = page.getByRole("combobox", { name: /^What Spanish.* delivers$/ })
  await show.click(delivers)
  await t.say("delivers")
  await show.click(page.getByRole("option", { name: "Text and audio" }))

  const more = page.getByRole("button", { name: /^More for Spanish/ })
  await show.click(more)
  const archive = page.getByRole("menuitem", { name: /^Archive language lane/ })
  await show.point(archive)
  await t.say("archive")
  await show.click(archive)
  await show.click(page.getByRole("button", { name: "Confirm archive" }))
  await expect(page.getByRole("button", { name: /^Rename Spanish/ })).toBeHidden({ timeout: 15_000 })

  const archived = page.getByText(/^Archived \(1\)/)
  await show.click(archived)
  const restore = page.getByRole("button", { name: /Restore/ }).first()
  await expect(restore).toBeVisible({ timeout: 15_000 })
  await show.point(restore)
  await t.say("restore")
}, { setup: withSpanish })
