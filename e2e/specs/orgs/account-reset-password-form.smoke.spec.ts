import { test, expect } from "../../helpers/multi-user"

/**
 * FrontierForgotPasswordForm — validates email on submit.
 *
 * Submit stays enabled; clicking with an empty/invalid email shows validation.
 */
test("forgot password form validates email on submit", async ({ alice }) => {
  await alice.goto("/projects")
  const accountBtn = alice.getByRole("button", { name: /Account menu: alice/i })
  await expect(accountBtn).toBeVisible({ timeout: 10_000 })
  await accountBtn.click()

  const addAccountBtn = alice.getByRole("menuitem", { name: /Add another account/i })
  await expect(addAccountBtn).toBeVisible({ timeout: 3_000 })
  await addAccountBtn.click()

  const forgotBtn = alice.getByRole("button", { name: /Forgot password\?/i })
  await expect(forgotBtn).toBeVisible({ timeout: 5_000 })
  await forgotBtn.click()

  await expect(
    alice.getByRole("heading", { name: /Reset your password/i })
  ).toBeVisible({ timeout: 3_000 })

  const sendBtn = alice.getByRole("button", { name: /Send reset link/i })
  await expect(sendBtn).toBeEnabled({ timeout: 3_000 })

  await sendBtn.click()
  await expect(alice.getByText(/email is required/i)).toBeVisible({ timeout: 2_000 })

  const emailInput = alice.locator("#r-email")
  await emailInput.fill("test@example.com")
  await expect(sendBtn).toBeEnabled({ timeout: 2_000 })

  const backBtn = alice.getByRole("button", { name: /^Back to login$/i })
  await backBtn.click()
  await expect(
    alice.getByRole("heading", { name: /Add Frontier account/i })
  ).toBeVisible({ timeout: 3_000 })
})
