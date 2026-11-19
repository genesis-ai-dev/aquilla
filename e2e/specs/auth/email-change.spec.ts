import { test, expect } from "@playwright/test"
import { resetBackend } from "../../helpers/seed"
import { ensureAuthState, injectSession } from "../../helpers/auth"
test.beforeEach(async () => {
  await resetBackend()
})
test("email settings distinguishes password rejection from an unavailable endpoint without changing the account", async ({
  page,
}) => {
  const google: string[] = []
  page.on("request", (r) => {
    if (/https:\/\/[^/]*(google|gstatic)/.test(r.url())) google.push(r.url())
  })
  await page.goto("/login")
  await injectSession(page, await ensureAuthState("bob"))
  await page.goto("/preferences/login-methods")
  await page.getByRole("button", { name: "Change email", exact: true }).click()
  await page
    .getByLabel("New email", { exact: true })
    .fill("changed@example.com")
  await page
    .getByLabel("Aquilla password", { exact: true })
    .fill("wrong-password")
  await page
    .getByRole("button", { name: "Send verification email", exact: true })
    .click()
  await expect(page.getByRole("alert")).toContainText("That Aquilla password is incorrect")
  await page.route("**/api/v2/auth/email-change/request", route => route.fulfill({
    status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }),
  }))
  await page.getByLabel("Aquilla password", { exact: true }).fill("wrong-password")
  await page.getByRole("button", { name: "Send verification email", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Email changes are temporarily unavailable")
  await expect(
    page.getByLabel("Verification code", { exact: true }),
  ).toHaveCount(0)
  expect(google).toEqual([])
  await page
    .getByRole("button", { name: "Back to login methods", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Change email", exact: true }),
  ).toBeVisible()
})
