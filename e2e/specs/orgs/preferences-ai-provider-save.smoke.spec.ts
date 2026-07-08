import { test, expect } from "../../helpers/multi-user"

/**
 * PersonalProviderSection — "Save override" validates endpoint on submit.
 *
 * Submit stays enabled; clicking with an empty endpoint shows a validation error.
 */
test("preferences AI provider Save override validates empty endpoint on click", async ({
  alice,
}) => {
  await alice.goto("/preferences")
  await alice.waitForLoadState("networkidle")

  const toggleBtn = alice.locator("button[aria-expanded]").filter({ hasText: /AI provider/i })
  await expect(toggleBtn).toBeVisible({ timeout: 10_000 })
  if ((await toggleBtn.getAttribute("aria-expanded")) !== "true") {
    await toggleBtn.click()
  }
  await expect(toggleBtn).toHaveAttribute("aria-expanded", "true", { timeout: 3_000 })

  const endpointInput = alice.locator("#prov-endpoint")
  await expect(endpointInput).toBeVisible({ timeout: 3_000 })

  const saveBtn = alice.getByRole("button", { name: /Save override|Update override/i })
  await expect(saveBtn).toBeEnabled({ timeout: 2_000 })

  await saveBtn.click()
  await expect(alice.getByText(/endpoint url is required/i)).toBeVisible({ timeout: 2_000 })

  await endpointInput.fill("https://openrouter.ai/api/v1")
  await saveBtn.click()
  await expect(alice.getByTestId("provider-override-saved")).toBeVisible({ timeout: 3_000 })

  await endpointInput.clear()
  await saveBtn.click()
  await expect(alice.getByText(/endpoint url is required/i)).toBeVisible({ timeout: 2_000 })
})
