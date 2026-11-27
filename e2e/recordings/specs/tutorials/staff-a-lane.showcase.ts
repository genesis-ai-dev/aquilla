import { expect } from "@playwright/test"
import { startOn } from "../../tutorials/setup"
import { tutorial } from "../../tutorials/tutorial"

tutorial("staff-a-lane", async (t) => {
  const { page, show } = t
  await t.say("intro")

  const french = page.getByText("French", { exact: true }).last()
  await french.scrollIntoViewIfNeeded()
  await show.point(french)
  await french.click({ button: "right" })
  const staff = page.getByRole("menuitem", { name: /^Staff/ })
  await show.point(staff)
  await t.say("open")
  await show.click(staff)

  const search = page.getByPlaceholder("Search org members and project invitees")
  await show.click(search)
  const typing = search.pressSequentially("tomas", { delay: 70 })
  await t.say("search")
  await typing
  await show.click(page.getByText("tomas.reyes").last())

  await show.click(page.getByRole("combobox", { name: "Role" }))
  await t.say("role")
  await show.click(page.getByRole("option", { name: /^Contributor/ }))

  const sentence = page.getByText(/French language lane only/).first()
  await show.point(sentence)
  await t.say("confirm")
  const add = page.getByRole("button", { name: /^Add — French/ })
  await show.click(add)
  await expect(add).toBeHidden({ timeout: 15_000 })
  await page.keyboard.press("Escape")
  await show.point(page.getByText("French", { exact: true }).last())
}, { setup: startOn("/project/demo-john", (page) => page.getByRole("button", { name: "Open project" }).waitFor()) })
