import { test, expect } from "../../helpers/multi-user"

/**
 * Preferences — settings persist across page reload.
 *
 * JOURNEYS.md gap: "Settings: Settings persist across reload".
 *
 * Preferences are stored locally. Toggling the analytics-consent switch
 * then reloading the page should show the new state, not the previous one.
 *
 * The consent control is a Base UI Switch (<span role="switch">, named by
 * the "Share usage data" label); the #analytics-consent id lands on the
 * hidden input, so specs must target role=switch.
 *
 * Workflow:
 *   1. Navigate to /preferences and read the initial analytics-consent state.
 *   2. Toggle the switch.
 *   3. Reload the page.
 *   4. Verify the switch retains the toggled state.
 *   5. Restore original state so the test leaves no side-effects.
 */
test("preferences analytics consent setting persists across page reload", async ({ alice }) => {
  await alice.goto("/preferences/privacy")
  await alice.waitForLoadState("networkidle")

  const toggle = alice.getByRole("switch", { name: "Share usage data" })
  await expect(toggle).toBeVisible({ timeout: 10_000 })

  // Read the current checked state.
  const initialChecked = (await toggle.getAttribute("aria-checked")) === "true"

  // Toggle it.
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", String(!initialChecked), {
    timeout: 3_000,
  })

  // Reload the page.
  await alice.reload()
  await alice.waitForLoadState("networkidle")

  // Re-locate the toggle after reload — should still be in the toggled state.
  const toggleAfterReload = alice.getByRole("switch", { name: "Share usage data" })
  await expect(toggleAfterReload).toBeVisible({ timeout: 10_000 })
  await expect(toggleAfterReload).toHaveAttribute(
    "aria-checked",
    String(!initialChecked),
    { timeout: 3_000 },
  )

  // Restore original state.
  await toggleAfterReload.click()
  await expect(toggleAfterReload).toHaveAttribute(
    "aria-checked",
    String(initialChecked),
    { timeout: 3_000 },
  )
})
