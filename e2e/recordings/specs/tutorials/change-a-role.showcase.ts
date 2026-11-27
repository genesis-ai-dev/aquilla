import { expect } from "@playwright/test"
import { startOn } from "../../tutorials/setup"
import { tutorial } from "../../tutorials/tutorial"

tutorial("change-a-role", async (t) => {
  const { page, show } = t
  await t.say("intro")

  const actions = page.getByRole("button", { name: "Actions for lena.hartmann" })
  await show.click(actions)
  const change = page.getByRole("menuitem", { name: /Change role/ })
  await show.point(change)
  await t.say("open")
  await show.click(change)

  const role = page.getByRole("dialog").getByRole("combobox").first()
  await show.click(role)
  await t.say("roles")
  await show.click(page.getByRole("option", { name: /^Contributor/ }))
  await t.say("pick")
  await show.click(page.getByRole("button", { name: "Save" }))
  const row = page.getByRole("row", { name: /lena\.hartmann/ })
  await expect(row.getByText("Contributor")).toBeVisible({ timeout: 15_000 })
  await show.point(row.getByText("Contributor"))
  await t.say("done")
}, { setup: startOn("/project/demo-john/settings/members", (page) => page.getByRole("button", { name: "Actions for lena.hartmann" }).waitFor()) })
