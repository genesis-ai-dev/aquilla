import { test, expect } from "../../helpers/multi-user"

/**
 * AccountSwitcher — "Add another account" dialog + forgot password flow.
 *
 * AccountSwitcher.tsx renders:
 *   1. A dropdown with "Add another account…" button.
 *   2. Clicking it opens a Dialog titled "Add Frontier account"
 *      with FrontierLoginForm, which has a "Forgot password?" button.
 *   3. Clicking "Forgot password?" switches the dialog to mode="forgot",
 *      which renders FrontierForgotPasswordForm with title "Reset your password".
 *
 * This spec: open the account switcher → click "Add another account…" →
 * verify dialog shows "Add Frontier account" → click "Forgot password?" →
 * verify dialog title becomes "Reset your password".
 */
test("account switcher add-account dialog Forgot password switches to reset mode", async ({ alice }) => {
  await alice.goto("/projects")
  await alice.waitForLoadState("networkidle")

  // Open the account switcher (username button with ChevronsUpDown icon).
  const accountBtn = alice.getByRole("button", { name: /alice/i }).first()
  await expect(accountBtn).toBeVisible({ timeout: 10_000 })
  await accountBtn.click()

  // Click "Add another account…"
  const addAccountBtn = alice.getByRole("button", { name: /Add another account/i })
  await expect(addAccountBtn).toBeVisible({ timeout: 3_000 })
  await addAccountBtn.click()

  // Dialog opens with "Add Frontier account" title.
  await expect(
    alice.getByRole("heading", { name: /Add Frontier account/i })
  ).toBeVisible({ timeout: 5_000 })

  // Click "Forgot password?" to switch to reset mode.
  const forgotBtn = alice.getByRole("button", { name: /Forgot password\?/i })
  await expect(forgotBtn).toBeVisible({ timeout: 3_000 })
  await forgotBtn.click()

  // Dialog title becomes "Reset your password".
  await expect(
    alice.getByRole("heading", { name: /Reset your password/i })
  ).toBeVisible({ timeout: 3_000 })
})
