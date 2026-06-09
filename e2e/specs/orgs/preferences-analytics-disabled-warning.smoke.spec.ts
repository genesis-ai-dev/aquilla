import { test, expect } from "../../helpers/multi-user"

/**
 * Preferences page — analytics disabled warning message.
 *
 * Preferences.tsx renders a warning when analytics is disabled:
 *   "With analytics disabled, we may not be able to help diagnose
 *    problems you encounter."
 *
 * The warning only appears when enabled=false. When enabled=true it is hidden.
 *
 * This spec: navigate to /preferences → if analytics is currently enabled,
 * toggle off → verify warning text appears → toggle back on → verify
 * warning text disappears.
 */
test("preferences analytics disabled warning appears when switch is off", async ({ alice }) => {
  await alice.goto("/preferences")
  await alice.waitForLoadState("networkidle")

  const toggle = alice.locator("#analytics-consent")
  await expect(toggle).toBeVisible({ timeout: 10_000 })

  const warningText = alice.getByText(/With analytics disabled.*diagnose/i)

  // Read the current checked state.
  const isChecked = await toggle.evaluate((el) => {
    return el.getAttribute("aria-checked") === "true" ||
      (el as HTMLInputElement).checked
  })

  if (isChecked) {
    // Analytics is currently ON — warning should not be visible.
    await expect(warningText).not.toBeVisible()

    // Turn it OFF → warning appears.
    await toggle.click()
    await expect(warningText).toBeVisible({ timeout: 3_000 })

    // Turn it back ON → warning disappears.
    await toggle.click()
    await expect(warningText).not.toBeVisible({ timeout: 3_000 })
  } else {
    // Analytics is currently OFF → warning should be visible.
    await expect(warningText).toBeVisible({ timeout: 3_000 })

    // Turn it ON → warning disappears.
    await toggle.click()
    await expect(warningText).not.toBeVisible({ timeout: 3_000 })

    // Turn it back OFF → warning reappears.
    await toggle.click()
    await expect(warningText).toBeVisible({ timeout: 3_000 })
  }
})
