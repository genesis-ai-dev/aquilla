import { test, expect } from "../../helpers/multi-user"

/**
 * FrontierForgotPasswordForm — email input enables "Send reset link" button.
 *
 * AccountSwitcher → "Add another account" → "Forgot password?" opens the
 * FrontierForgotPasswordForm (DialogTitle "Reset your password") with:
 *   - Input#r-email (email type, must match /.+@.+\..+/ to enable submit)
 *   - "Send reset link" button (disabled until valid email)
 *   - "Back to login" button (returns to login form)
 *
 * This spec: navigate to the forgot-password form via the add-account dialog
 * → verify "Send reset link" is disabled initially → fill a valid email →
 * verify "Send reset link" becomes enabled → click "Back to login" →
 * verify we're back on the "Add Frontier account" view.
 */
test("forgot password form enables send button on valid email input", async ({ alice }) => {
  await alice.goto("/projects")
  await alice.waitForLoadState("networkidle")

  // Open account switcher and trigger "Add another account".
  const accountBtn = alice.getByRole("button", { name: /alice/i }).first()
  await expect(accountBtn).toBeVisible({ timeout: 10_000 })
  await accountBtn.click()

  const addAccountBtn = alice.getByRole("button", { name: /Add another account/i })
  await expect(addAccountBtn).toBeVisible({ timeout: 3_000 })
  await addAccountBtn.click()

  // Navigate to forgot-password mode.
  const forgotBtn = alice.getByRole("button", { name: /Forgot password\?/i })
  await expect(forgotBtn).toBeVisible({ timeout: 5_000 })
  await forgotBtn.click()

  await expect(
    alice.getByRole("heading", { name: /Reset your password/i })
  ).toBeVisible({ timeout: 3_000 })

  // "Send reset link" button is disabled with empty email.
  const sendBtn = alice.getByRole("button", { name: /Send reset link/i })
  await expect(sendBtn).toBeDisabled({ timeout: 3_000 })

  // Fill a valid email — button becomes enabled.
  const emailInput = alice.locator("#r-email")
  await expect(emailInput).toBeVisible({ timeout: 3_000 })
  await emailInput.fill("test@example.com")
  await expect(sendBtn).toBeEnabled({ timeout: 2_000 })

  // Click "Back to login" — returns to the login form.
  const backBtn = alice.getByRole("button", { name: /^Back to login$/i })
  await expect(backBtn).toBeVisible({ timeout: 2_000 })
  await backBtn.click()

  // Dialog reverts to "Add Frontier account" title.
  await expect(
    alice.getByRole("heading", { name: /Add Frontier account/i })
  ).toBeVisible({ timeout: 3_000 })
})
