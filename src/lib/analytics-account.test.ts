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
