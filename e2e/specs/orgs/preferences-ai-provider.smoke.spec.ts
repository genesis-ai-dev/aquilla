import { test, expect } from "../../helpers/multi-user"

/**
 * Preferences page — AI provider (advanced) collapsible section.
 *
 * PersonalProviderSection is collapsed by default. Clicking the disclosure
 * button expands it to reveal:
 *   - h2 "AI provider (advanced)"
 *   - #prov-endpoint input (Endpoint URL)
 *   - #prov-key input (API key)
 *   - Save and Clear buttons
 *
 * This spec verifies expand/collapse works and the fields appear.
 */
test("preferences AI provider section expands to show endpoint and key inputs", async ({ alice }) => {
  await alice.goto("/preferences/provider-keys")
  // The provider disclosure is collapsed by default.
  const toggleBtn = alice.getByRole("button", { name: /AI provider \(advanced\)/i })
  await expect(toggleBtn).toBeVisible({ timeout: 10_000 })
  await expect(alice.locator("#prov-endpoint")).not.toBeVisible()

  // Clicking expands the section.
  await toggleBtn.click()

  // Endpoint and key inputs are visible.
  await expect(alice.locator("#prov-endpoint")).toBeVisible({ timeout: 3_000 })
  await expect(alice.locator("#prov-key")).toBeVisible({ timeout: 3_000 })

  // Clicking again collapses.
  await toggleBtn.click()
  await expect(alice.locator("#prov-endpoint")).not.toBeVisible({ timeout: 2_000 })
})
