import { test, expect } from "../../helpers/multi-user"

/**
 * PersonalProviderSection — "Save override" button enables when endpoint is filled.
 *
 * PersonalProviderSection.tsx has:
 *   - Input id="prov-endpoint" (placeholder "https://openrouter.ai/api/v1")
 *   - Button "Save override" (disabled when endpoint is empty)
 *
 * When the endpoint input is non-empty, canSave = true and the button is enabled.
 * Clearing the input disables the button again.
 *
 * This spec: navigate to /preferences → expand the provider section →
 * fill the endpoint input → verify "Save override" is enabled →
 * clear the input → verify button is disabled.
 */
test("preferences AI provider Save override button enables when endpoint is filled", async ({
  alice,
}) => {
  await alice.goto("/preferences")
  await alice.waitForLoadState("networkidle")

  // Expand the personal provider section.
  const toggleBtn = alice.locator("button[aria-expanded]").filter({ hasText: /AI provider/i })
  await expect(toggleBtn).toBeVisible({ timeout: 10_000 })
  if ((await toggleBtn.getAttribute("aria-expanded")) !== "true") {
    await toggleBtn.click()
  }
  await expect(toggleBtn).toHaveAttribute("aria-expanded", "true", { timeout: 3_000 })

  // The endpoint input is visible.
  const endpointInput = alice.locator("#prov-endpoint")
  await expect(endpointInput).toBeVisible({ timeout: 3_000 })

  // Save override button starts disabled (endpoint is empty).
  const saveBtn = alice.getByRole("button", { name: /Save override|Update override/i })
  await expect(saveBtn).toBeDisabled({ timeout: 2_000 })

  // Fill the endpoint.
  await endpointInput.fill("https://openrouter.ai/api/v1")

  // Save override button is now enabled.
  await expect(saveBtn).toBeEnabled({ timeout: 2_000 })

  // Clear the endpoint — button disabled again.
  await endpointInput.clear()
  await expect(saveBtn).toBeDisabled({ timeout: 2_000 })
})
