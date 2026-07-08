import { test, expect } from "../../helpers/multi-user"

/**
 * Organization rename — Settings Identity detail page (/settings/identity).
 *
 * The Identity page has a "Rename" button (owner/admin only) that opens a
 * dialog with input#org-name and Save/Cancel; a successful Save closes the
 * dialog and renders the new name on the settings page.
 *
 * NOTE: This test mutates the org name. The dev stack resets between test
 * runs so this is safe.
 */
test("org rename saves new name in settings page", async ({ alice }) => {
  await alice.goto("/settings/identity")
  await alice.waitForLoadState("networkidle")

  // h1 "Identity"
  await expect(
    alice.locator("h1").filter({ hasText: /^Identity$/i })
  ).toBeVisible({ timeout: 10_000 })

  // "Rename" opens the edit dialog.
  const renameBtn = alice.getByRole("button", { name: /rename organization/i })
  await expect(renameBtn).toBeVisible({ timeout: 5_000 })
  await renameBtn.click()

  const orgNameInput = alice.locator("#org-name")
  await expect(orgNameInput).toBeVisible({ timeout: 3_000 })

  // Change the name.
  const newOrgName = `AcmeE2E ${Date.now()}`
  await orgNameInput.fill(newOrgName)

  // Save.
  const saveBtn = alice.getByRole("button", { name: /^Save$/i })
  await expect(saveBtn).toBeEnabled()
  await saveBtn.click()

  // After save, the dialog closes and the new name is visible on the page.
  await expect(orgNameInput).not.toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText(newOrgName).first()).toBeVisible({ timeout: 5_000 })
})
