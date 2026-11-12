/**
 * AQU-988 — select-or-type language fields, proven in a real browser.
 *
 * This spec exists because unit tests are NOT sufficient here. A previous
 * Combobox-based version of the target-language field passed under happy-dom
 * and still cleared free-typed text on Enter in Chromium. The custom-entry
 * path below is the regression guard for that.
 *
 * Note the typing API: `pressSequentially()`, not `fill()`. The suggestion
 * list only opens for real keystrokes (see `LanguageComboboxInput.tsx`), which
 * is exactly why `fill()` in the other specs' page objects can't raise a
 * popup over the controls they click next.
 *
 * Suggestion rows are picked by `language-option-<ISO 639-3 id>`, never by a
 * name prefix. Since AQU-1456 the pickers search the full SIL catalog, where
 * "fre" also offers "French Sign Language" (fsl), "Ger" also offers "German
 * Sign Language" (gsg) and "swah" offers two Swahili entries, so a /^French/
 * style name match is ambiguous (a Playwright strict-mode violation).
 *
 * The target languages are one box per lane plus an "Add language" button
 * (`create-add-target-lang`): box 0 is `create-extra-lang-input`, box N is
 * `create-target-lang-input-N`. There are no chips any more, so nothing
 * commits on Enter; a box's value is what gets created.
 *
 * Flow:
 *   1. Source language → type "fre", pick French (fra); the field stores the
 *      display name, not the code.
 *   2. Box 0 → type a custom label that is in no catalog ("Grade 7 English").
 *      No suggestion is offered, so nothing is highlighted to take Enter.
 *   3. AQU-1116 — box 1 → type "Ger" and press Enter; the pre-highlighted
 *      top match "German" is committed, not the typed "Ger", and the dialog
 *      stays open because the row claimed Enter.
 *   4. Box 2 → type "swah" and click Swahili (swa) in the dropdown; the
 *      custom label and German are still in their boxes.
 *   5. Back in box 0, press Enter. With no match highlighted, Enter falls
 *      through to the form and submits it. That is the AQU-988 regression
 *      guard: the same key that took "German" in step 3 leaves free text
 *      alone, and step 6 proves "Grade 7 English" was saved verbatim.
 *   6. Settings → the saved source and target lanes are exactly what was
 *      committed, in box order.
 */

import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"

const CUSTOM_LANGUAGE = "Grade 7 English"
/** SIL's name for `swa`, the macrolanguage that carries ISO 639-1 "sw" —
 * the entry the bundled pre-AQU-1456 catalog called plain "Swahili". */
const SWAHILI = "Swahili (macrolanguage)"

test("language fields suggest from the catalog and still accept custom text", async ({
  alice,
}) => {
  test.setTimeout(120_000)

  const dash = new Dashboard(alice)
  await dash.goto()

  const name = `LangPicker ${Date.now()}`
  const dialog = await dash.openCreateProjectDialog()
  await dialog.getByLabel(/^Project name$/i).fill(name)

  // 1. Source language — typing surfaces the dropdown; picking stores the name.
  const source = dialog.getByLabel(/^Source language$/i)
  await source.click()
  await source.pressSequentially("fre", { delay: 30 })

  const sourceOption = alice.getByTestId("language-option-fra")
  await expect(sourceOption).toBeVisible({ timeout: 5_000 })
  await sourceOption.click()
  // The display name, never the "fra" / "fr" code.
  await expect(source).toHaveValue("French")

  // 2. Custom text matches nothing, so no list opens over it.
  const first = dialog.getByTestId("create-extra-lang-input")
  await first.click()
  await first.pressSequentially(CUSTOM_LANGUAGE, { delay: 30 })
  await expect(alice.getByRole("listbox")).toHaveCount(0)
  await expect(first).toHaveValue(CUSTOM_LANGUAGE)

  const addLanguage = dialog.getByTestId("create-add-target-lang")

  // 3. AQU-1116 — type-then-Enter takes the pre-highlighted top match.
  await addLanguage.click()
  const second = dialog.getByTestId("create-target-lang-input-1")
  await second.click()
  await second.pressSequentially("Ger", { delay: 30 })
  const german = alice.getByTestId("language-option-deu")
  await expect(german).toBeVisible({ timeout: 5_000 })
  await expect(german).toHaveAttribute("aria-selected", "true")
  await second.press("Enter")

  // Enter committed the match, not the "Ger" that was typed, and the row
  // claimed the key, so the form did not submit.
  await expect(second).toHaveValue("German")
  await expect(dialog).toBeVisible()

  // 4. A dropdown pick and a custom label coexist in one session.
  await addLanguage.click()
  const third = dialog.getByTestId("create-target-lang-input-2")
  await third.click()
  await third.pressSequentially("swah", { delay: 30 })
  const swahili = alice.getByTestId("language-option-swa")
  await expect(swahili).toBeVisible({ timeout: 5_000 })
  await swahili.click()

  await expect(third).toHaveValue(SWAHILI)
  // Neither pick clobbered another box.
  await expect(first).toHaveValue(CUSTOM_LANGUAGE)
  await expect(second).toHaveValue("German")

  // 5. Enter on free text falls through to the form, which creates the project.
  await first.click()
  await first.press("Enter")
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  // 6. What was committed is what got saved. A create lands on the project
  //    Overview; wait for it before `openProject`, whose "Open project" check
  //    does not wait and otherwise looks for a project link that isn't there.
  await expect(alice).toHaveURL(/\/projects\/[^/?#]+(?:[?#].*)?$/, { timeout: 15_000 })
  await expect(dash.projectOverviewHeading(name)).toBeVisible({ timeout: 15_000 })
  await dash.openProject(name)
  const settings = new ProjectSettings(alice)
  await settings.openSettings()

  // AQU-1594: a source lane and one target lane per box, in box order.
  await expect(alice.getByTestId("source-language-line")).toContainText("French", {
    timeout: 10_000,
  })
  const targetLanguages = alice
    .getByTestId("target-lanes-list")
    .locator("[data-testid^='lane-language-cell-']")
  await expect(targetLanguages).toHaveText([CUSTOM_LANGUAGE, "German", SWAHILI], {
    timeout: 10_000,
  })
})
