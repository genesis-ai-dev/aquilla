import { test, expect } from "../../helpers/multi-user"

/**
 * AccountSwitcher — clicking the account button opens the dropdown.
 *
 * AccountSwitcher.tsx renders a button with the active username + a
 * ChevronsUpDown icon. Clicking it opens a dropdown that shows:
 *   - "Signed in" section with the active account
 *   - "Log out" button
 *   - "Add another account…" button
 *   - "Preferences" link
 *
 * This spec navigates to the org root "/" where the OrgSidebar (containing
 * AccountSwitcher) is visible, clicks the account button, and verifies the
 * dropdown opens with the expected controls.
 */
test("account switcher dropdown opens and shows Log out button", async ({ alice }) => {
  await alice.goto("/")
  await alice.waitForLoadState("networkidle")

  // The AccountSwitcher button shows the active username.
  // It contains a ChevronsUpDown icon — find the button by the known username.
  const switcherBtn = alice.locator("button").filter({ hasText: /alice/i }).first()
  await expect(switcherBtn).toBeVisible({ timeout: 10_000 })
  await switcherBtn.click()

  // Dropdown should open — "Log out" button becomes visible.
  const logoutBtn = alice.getByRole("button", { name: /^Log out$/i })
  await expect(logoutBtn).toBeVisible({ timeout: 5_000 })

  // "Add another account…" should also be visible.
  const addAccountBtn = alice.getByRole("button", { name: /Add another account/i })
  await expect(addAccountBtn).toBeVisible({ timeout: 3_000 })

  // Click away to close the dropdown (click on body outside the switcher).
  await alice.keyboard.press("Escape")
  // Dropdown closes — "Log out" is no longer visible.
  await expect(logoutBtn).not.toBeVisible({ timeout: 3_000 })
})
