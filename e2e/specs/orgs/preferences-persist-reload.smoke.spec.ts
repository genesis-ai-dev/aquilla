import { test, expect } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"

/**
 * Preferences — settings persist across page reload.
 *
 * JOURNEYS.md: "Orgs: Preferences persist across reload".
 *
 * Preferences are stored locally (device-scoped, like theme). Changing a
 * control then reloading must show the new state, not the previous one.
 *
 * The consent control is a Base UI Switch (<span role="switch">, named by
 * the "Share usage data" label); the #analytics-consent id lands on the
 * hidden input, so specs must target role=switch.
 *
 * App font size (AQU-1169) is the same persist contract plus a boot-script
 * invariant: Extra Large must already be on <html> after reload, before the
 * Preferences UI hydrates — otherwise the default size flashes.
 */

test("preferences analytics consent setting persists across page reload", async ({ alice }) => {
  await alice.goto("/preferences")
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

test("preferences app font size persists across reload without flashing Default", async ({ alice }) => {
  await alice.goto("/preferences")
  const trigger = alice.getByRole("combobox", { name: "App font size" })
  await expect(trigger).toBeVisible({ timeout: 10_000 })
  await expectSelectValue(trigger, "Default")

  await pickSelectOption(alice, trigger, "Extra Large")
  await expectSelectValue(trigger, "Extra Large")
  expect(await alice.evaluate(() => document.documentElement.style.fontSize)).toBe("20px")

  await alice.reload()
  // Inline boot script must have applied before React — do not wait on the
  // combobox first or a flash of Default would still pass.
  expect(await alice.evaluate(() => document.documentElement.style.fontSize)).toBe("20px")

  const triggerAfterReload = alice.getByRole("combobox", { name: "App font size" })
  await expect(triggerAfterReload).toBeVisible({ timeout: 10_000 })
  await expectSelectValue(triggerAfterReload, "Extra Large")

  await pickSelectOption(alice, triggerAfterReload, "Default")
  await expectSelectValue(triggerAfterReload, "Default")
  expect(await alice.evaluate(() => document.documentElement.style.fontSize)).toBe("")
})
