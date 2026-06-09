import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * OrgSwitcher — inline org rename.
 *
 * OrgSwitcher.tsx renders a dropdown with a "Rename" button (visible when
 * the user's role level >= 600, i.e., owner/admin). Clicking it shows an
 * input[aria-label="Rename org"] + Save button.
 *
 * This spec: navigate to org home → open the OrgSwitcher → click "Rename" →
 * verify the aria-label="Rename org" input appears → type a new name →
 * click Save → the switcher updates to the new name.
 */
test("OrgSwitcher inline rename updates org name", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  // The OrgSwitcher is in the sidebar. Click the org name/role trigger.
  // It renders a button with the org name + ChevronsUpDown icon.
  const trigger = alice.locator("button").filter({ has: alice.locator(".lucide-chevrons-up-down") }).first()
  await expect(trigger).toBeVisible({ timeout: 10_000 })
  await trigger.click()

  // The dropdown opens. Click "Rename".
  const renameBtn = alice.getByRole("button", { name: /^Rename$/i })
  await expect(renameBtn).toBeVisible({ timeout: 3_000 })
  await renameBtn.click()

  // The rename input appears.
  const renameInput = alice.locator('input[aria-label="Rename org"]')
  await expect(renameInput).toBeVisible({ timeout: 3_000 })

  // Type a new name.
  const newName = `Renamed ${Date.now()}`
  await renameInput.fill(newName)

  // Click Save.
  const saveBtn = alice.getByRole("button", { name: /^Save$/i })
  await expect(saveBtn).toBeVisible({ timeout: 2_000 })
  await saveBtn.click()

  // The switcher updates to show the new name.
  await expect(alice.getByText(newName).first()).toBeVisible({ timeout: 5_000 })
})
