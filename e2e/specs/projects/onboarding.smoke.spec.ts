import { test, expect } from "@playwright/test"
import { resetBackend } from "../../helpers/seed"

// AQU-2300: retain welcome and privacy, then register through the real auth
// worker and reach the app without workspace/project setup.
test("welcome and privacy choice lead to signup and the app without workspace setup", async ({ page }) => {
  test.setTimeout(120_000)
  await resetBackend()
  await page.goto("/onboarding")
  await page.getByRole("button", { name: /get started/i }).click()
  await expect(page.getByRole("switch", { name: /share usage data/i })).toBeChecked()
  // Leaving before Continue must return to the unanswered sharing screen.
  await page.goto("/login")
  await page.getByRole("link", { name: /create an account/i }).click()
  await expect(page.getByRole("switch", { name: /share usage data/i })).toBeChecked()
  await page.getByRole("button", { name: /^continue$/i }).click()
  await page.getByRole("link", { name: /^log in$/i }).click()
  await page.getByRole("link", { name: /create an account/i }).click()
  await expect(page.getByRole("heading", { name: "Create an Aquilla account" })).toBeVisible()
  await expect(page.getByRole("button", { name: /skip for now/i })).toHaveCount(0)
  await expect(page.getByRole("progressbar")).toHaveCount(0)
  const username = `signup${Date.now()}`
  await page.locator("#s-user").fill(username)
  await page.locator("#s-email").fill(`${username}@example.test`)
  await page.locator("#s-pass").fill("safe-password-12345")
  await page.getByRole("button", { name: /Create account/i }).click()
  await page.waitForURL(/\/orgs\//, { timeout: 30_000 })
  await expect(page.getByRole("button", { name: /account menu/i })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: /account menu/i })).toBeVisible({ timeout: 30_000 })
  expect(new URL(page.url()).pathname).toMatch(/^\/orgs\//)
})
