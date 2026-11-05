import { afterEach, expect, it, vi } from "vitest"
const control = vi.hoisted(() => ({ state: { generation: 0, accountId: null as string | null }, allowed: false, listeners: new Set<() => void>() }))
vi.mock("./analytics-account", () => ({ analyticsAccount: {
  getSnapshot: () => control.state, eligible: () => control.allowed,
  subscribe: (fn: () => void) => { control.listeners.add(fn) },
} }))
vi.unmock("@/lib/posthog")
function select(accountId: string | null, allowed: boolean) {
  control.state = { generation: control.state.generation + 1, accountId }
  control.allowed = allowed
  for (const fn of control.listeners) fn()
}
const beaconDescriptor = Object.getOwnPropertyDescriptor(navigator, "sendBeacon")
afterEach(() => { if (beaconDescriptor) Object.defineProperty(navigator, "sendBeacon", beaconDescriptor); else Reflect.deleteProperty(navigator, "sendBeacon"); select(null, false); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it("the real SDK sends nothing before approval or after revocation, including failed-request retries", async () => {
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_local_privacy_test")
  vi.stubEnv("VITE_POSTHOG_HOST", "http://127.0.0.1:9999")
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36")
  const sent: string[] = []
  const bodies: string[] = []
  const fetchMock = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
    bodies.push(String(options?.body ?? ""))
    sent.push(String(url))
    return new Response("{}", { status: 503 })
  })
  vi.stubGlobal("fetch", fetchMock)
  const { PostHog } = await import("posthog-js/full/no-external")
  // A DOM test environment is intentionally filtered as automation by the SDK.
  // Exercise its transport instead of accepting that filter as consent evidence.
  vi.spyOn(PostHog.prototype as unknown as { _is_bot: () => boolean }, "_is_bot").mockReturnValue(false)
  vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function (this: XMLHttpRequest, body) {
    bodies.push(String(body ?? ""))
    sent.push("XHR")
    Object.defineProperty(this, "status", { configurable: true, value: 503 })
    Object.defineProperty(this, "readyState", { configurable: true, value: 4 })
    this.onreadystatechange?.(new Event("readystatechange"))
  })
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => { sent.push("beacon"); return true } })
  const { default: analytics } = await import("./posthog")
  analytics.capture("unapproved sentinel")
  expect(sent).toEqual([])
  expect(Object.keys(localStorage).filter(k => k.startsWith("ph_"))).toEqual([])
  select("a", true)
  await vi.waitFor(() => expect(analytics.get_session_replay_url()).toBeDefined())
  vi.useFakeTimers()
  analytics.capture("approved sentinel", {}, { send_instantly: true })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(sent.length).toBeGreaterThan(0)
  expect(bodies.join("\n")).toContain("approved sentinel")
  select("b", false)
  const afterWithdrawal = sent.length
  analytics.capture("declined sentinel")
  await vi.advanceTimersByTimeAsync(120_000)
  expect(sent).toHaveLength(afterWithdrawal)
  select(null, false)
  window.dispatchEvent(new Event("pagehide"))
  await vi.advanceTimersByTimeAsync(10_000)
  expect(sent).toHaveLength(afterWithdrawal)
})
