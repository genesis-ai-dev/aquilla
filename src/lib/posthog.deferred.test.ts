import { afterEach, expect, it, vi } from "vitest"
const harness = vi.hoisted(() => ({
  state: { generation: 0, accountId: null as string | null, username: null as string | null }, approved: false,
  listeners: new Set<() => void>(), instances: [] as Array<{ capture: ReturnType<typeof vi.fn>; identify: ReturnType<typeof vi.fn>; shutdown: ReturnType<typeof vi.fn> }>,
}))
vi.mock("./analytics-account", () => ({ analyticsAccount: {
  getSnapshot: () => harness.state,
  eligible: () => harness.approved,
  subscribe: (fn: () => void) => { harness.listeners.add(fn) },
  suspend: () => { harness.approved = false; harness.state.generation++; for (const fn of harness.listeners) fn() },
} }))
vi.mock("posthog-js/full/no-external", () => ({ PostHog: class {
  __loaded = true
  rateLimiter = { isServerRateLimited: vi.fn(() => false) }
  init = vi.fn()
  register = vi.fn()
  identify = vi.fn()
  capture = vi.fn()
  captureException = vi.fn()
  startSessionRecording = vi.fn()
  stopSessionRecording = vi.fn()
  shutdown = vi.fn(() => { expect(this.rateLimiter.isServerRateLimited()).toBe(true) })
  get_session_replay_url = () => "replay"
  constructor() { harness.instances.push(this) }
} }))
vi.unmock("@/lib/posthog")
function change(accountId: string | null, approved: boolean) {
  harness.state = { generation: harness.state.generation + 1, accountId, username: accountId }
  harness.approved = approved
  for (const listener of harness.listeners) listener()
}
afterEach(() => {
  change(null, false)
  vi.unstubAllEnvs(); vi.resetModules()
  harness.listeners.clear(); harness.instances.length = 0
})
it("drops preapproval events, isolates old callbacks and prevents teardown flushing across accounts", async () => {
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_test")
  const { default: analytics } = await import("./posthog")
  analytics.capture("unapproved"); analytics.captureException(new Error("unapproved"))
  expect(harness.instances).toHaveLength(0)
  change("a", true)
  await vi.waitFor(() => expect(harness.instances).toHaveLength(1))
  const a = harness.instances[0]
  const oldOperation = analytics.scope()
  analytics.scope(undefined, "inactive").capture("inactive upload")
  expect(a.capture).toHaveBeenCalledTimes(1)
  analytics.capture("approved")
  expect(a.capture.mock.calls.map((args: unknown[]) => args[0])).toEqual(["$pageview", "approved"])
  change("b", false)
  analytics.capture("declined"); oldOperation.capture("late A")
  expect(a.shutdown).toHaveBeenCalledOnce()
  expect(a.capture).toHaveBeenCalledTimes(2)
  expect(analytics.get_session_replay_url()).toBeUndefined()
  change("b", true)
  await vi.waitFor(() => expect(harness.instances).toHaveLength(2))
  const b = harness.instances[1]
  oldOperation.capture("late A after B approves")
  expect(b.capture).toHaveBeenCalledTimes(1)
  expect(a.identify.mock.calls[0][0]).not.toBe(b.identify.mock.calls[0][0])
  change(null, false)
  expect(b.shutdown).toHaveBeenCalledOnce()
})
it("does not initialize without a configured project key", async () => {
  vi.stubEnv("VITE_POSTHOG_KEY", "")
  const { default: analytics } = await import("./posthog")
  change("a", true); analytics.capture("ignored")
  expect(harness.instances).toHaveLength(0)
})
