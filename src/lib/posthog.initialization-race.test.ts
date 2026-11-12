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
vi.unmock("posthog-js/full/no-external")
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
it("cannot finish initializing a previous account after a switch", async () => {
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_test")
  const { PostHog } = await import("posthog-js/full/no-external")
  const init = vi.spyOn(PostHog.prototype, "init").mockImplementation(function (this: InstanceType<typeof PostHog>) { return this })
  let finish!: (value: ArrayBuffer) => void
  const digest = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => new Promise<ArrayBuffer>(resolve => { finish = resolve }))
  try {
    await import("./posthog")
    change("a", true)
    await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce())
    change("b", true)
    await vi.waitFor(() => expect(init).toHaveBeenCalledOnce())
    finish(new ArrayBuffer(32))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(init).toHaveBeenCalledOnce()
  } finally { digest.mockRestore(); init.mockRestore() }
})
