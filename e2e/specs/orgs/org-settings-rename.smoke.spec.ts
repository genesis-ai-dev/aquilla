import { test, expect } from "../../helpers/multi-user"

/**
 * Org settings — rename organization.
 *
 * Settings.tsx (/settings) shows the org name as text in the Identity
 * section with a "Rename" button (owner/admin only). Clicking Rename
 * reveals the "Organization name" input (#org-name) with Save/Cancel;
 * a successful Save exits edit mode and renders the new name as text.
 *
 * This spec: navigate to /settings → Rename → fill new name → Save →
 * verify the new name renders → restore the original name the same way.
 *
 * NOTE: The test restores the original name at the end to avoid side-effects
 * on other tests that rely on the default org name "Acme".
 */
test("org settings rename and save updates org name", async ({ alice }) => {
  await alice.goto("/settings")
  await alice.waitForLoadState("networkidle")

  // Enter edit mode.
  const renameBtn = alice.getByRole("button", { name: /^Rename$/ })
  await expect(renameBtn).toBeVisible({ timeout: 10_000 })
  await renameBtn.click()

  const nameInput = alice.locator("#org-name")
  await expect(nameInput).toBeVisible({ timeout: 3_000 })

  // Input is prefilled with the current name — capture it for restoration.
  const originalName = await nameInput.inputValue()

  const newName = `RenamedOrg ${Date.now()}`
  await nameInput.fill(newName)

  const saveBtn = alice.getByRole("button", { name: /^Save$/i })
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
  await saveBtn.click()

  // Save exits edit mode and the new name renders as text.
  await expect(nameInput).not.toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText(newName).first()).toBeVisible({ timeout: 5_000 })

  // Restore original name to avoid polluting other tests.
  await alice.getByRole("button", { name: /^Rename$/ }).click()
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(originalName)
  await saveBtn.click()
  await expect(nameInput).not.toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText(originalName).first()).toBeVisible({ timeout: 5_000 })
})
