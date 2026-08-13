import { test, expect } from "../../helpers/multi-user"

/**
 * PersonalProviderSection — "Save override" validates endpoint on submit.
 *
 * Submit stays enabled; clicking with an empty endpoint shows a validation error.
 * Successful saves are silent (no Saved ack) — success is the Active state / button label.
 */
test("preferences AI provider Save override validates empty endpoint on click", async ({
  alice,
}) => {
  await alice.goto("/preferences/provider-keys")
  const toggleBtn = alice.getByRole("button", { name: /AI provider \(advanced\)/i })
  await expect(toggleBtn).toBeVisible({ timeout: 10_000 })
  const endpointInput = alice.locator("#prov-endpoint")
  if (!(await endpointInput.isVisible())) {
    await toggleBtn.click()
  }
  await expect(endpointInput).toBeVisible({ timeout: 3_000 })

  const saveBtn = alice.getByRole("button", { name: /Save override|Update override/i })
  await expect(saveBtn).toBeEnabled({ timeout: 2_000 })

  await saveBtn.click()
  await expect(alice.getByText(/endpoint url is required/i)).toBeVisible({ timeout: 2_000 })

  await endpointInput.fill("https://openrouter.ai/api/v1")
  await saveBtn.click()
  await expect(alice.getByText(/Active — your projects use this endpoint/i)).toBeVisible({
    timeout: 3_000,
  })
  await expect(alice.getByRole("button", { name: /Update override/i })).toBeVisible({
    timeout: 3_000,
  })
  await expect(alice.getByText(/^Saved$/i)).toHaveCount(0)

  await endpointInput.clear()
  await saveBtn.click()
  await expect(alice.getByText(/endpoint url is required/i)).toBeVisible({ timeout: 2_000 })
})
