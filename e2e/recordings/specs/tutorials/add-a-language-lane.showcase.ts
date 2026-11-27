import { expect } from "@playwright/test"
import { startOn } from "../../tutorials/setup"
import { tutorial } from "../../tutorials/tutorial"

tutorial("add-a-language-lane", async (t) => {
  const { page, show } = t
  await t.say("intro")

  const card = page.getByText("Language lanes", { exact: true }).first()
  await card.scrollIntoViewIfNeeded()
  await show.point(card)
  await t.say("open")

  const add = page.getByRole("button", { name: "Add language lane" })
  await show.click(add)
  const language = page.getByPlaceholder(/Traditional Han/).first()
  await show.click(language)
  const typing = language.pressSequentially("Spanish", { delay: 70 })
  await t.say("add")
  await typing
  const match = page.getByRole("option", { name: /^Spanish/ }).first()
  if (await match.waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false)) await show.click(match)

  const name = page.getByRole("textbox", { name: /^Name/ }).last()
  await show.point(name)
  await t.say("name")

  const delivers = page.getByRole("combobox", { name: /^What .* delivers$/ }).last()
  await show.point(delivers)
  await t.say("delivers")
  await show.click(page.getByRole("button", { name: "Add language lane" }).last())
  const row = page.getByRole("button", { name: /^Rename Spanish/ })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await show.point(row)
  await t.say("result")
}, { setup: startOn("/project/demo-john/settings/general", (page) => page.getByRole("button", { name: "Add language lane" }).waitFor()) })
