import { test, expect } from "../../helpers/multi-user"

/**
 * FrontierLoginForm — show/hide password toggle in the login dialog.
 *
 * AccountSwitcher → "Add another account…" opens the login dialog
 * (FrontierLoginForm) which has:
 *   - Input#f-pass (password, type="password" by default)
 *   - Button aria-label="Show password" → clicking sets type="text"
 *   - Button aria-label="Hide password" → clicking sets type="password"
 *
 * This spec: open the "Add another account" dialog → verify #f-pass is
 * type="password" → click "Show password" → type becomes "text" →
 * click "Hide password" → reverts to "password".
 */
test("login form show/hide password toggle switches input type", async ({ alice }) => {
  await alice.goto("/projects")
  await alice.waitForLoadState("networkidle")

  // Open account switcher.
  const accountBtn = alice.getByRole("button", { name: /Account menu: alice/i })
  await expect(accountBtn).toBeVisible({ timeout: 10_000 })
  await accountBtn.click()

  // Click "Add another account…"
  const addAccountBtn = alice.getByRole("button", { name: /Add another account/i })
  await expect(addAccountBtn).toBeVisible({ timeout: 3_000 })
  await addAccountBtn.click()

  // The login dialog opens — "Add Frontier account" heading visible.
  await expect(
    alice.getByRole("heading", { name: /Add Frontier account/i })
  ).toBeVisible({ timeout: 5_000 })

  // #f-pass is initially type="password".
  const passInput = alice.locator("#f-pass")
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
