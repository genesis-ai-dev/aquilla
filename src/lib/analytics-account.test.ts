import { beforeEach, expect, it, vi } from "vitest"
import { AnalyticsAccount } from "./analytics-account"
import { ANALYTICS_DISCLOSURE_VERSION } from "../../shared/analytics-consent"
import type { FrontierSession } from "./frontier/types"
vi.mock("@/lib/frontier/auth", () => ({ AUTH_BASE: "https://test.invalid", isJwtExpired: () => false }))
const session = (username: string): FrontierSession => ({ username, jwt: username, createdAt: "now" })
const decision = (allowed: boolean) => ({ allowed, disclosureVersion: ANALYTICS_DISCLOSURE_VERSION, revision: "r1", decidedAt: new Date().toISOString(), source: "settings" as const })
beforeEach(() => { localStorage.clear(); vi.spyOn(document, "hidden", "get").mockReturnValue(false); vi.spyOn(navigator, "onLine", "get").mockReturnValue(true) })
it("isolates accounts, rejects legacy yes and invalidates a late account response", async () => {
  let release!: (v: { accountId: string; decision: ReturnType<typeof decision> }) => void
  const request = vi.fn(async (jwt: string) => jwt === "slow" ? new Promise<{ accountId: string; decision: ReturnType<typeof decision> }>(r => { release = r }) : { accountId: jwt, decision: jwt === "unknown" ? null : decision(jwt === "a") })
  const state = new AnalyticsAccount(request)
  localStorage.setItem("aquilla:analyticsEnabled", "true")
  await state.activate(session("unknown")); expect(state.eligible()).toBe(false)
  await state.activate(session("a")); expect(state.eligible()).toBe(true)
  expect(state.eligibleForSession("a")).toBe(true)
  expect(state.eligibleForSession("b")).toBe(false)
  const pending = state.activate(session("slow")); expect(state.eligible()).toBe(false)
  await state.activate(session("b")); release({ accountId: "slow", decision: decision(true) }); await pending
  expect(state.getSnapshot().accountId).toBe("b"); expect(state.eligible()).toBe(false)
  await state.activate(session("a")); expect(state.eligible()).toBe(true)
  await state.activate(null); expect(state.eligible()).toBe(false)
})
it("withdraws synchronously and keeps a failed refusal across rehydration", async () => {
  const request = vi.fn(async (_jwt: string, _signal: AbortSignal, body?: Record<string, unknown>) => {
    if (body) throw new Error("offline")
    return { accountId: "a", decision: decision(true) }
  })
  const state = new AnalyticsAccount(request)
  await state.activate(session("a")); expect(state.eligible()).toBe(true)
  const save = state.choose(false); expect(state.eligible()).toBe(false)
  await expect(save).rejects.toThrow("offline")
  await state.refresh(); expect(state.eligible()).toBe(false)
  const reloaded = new AnalyticsAccount(request)
  await reloaded.activate(session("a")); expect(reloaded.eligible()).toBe(false)
})

it("a new approval supersedes a legacy refusal only for that account", async () => {
  localStorage.setItem("aquilla:analyticsEnabled", "false")
  const request = vi.fn(async (jwt: string) => ({ accountId: jwt, decision: decision(true) }))
  const state = new AnalyticsAccount(request)
  await state.activate(session("a")); expect(state.eligible()).toBe(false)
  await state.choose(true); expect(state.eligible()).toBe(true)
  await state.activate(session("b")); expect(state.eligible()).toBe(false)
  await state.activate(session("a")); expect(state.eligible()).toBe(true)
})

it("keeps a verified lease without restarting, but closes it on expiry or refresh failure", async () => {
  const request = vi.fn(async () => ({ accountId: "a", decision: decision(true) }))
  const state = new AnalyticsAccount(request)
  await state.activate(session("a"))
  const generation = state.getSnapshot().generation
  await state.revalidate()
  expect(state.getSnapshot().generation).toBe(generation)
  expect(state.eligible()).toBe(true)
  const now = Date.now()
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 75_001)
  expect(state.eligible()).toBe(false)
  clock.mockRestore()
  request.mockRejectedValueOnce(new Error("unavailable"))
  await state.revalidate()
  expect(state.eligible()).toBe(false)
  expect(state.getSnapshot().error).toBe(true)
})

it("immediately suppresses a cross-tab refusal and never applies another account's hint", async () => {
  const state = new AnalyticsAccount(async jwt => ({ accountId: jwt, decision: decision(true) }))
  await state.activate(session("a"))
  state.receiveDecisionHint("b", true)
  expect(state.eligible()).toBe(true)
  state.receiveDecisionHint("a", true)
  expect(state.eligible()).toBe(false)
  await state.refresh()
  expect(state.eligible()).toBe(false)
})

it("cannot collect offline, hidden, or when persisted consent storage is unreadable", async () => {
  const state = new AnalyticsAccount(async jwt => ({ accountId: jwt, decision: decision(true) }))
  await state.activate(session("a"))
  expect(state.eligible()).toBe(true)
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
  expect(state.eligible()).toBe(false)
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true)
  vi.spyOn(document, "hidden", "get").mockReturnValue(true)
  expect(state.eligible()).toBe(false)
  vi.spyOn(document, "hidden", "get").mockReturnValue(false)
  vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError") })
  await state.refresh()
  expect(state.eligible()).toBe(false)
})
