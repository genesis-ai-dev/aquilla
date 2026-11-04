import { test, expect } from "@playwright/test"
import { AccountSwitcherPage } from "../helpers/page-objects/AccountSwitcher"
import { resetBackend } from "../helpers/seed"
import { ensureAuthState, injectSession, injectSessions } from "../helpers/auth"

// Run against the hermetic dev stack with VITE_POSTHOG_KEY=phc_local_privacy_test
// and a local collector. Never send these synthetic events to production.
test.use({ launchOptions: { args: ["--disable-blink-features=AutomationControlled"] }, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" })
const collector = "http://127.0.0.1:9999"
test("analytics requires approval and cannot cross account boundaries", async ({ page, request }) => {
  test.setTimeout(180_000)
  // SDK bot filtering must not be mistaken for successful consent gating.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => false })
    Object.defineProperty(navigator, "userAgentData", { configurable: true, get: () => undefined })
  })
  await resetBackend()
  await request.get(`${collector}/_reset`)
  const a = await ensureAuthState("alice")
  const b = await ensureAuthState("bob")
  for (const route of ["/login", "/join/PRIVATE_INVITE_TOKEN", "/join-org/PRIVATE_ORG_TOKEN", "/reset-password?token=PRIVATE_RESET_TOKEN"]) {
    await page.goto(route)
    await expect.poll(() => page.locator("#root").innerText()).not.toBe("")
    expect(await (await request.get(`${collector}/_audit`)).json()).toEqual([])
    expect(await page.evaluate(() => performance.getEntriesByType("resource").filter(entry => /posthog-js|posthog\.com/.test(entry.name)).length)).toBe(0)
  }
  await page.goto("/signup")
  await page.getByRole("button", { name: /get started/i }).click()
  await expect(page.getByRole("switch", { name: /share usage data/i })).toBeChecked()
  await page.getByRole("button", { name: /agree and continue/i }).click()
  await expect(page.getByRole("heading", { name: "Create an Aquilla Account" })).toBeVisible()
  expect(await (await request.get(`${collector}/_audit`)).json()).toEqual([])
  await injectSessions(page, [a, b], "alice")
  await expect(page.getByRole("button", { name: /account menu/i })).toBeVisible()
  const state = () => page.evaluate(async () => {
    const { analyticsAccount: account } = await import(performance.getEntriesByType("resource").map(entry => entry.name).find(url => url.includes("/src/lib/analytics-account.ts?")) ?? "/src/lib/analytics-account.ts")
    const snapshot = { ...account.getSnapshot(), eligible: account.eligible() }; return snapshot
  })
  await expect.poll(async () => (await state()).accountId).not.toBeNull()
  expect((await state()).eligible).toBe(false)
  expect(await (await request.get(`${collector}/_audit`)).json()).toEqual([])
  await page.evaluate(async () => { const { analyticsAccount } = await import(performance.getEntriesByType("resource").map(entry => entry.name).find(url => url.includes("/src/lib/analytics-account.ts?")) ?? "/src/lib/analytics-account.ts"); await analyticsAccount.choose(true) })
  await expect.poll(async () => (await state()).eligible).toBe(true)
  const emit = (name: string) => page.evaluate(async name => {
    const { default: analytics } = await import(performance.getEntriesByType("resource").map(entry => entry.name).find(url => url.includes("/src/lib/posthog.ts?")) ?? "/src/lib/posthog.ts")
    analytics.capture(name, {}, { send_instantly: true })
  }, name)
  const events = async () => JSON.stringify(await (await request.get(`${collector}/_audit`)).json())
  await expect.poll(async () => { await emit("approved-alice"); return events() }, { timeout: 30_000 }).toContain("approved-alice")
  await page.evaluate(() => {
    const masked = document.createElement("div")
    masked.setAttribute("data-ph-mask", "")
    masked.textContent = "PRIVATE_ALICE_CANARY"
    document.body.append(masked)
  })
  await page.getByRole("button", { name: /account menu/i }).click()
  await page.keyboard.press("Escape")
  await expect.poll(events, { timeout: 30_000 }).toContain("$snapshot")
  expect(await events()).not.toContain("PRIVATE_ALICE_CANARY")
  await page.evaluate(async () => {
    const { default: analytics } = await import(performance.getEntriesByType("resource").map(entry => entry.name).find(url => url.includes("/src/lib/posthog.ts?")) ?? "/src/lib/posthog.ts")
    ;(window as any).__oldAnalytics = analytics.scope()
  })
  await new AccountSwitcherPage(page).openMenu("alice")
  const otherAccount = page.getByRole("menuitem", { name: /bob/i })
  await otherAccount.focus()
  await otherAccount.press("Enter")
  await expect.poll(async () => (await state()).username).toBe("bob")
  await expect.poll(async () => (await state()).accountId).not.toBeNull()
  expect((await state()).eligible).toBe(false)
  await emit("forbidden-bob")
  await page.evaluate(() => (window as any).__oldAnalytics.capture("forbidden-late-alice"))
  await page.evaluate(async () => { const { analyticsAccount } = await import(performance.getEntriesByType("resource").map(entry => entry.name).find(url => url.includes("/src/lib/analytics-account.ts?")) ?? "/src/lib/analytics-account.ts"); await analyticsAccount.choose(true) })
  await expect.poll(async () => { await emit("approved-bob"); return events() }, { timeout: 30_000 }).toContain("approved-bob")
  await page.evaluate(() => (window as any).__oldAnalytics.capture("forbidden-late-alice"))
  await page.evaluate(async () => { const { analyticsAccount } = await import(performance.getEntriesByType("resource").map(entry => entry.name).find(url => url.includes("/src/lib/analytics-account.ts?")) ?? "/src/lib/analytics-account.ts"); await analyticsAccount.choose(false) })
  await emit("forbidden-withdrawn-bob")
  const data = await events()
  expect(data).not.toContain("forbidden-")
  const records = await (await request.get(`${collector}/_audit`)).json()
  const captured = records.flatMap((record: any) => record.payload?.batch ?? [])
  const alice = captured.find((event: any) => event.event === "approved-alice")
  const bob = captured.find((event: any) => event.event === "approved-bob")
  expect(alice.properties.distinct_id).not.toBe(bob.properties.distinct_id)
  expect(alice.properties.$session_id).not.toBe(bob.properties.$session_id)
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("ph_")))).toEqual([])
  // Retry/queue time is advanced after withdrawal; no late dispatch may escape.
  const count = records.length
  await page.clock.install()
  await page.clock.fastForward(120_000)
  expect((await (await request.get(`${collector}/_audit`)).json()).length).toBe(count)
  expect((await state()).eligible).toBe(false)
})

