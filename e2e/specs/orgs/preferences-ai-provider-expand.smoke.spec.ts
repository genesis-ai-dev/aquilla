import { test, expect } from "../../helpers/multi-user"

/**
 * Preferences — "AI provider (advanced)" collapsible section.
 *
 * PersonalProviderSection.tsx on /preferences/provider-keys renders a disclosure
 * button with heading "AI provider (advanced)". Clicking it
 * expands to show an "Endpoint URL" input and an "API key" field.
 *
 * This spec: navigate to /preferences → verify the section heading →
 * click the expand button → verify the Endpoint URL input appears →
 * click again → collapses (input disappears).
 */
test("preferences AI provider section expands and collapses", async ({ alice }) => {
  await alice.goto("/preferences/provider-keys")
  // Find the AI provider disclosure button.
  const expandBtn = alice.getByRole("button", { name: /AI provider \(advanced\)/i })
  await expect(expandBtn).toBeVisible({ timeout: 10_000 })
  const endpointInput = alice.locator("#prov-endpoint")
  await expect(endpointInput).not.toBeVisible()

  // Click to expand.
  await expandBtn.click()

  // The Endpoint URL input appears.
  await expect(endpointInput).toBeVisible({ timeout: 3_000 })

  // Click again to collapse.
  await expandBtn.click()
  await expect(endpointInput).not.toBeVisible({ timeout: 2_000 })
})
