import { test, expect } from "@playwright/test"
import { resetBackend } from "../../helpers/seed"

test.beforeEach(async () => {
  await resetBackend()
})

test("pending sign-in explains first-time account and permission migration", async ({ page }) => {
  let releaseLogin!: () => void
  const loginHeld = new Promise<void>((resolve) => {
    releaseLogin = resolve
  })

  await page.route("**/api/v2/auth/token", async (route) => {
    await loginHeld
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

  await expect(page.getByRole("button", {
    name: "Setting up your account and permissions…",
  })).toBeVisible()
  await expect(page.getByRole("status")).toHaveText(
    "First-time sign-in may take a moment while we securely migrate your account.",
  )

  releaseLogin()
  await expect(page.getByText("Invalid username or password")).toBeVisible()
})
