import { test, expect } from "../../helpers/multi-user"

/**
 * FrontierSignupForm — show/hide password toggle in the create account form.
 *
 * AccountSwitcher → "Add another account" → "Create an account" opens
 * FrontierSignupForm with:
 *   - Input#s-user (username)
 *   - Input#s-email (email)
 *   - Input#s-pass (password, type="password" by default)
 *   - Button aria-label="Show password" → clicking toggles to "Hide password"
 *     and the input type switches to "text"
 *
 * This spec: navigate to "Create an account" form → verify password input
 * is type="password" → click "Show password" → verify type becomes "text" →
 * click "Hide password" → verify reverts.
 */
test("signup form show/hide password toggle switches input type", async ({ alice }) => {
  await alice.goto("/projects")
  await alice.waitForLoadState("networkidle")

  // Open account switcher.
  const accountBtn = alice.getByRole("button", { name: /Account menu: alice/i })
  await expect(accountBtn).toBeVisible({ timeout: 10_000 })
  await accountBtn.click()

  // Click "Add another account…"
  const addAccountBtn = alice.getByRole("menuitem", { name: /Add another account/i })
  await expect(addAccountBtn).toBeVisible({ timeout: 3_000 })
  await addAccountBtn.click()

  // In login mode dialog, click "Create an account".
  const createAccountBtn = alice.getByRole("button", { name: /Create an account/i })
  await expect(createAccountBtn).toBeVisible({ timeout: 5_000 })
  await createAccountBtn.click()

  // Dialog title switches to "Create a Frontier account".
  await expect(
    alice.getByRole("heading", { name: /Create a Frontier account/i })
  ).toBeVisible({ timeout: 3_000 })

  // Password input is initially type="password".
  const passInput = alice.locator("#s-pass")
  await expect(passInput).toBeVisible({ timeout: 3_000 })
  await expect(passInput).toHaveAttribute("type", "password")

  // Click "Show password" — input becomes type="text".
  const showBtn = alice.getByRole("button", { name: /Show password/i })
  await expect(showBtn).toBeVisible({ timeout: 3_000 })
  await showBtn.click()
  await expect(passInput).toHaveAttribute("type", "text", { timeout: 2_000 })

  // Click "Hide password" — reverts to type="password".
  const hideBtn = alice.getByRole("button", { name: /Hide password/i })
  await expect(hideBtn).toBeVisible({ timeout: 2_000 })
  await hideBtn.click()
  await expect(passInput).toHaveAttribute("type", "password", { timeout: 2_000 })
})
