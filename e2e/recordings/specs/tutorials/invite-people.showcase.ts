import { expect } from "@playwright/test"
import { startOn } from "../../tutorials/setup"
import { tutorial } from "../../tutorials/tutorial"

tutorial("invite-people", async (t) => {
  const { page, show } = t
  await t.say("intro")

  const addMember = page.getByRole("button", { name: "Add a member" })
  await show.point(addMember)
  await t.say("open")
  await show.click(addMember)

  const username = page.getByPlaceholder("Aquilla username")
  await show.click(username)
  const typing = username.pressSequentially("tomas", { delay: 70 })
  await t.say("add")
  await typing
  const match = page.getByRole("checkbox", { name: /tomas\.reyes/ }).or(page.getByText("tomas.reyes")).first()
  await show.click(match)
  // Close the suggestions, which cover the Add button.
  await show.click(page.getByRole("dialog").getByText(/^Grant access from your organization/))

  await show.point(page.getByText("Only selected language lanes"))
  await t.say("lanes")

  const sentence = page.getByText(/will join as a Contributor on John — Plainspeak Draft/).first()
  await t.closeUp(sentence, async () => {
    await show.point(sentence)
    await t.say("scope")
  }, 1.4)
  const add = page.getByRole("button", { name: /^Add — / })
  await show.click(add)
  await expect(page.getByRole("cell", { name: /tomas\.reyes/ }).or(page.getByText("tomas.reyes")).first()).toBeVisible({ timeout: 15_000 })

  await show.click(addMember)
  const linkTab = page.getByRole("tab", { name: "Invite link" })
  await show.click(linkTab)
  await show.point(page.getByText("Link expires"))
  await t.say("link")
  const create = page.getByRole("button", { name: /^Create invite link/ })
  await show.click(create)
  await page.waitForTimeout(1500)
  await t.say("cap")
}, { setup: startOn("/project/demo-john/settings/members", (page) => page.getByRole("button", { name: "Add a member" }).waitFor()) })
