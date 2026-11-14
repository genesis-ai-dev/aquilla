import { test, expect } from "@playwright/test"
import { resetBackend } from "../../helpers/seed"
import { ensureAuthState, injectSession } from "../../helpers/auth"
test.beforeEach(async () => {
  await resetBackend()
})
test("email settings keeps the old address on delivery failure and never contacts Google", async ({
  page,
}) => {
  const google: string[] = []
  page.on("request", (r) => {
    if (/https:\/\/[^/]*(google|gstatic)/.test(r.url())) google.push(r.url())
  })
  await page.goto("/login")
  await injectSession(page, await ensureAuthState("alice"))
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
  await expect(page.getByRole("alert")).toBeVisible()
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
