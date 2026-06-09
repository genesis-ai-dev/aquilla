import { test, expect } from "../../helpers/multi-user"

/**
 * FrontierSignupForm — PasswordChecklist shows requirement status and
 * password strength when typing.
 *
 * FrontierSignupForm.tsx renders PasswordChecklist when a password is typed:
 *   - "At least 8 characters" requirement (Check icon when met)
 *   - "Does not contain your email" requirement
 *   - A strength bar with text "Strength: weak/medium/strong"
 *
 * This spec: open the Create account form → type a short password → verify
 * "Strength: weak" → type a longer password with mixed chars → verify
 * "Strength: strong".
 */
test("signup form password checklist shows strength indicator", async ({ alice }) => {
  await alice.goto("/projects")
  await alice.waitForLoadState("networkidle")

  // Open account switcher.
  const accountBtn = alice.getByRole("button", { name: /alice/i }).first()
  await expect(accountBtn).toBeVisible({ timeout: 10_000 })
  await accountBtn.click()

  // Add another account.
  const addAccountBtn = alice.getByRole("button", { name: /Add another account/i })
  await expect(addAccountBtn).toBeVisible({ timeout: 3_000 })
  await addAccountBtn.click()

  // Switch to signup form.
  const createAccountBtn = alice.getByRole("button", { name: /Create an account/i })
  await expect(createAccountBtn).toBeVisible({ timeout: 5_000 })
  await createAccountBtn.click()

  // Verify signup dialog is open.
  await expect(
    alice.getByRole("heading", { name: /Create a Frontier account/i })
  ).toBeVisible({ timeout: 3_000 })

  // Type a short password (weak).
  const passwordInput = alice.locator("#s-pass")
  await expect(passwordInput).toBeVisible({ timeout: 3_000 })
  await passwordInput.fill("abc")

  // Strength indicator appears with "weak".
  await expect(alice.getByText(/Strength: weak/i)).toBeVisible({ timeout: 2_000 })

  // Type a strong password (8+ chars, digit, symbol).
  await passwordInput.fill("Tr@nsl8r!99")

  // Strength becomes "strong".
  await expect(alice.getByText(/Strength: strong/i)).toBeVisible({ timeout: 2_000 })

  // "At least 8 characters" requirement text is visible.
  await expect(alice.getByText(/At least 8 characters/i)).toBeVisible({ timeout: 2_000 })

  // Close dialog.
  await alice.keyboard.press("Escape")
})
