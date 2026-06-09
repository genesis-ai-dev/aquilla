import { test, expect } from "../../helpers/multi-user"

/**
 * Preferences — settings persist across page reload.
 *
 * JOURNEYS.md gap: "Settings: Settings persist across reload".
 *
 * Preferences are stored locally (IDB). Toggling the analytics-consent
 * switch then reloading the page should show the new state, not the
 * previous one.
 *
 * Workflow:
 *   1. Navigate to /preferences and read the initial analytics-consent state.
 *   2. Toggle the switch.
 *   3. Reload the page.
 *   4. Verify the switch retains the toggled state.
 *   5. Restore original state so the test leaves no side-effects.
 */
test("preferences analytics consent setting persists across page reload", async ({ alice }) => {
  await alice.goto("/preferences")
  await alice.waitForLoadState("networkidle")

  const toggle = alice.locator("#analytics-consent")
  await expect(toggle).toBeVisible({ timeout: 10_000 })

  // Read the current checked state.
  const getChecked = async () =>
    toggle.evaluate((el) => {
      return el.getAttribute("aria-checked") === "true" ||
        (el as HTMLInputElement).checked
    })

  const initialChecked = await getChecked()

  // Toggle it.
  await toggle.click()
  await alice.waitForTimeout(300)
  const afterToggle = await getChecked()
  expect(afterToggle).toBe(!initialChecked)

  // Reload the page.
  await alice.reload()
  await alice.waitForLoadState("networkidle")

  // Re-locate the toggle after reload.
  const toggleAfterReload = alice.locator("#analytics-consent")
  await expect(toggleAfterReload).toBeVisible({ timeout: 10_000 })

  const afterReload = await toggleAfterReload.evaluate((el) => {
    return el.getAttribute("aria-checked") === "true" ||
      (el as HTMLInputElement).checked
  })

  // Should still be in the toggled state.
  expect(afterReload).toBe(!initialChecked)

  // Restore original state.
  await toggleAfterReload.click()
  await alice.waitForTimeout(300)
})
