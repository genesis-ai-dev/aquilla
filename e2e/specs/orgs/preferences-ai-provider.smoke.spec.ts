import { test, expect } from "../../helpers/multi-user"

/**
 * Preferences page — AI provider (advanced) collapsible section.
 *
 * PersonalProviderSection is collapsed by default (aria-expanded="false").
 * Clicking the toggle button expands it to reveal:
 *   - h2 "AI provider (advanced)"
 *   - #prov-endpoint input (Endpoint URL)
 *   - #prov-key input (API key)
 *   - Save and Clear buttons
 *
 * This spec verifies expand/collapse works and the fields appear.
 */
test("preferences AI provider section expands to show endpoint and key inputs", async ({ alice }) => {
  await alice.goto("/preferences")
  await alice.waitForLoadState("networkidle")

  // The toggle button is collapsed by default.
  const toggleBtn = alice.locator("button[aria-expanded]").filter({ hasText: /AI provider/i })
  await expect(toggleBtn).toBeVisible({ timeout: 10_000 })
  await expect(toggleBtn).toHaveAttribute("aria-expanded", "false")

  // Clicking expands the section.
  await toggleBtn.click()
  await expect(toggleBtn).toHaveAttribute("aria-expanded", "true", { timeout: 3_000 })

  // Endpoint and key inputs are visible.
  await expect(alice.locator("#prov-endpoint")).toBeVisible({ timeout: 3_000 })
  await expect(alice.locator("#prov-key")).toBeVisible({ timeout: 3_000 })

  // Clicking again collapses.
  await toggleBtn.click()
  await expect(toggleBtn).toHaveAttribute("aria-expanded", "false", { timeout: 3_000 })
  await expect(alice.locator("#prov-endpoint")).not.toBeVisible({ timeout: 2_000 })
})
