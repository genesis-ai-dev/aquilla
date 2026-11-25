import { expect } from "@playwright/test"
import { tutorial } from "../../tutorials/tutorial"

tutorial("add-a-rule", async (t) => {
  const { page, show } = t

  await t.say("intro")

  await show.click(page.getByText("Living Memory", { exact: true }).first())
  await show.click(page.getByText("Checks", { exact: true }).first())
  const add = page.getByRole("button", { name: "Add check" }).first()
  await show.point(add)
  await t.say("add")
  await show.click(add)
  await show.click(page.getByRole("dialog", { name: "Add a check" }).getByText("Write a check").first())

  // A team that says "Verbe" for the Word, not "Parole".
  const d = page.getByRole("dialog", { name: "Create translation rule" })
  await expect(d).toBeVisible()
  const name = d.getByLabel("Rule name")
  await show.click(name)
  const typing = name.pressSequentially("Say Verbe, not Parole", { delay: 35 })
  await t.say("write")
  await typing
  await show.click(d.getByRole("textbox", { name: "Pattern" }))
  await d.getByRole("textbox", { name: "Pattern" }).pressSequentially("Parole", { delay: 50 })
  await show.click(d.getByRole("button", { name: "Add autofix (optional)" }))
  await d.locator("#re-af-pattern").pressSequentially("Parole", { delay: 40 })
  await show.click(d.getByRole("textbox", { name: "Replace with" }))
  await d.getByRole("textbox", { name: "Replace with" }).pressSequentially("Verbe", { delay: 50 })
  await show.click(d.getByRole("button", { name: "Create rule" }))
  await expect(d).toBeHidden()

  // Back in the editor, the rule marks the word in verse 1.
  await show.click(page.getByText("John 1", { exact: true }).first())
  const marked = page.locator('[data-cell-type="target"]').getByRole("button", { name: "Parole" }).first()
  await expect(marked).toBeVisible({ timeout: 15_000 })
  await show.click(marked)
  const toastTitle = page.getByRole("button", { name: "Say Verbe, not Parole" }).last()
  await expect(toastTitle).toBeVisible()
  await t.closeUp(marked, async () => {
    await t.say("flag")
  }, 1.4)

  // The rule's own panel: every line that breaks it, and every line that keeps it.
  await show.click(toastTitle)
  await expect(page.getByText(/^Breaking this rule/)).toBeVisible()
  await show.point(page.getByText(/^Breaking this rule/))
  await t.say("panel")

  const fixAll = page.getByRole("button", { name: "Try to fix all" })
  await expect(fixAll).toBeEnabled()
  await show.click(fixAll)
  // The saved fix is previewed, line by line. Nothing is applied here.
  await expect(page.getByText(/^1 preview ready/)).toBeVisible({ timeout: 15_000 })
  const apply = page.getByRole("button", { name: /^Apply 1 selected/ })
  await show.point(page.getByText(/^1 preview ready/))
  await t.say("fix")
  await show.point(apply)
  await expect(apply).toBeVisible()
})
