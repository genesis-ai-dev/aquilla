import { expect } from "@playwright/test"
import { startOn } from "../../tutorials/setup"
import { tutorial } from "../../tutorials/tutorial"

tutorial("remove-someone", async (t) => {
  const { page, show } = t
  await t.say("intro")

  const actions = page.getByRole("button", { name: "Actions for amara.okafor" })
  await show.point(actions)
  await t.say("open")
  await show.click(actions)
  const remove = page.getByRole("menuitem", { name: /Remove direct access/ })
  await show.point(remove)
  await t.say("remove")
  await show.click(remove)

  const dialog = page.getByRole("dialog")
  const understand = dialog.getByText("I understand this action.")
  await show.click(understand)
  await t.say("confirm")
  await show.click(dialog.getByRole("button", { name: "Remove direct access" }))
  await expect(page.getByRole("button", { name: "Actions for amara.okafor" })).toBeHidden({ timeout: 15_000 })

  await show.click(page.getByRole("button", { name: "Actions for lena.hartmann" }))
  await show.point(page.getByRole("menuitem", { name: /Revoke all access/ }))
  await t.say("more")
  await page.keyboard.press("Escape")
}, { setup: startOn("/project/demo-john/settings/members", (page) => page.getByRole("button", { name: "Actions for amara.okafor" }).waitFor()) })
