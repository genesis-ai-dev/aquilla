import { test, expect } from "../../helpers/multi-user"

/**
 * Preferences page — analytics consent toggle.
 *
 * Preferences.tsx has a Switch (id="analytics-consent") for the
 * "Share anonymous usage data" setting. Toggling it changes the stored
 * analytics consent preference.
 *
 * This spec: reads the initial state → toggles the switch → verifies
 * aria-checked changes → toggles back to restore the original state.
 */
test("preferences analytics consent switch toggles on and off", async ({ alice }) => {
  await alice.goto("/preferences")
  await alice.waitForLoadState("networkidle")

  // Find the analytics consent switch.
  const toggle = alice.locator("#analytics-consent")
  await expect(toggle).toBeVisible({ timeout: 10_000 })

  // Read the current checked state.
  const initialChecked = await toggle.evaluate((el) => {
    // Switch renders as a button with aria-checked, or a checkbox.
    return el.getAttribute("aria-checked") === "true" ||
      (el as HTMLInputElement).checked
  })

  // Toggle it.
  await toggle.click()
  await alice.waitForTimeout(300)

  // aria-checked (or checked) should have flipped.
  const flippedChecked = await toggle.evaluate((el) => {
    return el.getAttribute("aria-checked") === "true" ||
      (el as HTMLInputElement).checked
  })
  expect(flippedChecked).toBe(!initialChecked)

  // Restore original state.
  await toggle.click()
  await alice.waitForTimeout(300)
  const restoredChecked = await toggle.evaluate((el) => {
    return el.getAttribute("aria-checked") === "true" ||
      (el as HTMLInputElement).checked
  })
  expect(restoredChecked).toBe(initialChecked)
})
