import { test, expect } from "../../helpers/multi-user"

/**
 * Org settings — rename organization.
 *
 * Settings.tsx (/settings) renders an "Organization name" input (#org-name)
 * and a "Save" button. Clearing and re-typing the org name, then clicking
 * "Save", persists the new name.
 *
 * This spec: navigate to /settings → clear and update org name → click Save
 * → verify the new name persists (page still shows it after save).
 *
 * NOTE: The test restores the original name at the end to avoid side-effects
 * on other tests that rely on the default org name "Acme".
 */
test("org settings rename and save updates org name", async ({ alice }) => {
  await alice.goto("/settings")
  await alice.waitForLoadState("networkidle")

  const nameInput = alice.locator("#org-name")
  await expect(nameInput).toBeVisible({ timeout: 10_000 })

  // Read current name for restoration.
  const originalName = await nameInput.inputValue()

  const newName = `RenamedOrg ${Date.now()}`
  await nameInput.fill(newName)

  const saveBtn = alice.getByRole("button", { name: /^Save$/i })
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
  await saveBtn.click()

  // After save the input should still reflect the new name (no reset to original).
  await expect(nameInput).toHaveValue(newName, { timeout: 5_000 })

  // Restore original name to avoid polluting other tests.
  await nameInput.fill(originalName)
  await saveBtn.click()
  await expect(nameInput).toHaveValue(originalName, { timeout: 5_000 })
})