test("withdrawal propagates to another tab and offline activity never queues", async ({ page, context, request }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => false })
    Object.defineProperty(navigator, "userAgentData", { configurable: true, get: () => undefined })
  })
  await resetBackend()
  await request.get(`${collector}/_reset`)
  await page.goto("/login")
  await injectSession(page, await ensureAuthState("alice"))
  await page.goto("/preferences")
  const sharing = page.getByRole("switch", { name: /share usage data/i })
  await expect(sharing).toBeEnabled()
  await expect(sharing).not.toBeChecked()
  await sharing.click()
  await expect(sharing).toBeChecked()
  const state = (target = page) => target.evaluate(async () => {
    const { analyticsAccount: account } = await import(performance.getEntriesByType("resource").map(entry => entry.name).find(url => url.includes("/src/lib/analytics-account.ts?")) ?? "/src/lib/analytics-account.ts")
    return { ...account.getSnapshot(), eligible: account.eligible() }
  })
  await expect.poll(async () => (await state()).eligible).toBe(true)
  await context.setOffline(true)
  await expect.poll(async () => (await state()).eligible).toBe(false)
  await page.evaluate(async () => {
    const { default: analytics } = await import(performance.getEntriesByType("resource").map(entry => entry.name).find(url => url.includes("/src/lib/posthog.ts?")) ?? "/src/lib/posthog.ts")
    analytics.capture("forbidden-offline", {}, { send_instantly: true })
  })
  await context.setOffline(false)
  await expect.poll(async () => (await state()).eligible).toBe(true)
  const other = await context.newPage()
  await other.goto("/preferences")
  await expect(other.getByRole("switch", { name: /share usage data/i })).toBeChecked()
  await other.getByRole("switch", { name: /share usage data/i }).click()
  await expect(other.getByRole("switch", { name: /share usage data/i })).not.toBeChecked()
  await page.bringToFront()
  await expect.poll(async () => (await state()).eligible).toBe(false)
  await expect(sharing).not.toBeChecked()
  await page.reload()
  await expect(page.getByRole("switch", { name: /share usage data/i })).toBeEnabled()
  await expect(page.getByRole("switch", { name: /share usage data/i })).not.toBeChecked()
  expect(JSON.stringify(await (await request.get(`${collector}/_audit`)).json())).not.toContain("forbidden-offline")
  await other.close()
})
