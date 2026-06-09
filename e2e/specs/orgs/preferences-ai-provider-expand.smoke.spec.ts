import { test, expect } from "../../helpers/multi-user"

/**
 * Preferences — "AI provider (advanced)" collapsible section.
 *
 * PersonalProviderSection.tsx on /preferences renders an expand button
 * (aria-expanded) with heading "AI provider (advanced)". Clicking it
 * expands to show an "Endpoint URL" input and an "API key" field.
 *
 * This spec: navigate to /preferences → verify the section heading →
 * click the expand button → verify the Endpoint URL input appears →
 * click again → collapses (input disappears).
 */
test("preferences AI provider section expands and collapses", async ({ alice }) => {
  await alice.goto("/preferences")
  await alice.waitForLoadState("networkidle")

  // Find the AI provider expand button (aria-expanded).
  const expandBtn = alice.locator('button[aria-expanded]').filter({ hasText: /AI provider/i })
  await expect(expandBtn).toBeVisible({ timeout: 10_000 })
  await expect(expandBtn).toHaveAttribute("aria-expanded", "false")

  // Click to expand.
  await expandBtn.click()
  await expect(expandBtn).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 })

  // The Endpoint URL input appears.
  const endpointInput = alice.locator('#prov-endpoint')
  await expect(endpointInput).toBeVisible({ timeout: 3_000 })

  // Click again to collapse.
  await expandBtn.click()
  await expect(expandBtn).toHaveAttribute("aria-expanded", "false", { timeout: 2_000 })
  await expect(endpointInput).not.toBeVisible({ timeout: 2_000 })
})
