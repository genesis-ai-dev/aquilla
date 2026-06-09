import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * OrgSwitcher — create new org.
 *
 * OrgSwitcher.tsx renders a "+ Create org" button in the dropdown. Clicking
 * it reveals an input[aria-label="New org name"] + Create button. Submitting
 * creates the org and switches to it.
 *
 * This spec: navigate to org home → open OrgSwitcher → click "+ Create org" →
 * type a name → click Create → the new org name appears in the trigger.
 */
test("OrgSwitcher Create org creates and switches to new org", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  // Open the OrgSwitcher dropdown.
  const trigger = alice.locator("button").filter({ has: alice.locator(".lucide-chevrons-up-down") }).first()
  await expect(trigger).toBeVisible({ timeout: 10_000 })
  await trigger.click()

  // Click "+ Create org".
  const createOrgBtn = alice.getByRole("button", { name: /\+\s*Create org/i })
  await expect(createOrgBtn).toBeVisible({ timeout: 3_000 })
  await createOrgBtn.click()

  // The create input appears.
  const createInput = alice.locator('input[aria-label="New org name"]')
  await expect(createInput).toBeVisible({ timeout: 3_000 })

  // Type the new org name.
  const newOrgName = `NewOrg ${Date.now()}`
  await createInput.fill(newOrgName)

  // Click Create.
  const createBtn = alice.getByRole("button", { name: /^Create$/i })
  await expect(createBtn).toBeVisible({ timeout: 2_000 })
  await createBtn.click()

  // The switcher switches to the new org — its name appears in the trigger.
  await expect(
    alice.locator("button").filter({ has: alice.locator(".lucide-chevrons-up-down") }).first()
      .getByText(newOrgName)
  ).toBeVisible({ timeout: 8_000 })
})
