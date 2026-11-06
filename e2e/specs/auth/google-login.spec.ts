import { test, expect } from "@playwright/test"
import { resetBackend } from "../../helpers/seed"
import { ensureAuthState } from "../../helpers/auth"

// Provider-boundary simulation. The worker suite separately uses signed Google
// claims against real Postgres; this suite verifies browser intent, navigation,
// and adoption of a real Aquilla JWT. It does not claim live Google verification.
test.beforeEach(async () => { await resetBackend() })
test("Google is silent before activation and its handoff preserves the destination and ordinary session", async ({ page }) => {
  const session = await ensureAuthState("alice")
  const googleRequests: string[] = []
  const starts: object[] = []
  await page.route("**/api/v2/auth/oauth/google/config", route => route.fulfill({ json: { enabled: true } }))
  await page.route("**/api/v2/auth/oauth/google/start", async route => {
    starts.push(route.request().postDataJSON())
    await route.fulfill({ json: { authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?test=explicit-click" } })
  })
  await page.route(/https:\/\/[^/]*(?:google\.com|googleapis\.com|gstatic\.com)\//, async route => {
    googleRequests.push(route.request().url())
    const back = new URL(`/auth/google/return#code=${"c".repeat(64)}`, page.url()).href
    // WebKit cannot fulfill an intercepted request with a redirect status.
    // A provider page navigation exercises the same cross-origin return.
    await route.fulfill({ contentType: "text/html", body: `<script>location.replace(${JSON.stringify(back)})</script>` })
  })
  let proof: { code: string; verifier: string } | undefined
  await page.route("**/api/v2/auth/oauth/google/exchange", async route => {
    proof = route.request().postDataJSON()
    await route.fulfill({ json: { access_token: session.jwt, token_type: "bearer", username: session.username, created: false } })
  })
  await page.goto("/login?next=%2Forgs%2F1%2Fmembers")
  const google = page.getByRole("button", { name: "Continue with Google", exact: true })
  await expect(google).toBeVisible()
  await google.hover(); await google.focus()
  await expect(page.getByLabel("Username or email")).toBeVisible()
  expect(googleRequests).toEqual([]); expect(starts).toEqual([])
  expect(await page.locator('script[src*="google"],iframe[src*="google"],link[href*="google"]').count()).toBe(0)
  await google.click()
  await expect(page).toHaveURL(/\/orgs\/1\/members$/)
  await expect(page.getByRole("button", { name: /Account menu: alice/ })).toBeVisible({ timeout: 30_000 })
  expect(googleRequests).toHaveLength(1)
  expect(starts).toEqual([{ challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }])
  expect(proof).toEqual({ code: "c".repeat(64), verifier: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(page.url()).not.toContain("code=")
  await page.reload()
  await expect(page.getByRole("button", { name: /Account menu: alice/ })).toBeVisible({ timeout: 30_000 })
})

test("cancelled Google login returns to a usable password login without retrying the provider", async ({ page }) => {
  const requests: string[] = []
  page.on("request", request => { if (/google(?:apis)?\.com/.test(request.url())) requests.push(request.url()) })
  await page.goto("/auth/google/return#error=cancelled")
  await expect(page.getByRole("alert")).toContainText("cancelled")
  expect(page.url()).not.toContain("#")
  await page.getByRole("link", { name: "Back to login" }).click()
  await expect(page.getByLabel("Username or email")).toBeVisible()
  expect(requests).toEqual([])
})
