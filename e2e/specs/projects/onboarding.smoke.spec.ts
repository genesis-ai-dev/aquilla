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
  await expect(page.getByRole("heading", { name: "Create an Aquilla Account" })).toBeVisible()
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

// Deny only the progress marker: this exercises the observed failure without
// changing the analytics-choice contract or pretending all private windows fail.
test("signup survives denied progress storage and remembers the choice across login navigation", async ({ page }) => {
  await resetBackend()
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem
    const set = Storage.prototype.setItem
    Storage.prototype.getItem = function (key) {
      if (key === "aquilla:signupStarted") throw new DOMException("Storage blocked", "SecurityError")
      return get.call(this, key)
    }
    Storage.prototype.setItem = function (key, value) {
      if (key === "aquilla:signupStarted") throw new DOMException("Storage blocked", "SecurityError")
      return set.call(this, key, value)
    }
  })
  await page.goto("/signup")
  await page.getByRole("button", { name: /get started/i }).click()
  const sharing = page.getByRole("switch", { name: /share usage data/i })
  await expect(sharing).toBeChecked()
  await sharing.click()
  await page.getByRole("button", { name: /^continue$/i }).click()
  await page.getByRole("link", { name: /^log in$/i }).click()
  await page.getByRole("link", { name: /create an account/i }).click()
  await expect(page.getByRole("heading", { name: "Create an Aquilla Account" })).toBeVisible()
  await page.getByRole("button", { name: /back/i }).click()
  await expect(sharing).not.toBeChecked()
  await page.getByRole("button", { name: /^continue$/i }).click()
  const username = `storage${Date.now()}`
  await page.getByLabel("Username", { exact: true }).fill(username)
  await page.getByLabel("Email", { exact: true }).fill(`${username}@example.test`)
  await page.getByLabel("Password", { exact: true }).fill("safe-password-12345")
  await page.getByRole("button", { name: /create account/i }).click()
  await page.waitForURL(/\/orgs\//, { timeout: 30_000 })
  await expect(page.getByRole("button", { name: /account menu/i })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("aquilla:analyticsEnabled"))).toBe("false")
})
