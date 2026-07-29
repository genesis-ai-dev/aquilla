import { test, expect } from "@playwright/test"
import { resetBackend } from "../../helpers/seed"

test.beforeEach(async () => {
  await resetBackend()
})

test("sign-in only explains migration after the server confirms it", async ({ page }) => {
  let releaseHandshake!: () => void
  const handshakeHeld = new Promise<void>((resolve) => {
    releaseHandshake = resolve
  })
  let releaseMigration!: () => void
  const migrationHeld = new Promise<void>((resolve) => {
    releaseMigration = resolve
  })
  let confirmContinuation!: () => void
  const continuationSeen = new Promise<void>((resolve) => {
    confirmContinuation = resolve
  })
  let requestCount = 0

  await page.route("**/api/v2/auth/token", async (route) => {
    requestCount += 1
    if (requestCount === 1) {
      await handshakeHeld
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ status: "migration_required" }),
      })
      return
    }
    confirmContinuation()
    await migrationHeld
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "Incorrect username/email or password" }),
    })
  })

  await page.goto("/login")
  await page.getByLabel("Username or email").fill("legacy-user")
  await page.getByRole("textbox", { name: "Password" }).fill("legacy-password")
  await page.getByRole("button", { name: "Sign in" }).click()

  await expect(page.getByRole("button", { name: "Signing in…" })).toBeVisible()
  await expect(page.getByRole("status")).toHaveCount(0)

  releaseHandshake()
  await continuationSeen
  await expect(page.getByRole("button", {
    name: "Setting up your account and permissions…",
  })).toBeVisible()
  await expect(page.getByRole("status")).toHaveText(
    "First-time sign-in may take a moment while we securely migrate your account.",
  )

  releaseMigration()
  await expect(page.getByText("Invalid username or password")).toBeVisible()
})
