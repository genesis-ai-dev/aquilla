import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * OrgSwitcher — create new org.
 *
 * OrgSwitcher.tsx renders a "Create" row in the dropdown. Clicking
 * it opens a dialog with an organization name field. Submitting creates the
 * org and switches to it.
 *
 * This spec: navigate to org home → open OrgSwitcher → click "Create" →
 * type a name in the dialog → submit → the new org name appears in the trigger.
 */
test("OrgSwitcher Create org creates and switches to new org", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  // Open the OrgSwitcher dropdown.
  const trigger = alice.locator("button").filter({ has: alice.locator(".lucide-chevron-down") }).first()
  await expect(trigger).toBeVisible({ timeout: 10_000 })
  await trigger.click()

  // Click "Create".
  const createOrgItem = alice.getByRole("menuitem", { name: /^create$/i })
  await expect(createOrgItem).toBeVisible({ timeout: 3_000 })
  await createOrgItem.click()

  // The create dialog appears.
  const dialog = alice.getByRole("dialog", { name: /create organization/i })
  await expect(dialog).toBeVisible({ timeout: 3_000 })

  // Type the new org name.
  const newOrgName = `NewOrg ${Date.now()}`
  await dialog.getByLabel(/organization name/i).fill(newOrgName)

  // Submit.
  await dialog.getByRole("button", { name: /create organization/i }).click()

  // The switcher switches to the new org — its name appears in the trigger.
  await expect(
    alice.locator("button").filter({ has: alice.locator(".lucide-chevron-down") }).first()
      .getByText(newOrgName)
  ).toBeVisible({ timeout: 8_000 })
})
