import { expect } from "@playwright/test"
import { HELP_SITE, serveHelpSite } from "../../tutorials/help-site"
import { tutorial } from "../../tutorials/tutorial"

const QUESTION = "How do I invite my team?"

tutorial("find-help", async (t) => {
  const { page, show } = t
  await serveHelpSite(page.context())
  const appUrl = page.url()
  const helpMenu = page.getByRole("button", { name: "Help & community" }).filter({ visible: true }).first()

  await t.say("intro")

  await show.click(helpMenu)
  const helpItem = page.getByRole("menuitem", { name: "Help", exact: true })
  await expect(helpItem).toBeVisible()
  await show.point(helpItem)
  await t.say("menu")

  // The Help link opens a new tab. A take films one tab, so this tab goes to
  // the address the new one opened, which looks the same on screen.
  const newTab = page.context().waitForEvent("page")
  await show.click(helpItem)
  const tab = await newTab
  await tab.waitForURL((url) => url.href.startsWith(HELP_SITE))
  const opened = tab.url()
  await tab.close()
  await page.goto(opened)
  await expect(page.getByRole("heading", { name: "How can we help?" })).toBeVisible()
  await t.say("opens")

  // Typed and not sent: the answer comes from an AI service the film does not
  // call, and the line says what it does without showing one.
  const ask = page.getByRole("textbox", { name: "Ask about Aquilla" })
  await show.click(ask)
  const typing = ask.pressSequentially(QUESTION, { delay: 45 })
  await t.say("ask")
  await typing
  await expect(ask).toHaveValue(QUESTION)

  await show.click(page.getByRole("link", { name: "Browse the guides" }))
  // The sidebar's <nav> wraps it without a box of its own; its links are what shows.
  const guide = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Your first project" })
  await expect(guide).toBeVisible()
  await show.point(guide)
  await t.say("browse")

  const search = page.getByRole("button", { name: "Search" })
  await show.click(search)
  const results = page.getByRole("dialog")
  const searching = page.keyboard.type("export", { delay: 90 })
  await t.say("search")
  await searching
  await expect(results.getByText(/results for export/)).toBeVisible({ timeout: 10_000 })
  await expect(results.getByText("Exporting your work").first()).toBeVisible()
  await page.keyboard.press("Escape")

  await page.goto(appUrl)
  await page.locator('[data-showcase="editor.source"]').first().waitFor({ state: "visible", timeout: 30_000 })
  await show.point(helpMenu)
  await t.say("outro")
})
