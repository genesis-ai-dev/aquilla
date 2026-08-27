/**
 * AQU-988 — select-or-type language fields, proven in a real browser.
 *
 * This spec exists because unit tests are NOT sufficient here. A previous
 * Combobox-based version of the target-language chips field passed under
 * happy-dom and still cleared free-typed text on Enter in Chromium, so chips
 * never stuck. The custom-entry path below is the regression guard for that.
 *
 * Note the typing API: `pressSequentially()`, not `fill()`. The suggestion
 * list only opens for real keystrokes (see `LanguageComboboxInput.tsx`), which
 * is exactly why `fill()` in the other specs' page objects can't raise a
 * popup over the controls they click next.
 *
 * Flow:
 *   1. Create dialog → type "fre" in Source language, pick "French" from the
 *      dropdown; the field stores the display name, not the code.
 *   2. Target language(s) chips → type a custom label that is in no catalog
 *      ("Grade 7 English") and press Enter; the chip sticks verbatim.
 *   3. In the SAME session, type "swah" and pick "Swahili" from the dropdown;
 *      that chip sticks too, alongside the custom one.
 *   4. Create, then reopen Settings → the saved values are exactly what was
 *      committed ("French" / "Grade 7 English").
 */

import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"

const CUSTOM_LANGUAGE = "Grade 7 English"

test("language fields suggest from the catalog and still accept custom text", async ({
  alice,
}) => {
  test.setTimeout(120_000)

  const dash = new Dashboard(alice)
  await dash.goto()

  const name = `LangPicker ${Date.now()}`
  const dialog = await dash.openCreateProjectDialog()
  await dialog.getByLabel(/^Project title$/i).fill(name)

  // 1. Source language — typing surfaces the dropdown; picking stores the name.
  const source = dialog.getByLabel(/^Source language$/i)
  await source.click()
  await source.pressSequentially("fre", { delay: 30 })

  const sourceOption = alice.getByRole("option", { name: /^French/ })
  await expect(sourceOption).toBeVisible({ timeout: 5_000 })
  await sourceOption.click()
  // The display name, never the "fr" code.
  await expect(source).toHaveValue("French")

  // 2. Custom entry must survive Enter — the historical regression.
  const target = dialog.getByTestId("create-extra-lang-input")
  await target.click()
  await target.pressSequentially(CUSTOM_LANGUAGE, { delay: 30 })
  await target.press("Enter")

  const customChip = dialog.getByTestId(`create-extra-lang-chip-${CUSTOM_LANGUAGE}`)
  await expect(customChip).toBeVisible({ timeout: 5_000 })
  await expect(customChip).toContainText(CUSTOM_LANGUAGE)
  // The draft is consumed, not left behind.
  await expect(target).toHaveValue("")

  // 3. A dropdown pick and a custom label coexist in one session.
  await target.pressSequentially("swah", { delay: 30 })
  const swahili = alice.getByRole("option", { name: /^Swahili/ })
  await expect(swahili).toBeVisible({ timeout: 5_000 })
  await swahili.click()

  await expect(dialog.getByTestId("create-extra-lang-chip-Swahili")).toBeVisible({
    timeout: 5_000,
  })
  // Both still there — neither commit clobbered the other.
  await expect(customChip).toBeVisible()

  await dialog.getByRole("button", { name: /^Create Project$/i }).click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  // 4. What was committed is what got saved.
  await dash.openProject(name)
  const settings = new ProjectSettings(alice)
  await settings.openSettings()

  await expect(alice.locator("#sl")).toHaveValue("French", { timeout: 10_000 })
  // The first chip becomes the project's default target language.
  await expect(alice.locator("#tl")).toHaveValue(CUSTOM_LANGUAGE, { timeout: 10_000 })
})
