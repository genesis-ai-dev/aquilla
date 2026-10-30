// AQU-2093 — posthog-js loads after the page, not with it.
//
// WHY: the library is ~280 KB of the first load, which on a slow connection
// is seconds before anyone can work. Deferring it must not lose anything: calls
// made before it arrives are delivered once it does, in order, and an error
// thrown in those first seconds is still reported.

import { afterEach, describe, expect, it, vi } from "vitest"

const calls: string[] = []
const fake = {
  init: vi.fn((key: string) => { calls.push(`init:${key}`) }),
  register: vi.fn(() => { calls.push("register") }),
  capture: vi.fn((event: string) => { calls.push(`capture:${event}`) }),
  identify: vi.fn((id: string) => { calls.push(`identify:${id}`) }),
  captureException: vi.fn((error: unknown) => { calls.push(`exception:${(error as Error).message}`) }),
  get_session_replay_url: vi.fn(() => "https://replay"),
}
vi.mock("posthog-js", () => ({ default: fake }))
// test-setup.ts stubs this module for every other test; this one is about it.
vi.unmock("@/lib/posthog")

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  calls.length = 0
})

describe("deferred posthog (AQU-2093)", () => {
  it("queues calls until the library has loaded, then delivers them in order", async () => {
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test")
    const { default: posthog } = await import("./posthog")

    posthog.capture("early_event")
    posthog.identify("user-1")
    expect(posthog.get_session_replay_url()).toBeUndefined()
    expect(calls).toEqual([])

    await vi.waitFor(() => expect(calls).toContain("identify:user-1"))
    expect(calls).toEqual(["init:phc_test", "register", "capture:early_event", "identify:user-1"])

    posthog.capture("late_event")
    expect(calls.at(-1)).toBe("capture:late_event")
    expect(posthog.get_session_replay_url()).toBe("https://replay")
  })

  it("reports an error thrown before the library arrived", async () => {
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test")
    await import("./posthog")

    window.dispatchEvent(new ErrorEvent("error", { error: new Error("boot failure") }))
    expect(calls).toEqual([])

    await vi.waitFor(() => expect(calls).toContain("exception:boot failure"))
  })

  it("never loads the library without a key", async () => {
    vi.stubEnv("VITE_POSTHOG_KEY", "")
    const { default: posthog } = await import("./posthog")
    posthog.capture("ignored")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.init).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})
