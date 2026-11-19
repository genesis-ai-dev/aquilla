import { test, expect } from "@playwright/test"
import { resetBackend, seedUser } from "../../helpers/seed"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { createHmac } from "node:crypto"
// Independently calculate the code; never import Worker types into the SPA build.
function totp(secret: string, step: number) {
  const bits = [...secret]
    .map((c) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        .indexOf(c)
        .toString(2)
        .padStart(5, "0"),
    )
    .join("")
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2))),
    counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const digest = createHmac("sha1", key).update(counter).digest()
  return String(
    (digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000,
  ).padStart(6, "0")
}

test.beforeEach(async () => {
  await resetBackend()
})
test("authenticator enrollment protects settings, recovery unlocks them, and normal login still works", async ({
  page,
}, testInfo) => {
  const alice = seedUser("alice")
  await page.goto("/login")
  await injectSession(page, await ensureAuthState("alice"))
  await page.goto("/preferences/login-methods")
  const preferences = page.getByTestId("preferences-dialog")
  await expect(preferences.getByRole("heading", { name: "Login methods", exact: true })).toBeVisible()
  await expect(page.getByTestId("account-login-security")).toHaveCount(1)
  await expect(
    page.getByRole("button", {
      name: "Set up an authenticator app",
      exact: true,
    }),
  ).toBeVisible()
  await page
    .getByTestId("account-login-security")
    .screenshot({
      path: testInfo.outputPath("login-settings.png"),
      animations: "disabled",
    })
  await page
    .getByRole("button", { name: "Set up an authenticator app", exact: true })
    .click()
  await page
    .getByLabel("Current Aquilla password", { exact: true })
    .fill(alice.password)
  const setupResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/auth/security/setup") &&
      r.request().method() === "POST",
  )
  await page
    .getByLabel("Current Aquilla password", { exact: true })
    .press("Enter")
  const setup = (await (await setupResponse).json()) as { secret: string }
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page.getByAltText("Authenticator setup QR code")).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath("authenticator-dialog.png"),
    animations: "disabled",
  })
  await page
    .getByLabel("Authenticator code", { exact: true })
    .fill(await totp(setup.secret, Math.floor(Date.now() / 30000)))
  await page.getByLabel("Authenticator code", { exact: true }).press("Enter")
  const codes = (await page.locator("pre").innerText()).split("\n")
  expect(codes).toHaveLength(8)
  await page
    .getByRole("checkbox", { name: "I saved my recovery codes", exact: true })
    .check()
  await page.getByRole("button", { name: "Done", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Change email", exact: true }),
  ).toBeVisible()
  // A new login has a different JWT and no settings proof. Password login itself
  // is still allowed; the authenticator gates the settings, not the account.
  const base = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"
  const response = await page.request.post(`${base}/api/v2/auth/token`, {
    data: { username: alice.username, password: alice.password },
  })
  expect(response.ok()).toBe(true)
  const login = await response.json()
  const existing = await ensureAuthState("alice")
  await injectSession(page, { ...existing, jwt: login.access_token })
  await page.reload()
  await expect(
    page.getByText(
      "Verify with your authenticator app to manage your login methods.",
      { exact: true },
    ),
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Change email", exact: true }),
  ).toHaveCount(0)
  await page
    .getByRole("button", { name: "Use a recovery code", exact: true })
    .click()
  await page.getByLabel("Recovery code", { exact: true }).fill(codes[0])
  await page.getByLabel("Recovery code", { exact: true }).press("Enter")
  await expect(
    page.getByRole("button", { name: "Change email", exact: true }),
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Reset Aquilla password", exact: true })
    .click()
  await page
    .getByLabel("Current password", { exact: true })
    .fill(alice.password)
  await page
    .getByLabel("New Aquilla password", { exact: true })
    .fill("replacement-test-password-2631")
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click()
  await expect(
    page.getByText(
      "Verify with your authenticator app to manage your login methods.",
      { exact: true },
    ),
  ).toBeVisible()
  const changedLogin = await page.request.post(`${base}/api/v2/auth/token`, {
    data: {
      username: alice.username,
      password: "replacement-test-password-2631",
    },
  })
  expect(changedLogin.ok()).toBe(true)
  await test.info().attach("settings-protected-after-password-change", {
    body: await page.screenshot(),
    contentType: "image/png",
  })
  await preferences.getByRole("button", { name: "Close", exact: true }).click()
  await expect(page).toHaveURL(/\/orgs\//)
  await expect(page.getByTestId("account-login-security")).toHaveCount(0)
})

test("a signed-out Login methods link offers login in a single Preferences dialog", async ({ page }) => {
  await page.goto("/preferences/login-methods?backup=1")
  const dialog = page.getByTestId("preferences-dialog")
  await expect(dialog).toHaveCount(1)
  await expect(page.getByTestId("account-login-security")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Log in", exact: true }).click()
  await expect(page).toHaveURL(/\/login\?next=/)
  expect(new URL(page.url()).searchParams.get("next")).toBe("/preferences/login-methods?backup=1")
})
