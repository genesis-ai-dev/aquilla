import { type Locator, type Page, expect } from "@playwright/test"

/**
 * Interaction helpers for shadcn/Base UI form controls (FRO shadcn migration).
 *
 * The migration replaced native <select> / <input type="checkbox"> with
 * Base UI primitives: selects render a combobox trigger + a portaled
 * listbox of role=option items; checkboxes render a span with
 * role=checkbox (the real <input> is visually hidden); enable/disable
 * toggles render role=switch. Specs must drive these via roles — native
 * `select`/`input[type=checkbox]` locators no longer match anything
 * visible.
 */

/** Open a Base UI Select trigger and click the option with the given
 *  accessible name. Waits for the popup to close so the selection has
 *  committed before the spec moves on. */
export async function pickSelectOption(
  page: Page,
  trigger: Locator,
  optionName: string | RegExp,
): Promise<void> {
  await trigger.click()
  const option = page.getByRole("option", { name: optionName })
  await expect(option).toBeVisible({ timeout: 3_000 })
  await option.click()
  await expect(page.getByRole("listbox")).toBeHidden({ timeout: 3_000 })
}

/** Assert the closed trigger of a Base UI Select shows the given label
 *  (replacement for `toHaveValue(...)` on native selects — the trigger
 *  renders the option LABEL, not the value). */
export async function expectSelectValue(
  trigger: Locator,
  label: string | RegExp,
): Promise<void> {
  await expect(trigger).toContainText(label, { timeout: 3_000 })
}
