import { expect, type Page } from "@playwright/test"
import { DEMO_ORG, startOn } from "../../tutorials/setup"
import { tutorial } from "../../tutorials/tutorial"

/** Take the language list's own match when it offers one; otherwise keep what was typed. */
async function pickSuggestion(page: Page, language: string): Promise<void> {
  const option = page.getByRole("option", { name: new RegExp(`^${language}`) }).first()
  if (await option.waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false)) await option.click()
  else await page.keyboard.press("Tab")
}

tutorial("create-a-project", async (t) => {
  const { page, show } = t
  await t.say("intro")

  const newProject = page.getByRole("button", { name: /New project/ }).first()
  await show.point(newProject)
  await t.say("open")
  await show.click(newProject)

  const scratch = page.getByRole("button", { name: /^Start from scratch/ })
  await show.point(scratch)
  await t.say("start")
  await show.click(scratch)

  const name = page.getByRole("textbox", { name: "Project name" })
  await show.click(name)
  const typing = name.pressSequentially("Mark — Plainspeak Draft", { delay: 45 })
  await t.say("name")
  await typing

  const source = page.getByRole("combobox", { name: "Source language" })
  await show.click(source)
  const sourceTyping = source.pressSequentially("English", { delay: 60 })
  const saying = t.say("languages")
  await sourceTyping
  await pickSuggestion(page, "English")
  const lane = page.getByRole("combobox", { name: "Language lanes" })
  await show.click(lane)
  await lane.pressSequentially("Spanish", { delay: 60 })
  await pickSuggestion(page, "Spanish")
  await saying

  const delivers = page.getByRole("dialog").getByRole("combobox", { name: /^What .* delivers$/ }).last()
  await show.click(delivers)
  await t.say("delivers")
  await show.click(page.getByRole("option", { name: "Text and audio" }))

  const create = page.getByRole("button", { name: "Create project" })
  await expect(create).toBeEnabled()
  await show.click(create)
  await expect(page.getByText(/Mark — Plainspeak Draft/).first()).toBeVisible({ timeout: 20_000 })
  await t.say("create")
}, { setup: startOn(`${DEMO_ORG}/projects`, (page) => page.getByRole("button", { name: /New project/ }).first().waitFor()) })
