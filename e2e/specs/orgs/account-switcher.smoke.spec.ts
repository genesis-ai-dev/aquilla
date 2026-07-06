import { test, expect } from "../../helpers/multi-user"

/**
 * AccountSwitcher dropdown — sidebar username button.
 *
 * The workspace sidebar (and org sidebar) has a button showing the current
 * username with a ChevronsUpDown icon. Clicking it opens a dropdown with:
 *   - Current user entry
 *   - "Preferences" link
 *   - "Add another account…" button
 *
 * This spec navigates to /projects and verifies the account switcher
 * renders and the dropdown opens.
 */
test("account switcher dropdown opens with session info", async ({ alice }) => {
  await alice.goto("/projects")
  await alice.waitForLoadState("networkidle")

  // The AccountSwitcher renders as a button showing the username.
  // Alice is seeded as "alice".
  const accountBtn = alice.getByRole("button", { name: /Account menu: alice/i })
  await expect(accountBtn).toBeVisible({ timeout: 10_000 })
  await accountBtn.click()

  // Dropdown opens showing the active account.
  await expect(alice.getByText(/alice/i).first()).toBeVisible({ timeout: 3_000 })

  // "Add another account…" button is visible.
  await expect(
    alice.getByRole("button", { name: /Add another account/i })
  ).toBeVisible({ timeout: 3_000 })

  // "Preferences" link is visible.
  await expect(
    alice.getByRole("link", { name: /Preferences/i })
  ).toBeVisible({ timeout: 3_000 })

  // Close by pressing Escape or clicking outside.
  await alice.keyboard.press("Escape")
})
