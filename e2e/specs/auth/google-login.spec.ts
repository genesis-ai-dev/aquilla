import { test, expect } from "@playwright/test"
import { resetBackend } from "../../helpers/seed"
import { ensureAuthState, injectSession } from "../../helpers/auth"

// Provider-boundary simulation. The worker suite separately uses signed Google
// claims against real Postgres; this suite verifies browser intent, navigation,
// and adoption of a real Aquilla JWT. It does not claim live Google verification.
test.beforeEach(async () => { await resetBackend() })
test("invalidated login-method session offers reauthentication with its settings destination", async ({ page }) => {
  await page.goto("/login")
  await injectSession(page, await ensureAuthState("alice"))
  await page.route("**/api/v2/auth/oauth/google/methods", route => route.fulfill({status:401,json:{error:"Password changed"}}))
  await page.goto("/preferences/login-methods")
  await expect(page.getByRole("alert")).toContainText("Your session expired.")
  await page.getByRole("link",{name:"Log in again",exact:true}).click()
  await expect(page.getByRole("button",{name:"Log in",exact:true})).toBeVisible()
  expect(new URL(page.url()).searchParams.get("next")).toBe("/preferences/login-methods")
  expect(new URL(page.url()).searchParams.get("add")).toBe("1")
})
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

test("Google signup waits for explicit submission and offers recovery after post-commit session failure", async ({ page }) => {
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
  let finishes = 0
  await page.route("**/api/v2/auth/oauth/google/finish", async route => {
    finishes += 1
    await route.fulfill({ status: 503, json: { error: "session_failed" } })
  })
  let proof: { code: string; verifier: string } | undefined
  await page.route("**/api/v2/auth/oauth/google/exchange", async route => {
    proof = route.request().postDataJSON()
    await route.fulfill({ json: { continuation: "d".repeat(64), step: "signup", email: "alice@example.com" } })
  })
  await page.goto("/login?next=%2Forgs%2F1%2Fmembers")
  const google = page.getByRole("button", { name: "Continue with Google", exact: true })
  await expect(google).toBeVisible()
  await google.hover(); await google.focus()
  await expect(page.getByLabel("Username or email")).toBeVisible()
  expect(googleRequests).toEqual([]); expect(starts).toEqual([])
  expect(await page.locator('script[src*="google"],iframe[src*="google"],link[href*="google"]').count()).toBe(0)
  await google.click()
  await page.getByRole("button", { name: "Agree and continue", exact: true }).click()
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Agree and continue", exact: true })).toHaveCount(0)
  expect(googleRequests).toHaveLength(1)
  await page.getByLabel("Username", { exact: true }).fill("new-google-user")
  await expect(page.getByRole("button", { name: "Create account", exact: true })).toBeEnabled()
  await expect(page.getByRole("alert")).toHaveCount(0)
  expect(finishes).toBe(0)
  expect(proof).toBeDefined()
  await page.getByRole("button", { name: "Create account", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Your Google connection was saved")
  await expect(page.getByRole("button", { name: "Create account", exact: true })).toHaveCount(0)
  expect(finishes).toBe(1)
  expect(googleRequests).toHaveLength(1)
  await page.getByRole("link", {name:"Back to login"}).click()
  await expect(page.getByLabel("Username or email")).toBeVisible()
  expect(new URL(page.url()).searchParams.get("next")).toBe("/orgs/1/members")
  expect(googleRequests).toHaveLength(1)
})


test("first-party availability retry recovers without contacting Google", async ({page}) => {
  const providerRequests: string[] = []
  page.on("request", request => {if (/google(?:apis)?\.com|gstatic\.com/.test(request.url())) providerRequests.push(request.url())})
  let checks = 0
  let available = false
  await page.route("**/api/v2/auth/oauth/google/config", route => {
    checks++
    return route.fulfill(!available ? {status:503,json:{error:"unavailable"}} : {json:{enabled:true}})
  })
  await page.goto("/login")
  await expect(page.getByRole("button",{name:"Retry Google login availability"})).toBeVisible()
  const failedChecks = checks
  available = true
  await page.getByRole("button",{name:"Retry Google login availability"}).click()
  await expect(page.getByRole("button",{name:"Continue with Google",exact:true})).toBeVisible()
  expect(checks).toBeGreaterThan(failedChecks)
  expect(providerRequests).toEqual([])
})
