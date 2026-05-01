import { test, expect } from "@playwright/test"
import { resetBackend, seedUser } from "../../helpers/seed"

test.beforeEach(async () => {
  await resetBackend()
})

test("seed user can log in via the UI and lands on dashboard", async ({ page }) => {
  await page.goto("/login")
  const u = seedUser("alice")
  await page.getByLabel(/username/i).fill(u.username)
  await page.getByLabel(/password/i).fill(u.password)
  await page.getByRole("button", { name: /log in|sign in/i }).click()

  // Land on dashboard — h1 (brand) becomes visible
  await expect(page.locator("h1")).toBeVisible({ timeout: 10_000 })
  // The username should appear somewhere in the chrome (account switcher / header)
  await expect(page.getByText(u.username)).toBeVisible({ timeout: 5_000 })
})
