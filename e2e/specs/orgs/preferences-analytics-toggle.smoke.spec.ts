import { test, expect } from "../../helpers/multi-user"

/**
 * Preferences page — analytics consent toggle.
 *
 * Preferences.tsx renders a Base UI Switch for the "Share usage data"
 * setting. The shadcn/Base UI Switch renders a <span role="switch"
 * aria-checked> — the `id="analytics-consent"` prop lands on the
 * visually-hidden <input>, so specs must target role=switch (the labelled
 * span), never the #id.
 *
 * This spec: reads the initial state → toggles the switch → verifies
 * aria-checked changes → toggles back to restore the original state.
 */
test("preferences analytics consent switch toggles on and off", async ({ alice }) => {
  await alice.goto("/preferences/privacy")
  // Find the analytics consent switch by its accessible name (from the
  // associated "Share usage data" label).
  const toggle = alice.getByRole("switch", { name: "Share usage data" })
  await expect(toggle).toBeVisible({ timeout: 10_000 })

  // Read the current checked state.
  const initialChecked = (await toggle.getAttribute("aria-checked")) === "true"

  // Toggle it — aria-checked should flip.
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", String(!initialChecked), {
    timeout: 3_000,
  })

  // Restore original state.
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", String(initialChecked), {
    timeout: 3_000,
  })
})
