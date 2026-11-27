import { expect } from "@playwright/test"
import { tutorial } from "../../tutorials/tutorial"

tutorial("preferences", async (t) => {
  const { page, show } = t
  await t.say("intro")

  const account = page.getByRole("button", { name: /^Account menu:/ })
  await show.click(account)
  const prefs = page.getByRole("menuitem", { name: "Preferences" })
  await show.point(prefs)
  await t.say("open")
  await show.click(prefs)
  await expect(page.getByRole("heading", { name: "Preferences" }).first()).toBeVisible()
  await show.point(page.getByText("Personal preferences that apply to you across all projects."))
  await t.say("scope")

  await show.click(page.getByRole("combobox", { name: "Theme" }))
  const saying = t.say("look")
  await show.click(page.getByRole("option", { name: "Dark", exact: true }))
  await show.click(page.getByRole("combobox", { name: "App font size" }))
  await show.click(page.getByRole("option", { name: "Large", exact: true }))
  await saying

  const ui = page.getByRole("combobox", { name: "UI language" })
  await show.point(ui)
  await t.say("language")

  const profile = page.getByRole("link", { name: /^Translator profile/ })
  await profile.scrollIntoViewIfNeeded()
  await show.click(profile)
  const experience = page.getByRole("textbox", { name: "Translation experience" })
  await expect(experience).toBeVisible()
  await show.click(experience)
  const typing = experience.pressSequentially("Five years on a Gospel team", { delay: 40 })
  await t.say("profile")
  await typing
  await t.say("outro")
})
