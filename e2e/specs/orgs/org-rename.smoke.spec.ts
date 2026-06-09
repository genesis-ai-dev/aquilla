import { test, expect } from "../../helpers/multi-user"

/**
 * Organization rename — Settings page (/settings).
 *
 * The Identity section has a "Rename" button (owner only) that reveals:
 *   - input#org-name with the current name
 *   - Save button (calls renameOrg API)
 *   - Cancel button
 *
 * After saving the new name persists in the page heading.
 *
 * NOTE: This test mutates the org name. The dev stack resets between test
 * runs so this is safe.
 */
test("org rename saves new name in settings page", async ({ alice }) => {
  await alice.goto("/settings")
  await alice.waitForLoadState("networkidle")

  // h1 "Organization settings"
  await expect(
    alice.locator("h1").filter({ hasText: /Organization settings/i })
  ).toBeVisible({ timeout: 10_000 })

  // "Rename" button reveals the edit form.
  const renameBtn = alice.getByRole("button", { name: /^Rename$/i })
  await expect(renameBtn).toBeVisible({ timeout: 5_000 })
  await renameBtn.click()

  // input#org-name is populated.
  const orgNameInput = alice.locator("#org-name")
  await expect(orgNameInput).toBeVisible({ timeout: 3_000 })

  // Change the name.
  const newOrgName = `AcmeE2E ${Date.now()}`
  await orgNameInput.fill(newOrgName)

  // Save.
  const saveBtn = alice.getByRole("button", { name: /^Save$/i })
  await expect(saveBtn).toBeEnabled()
  await saveBtn.click()

  // After save, editing mode closes and the new name is visible.
  await expect(orgNameInput).not.toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText(newOrgName).first()).toBeVisible({ timeout: 5_000 })
})
