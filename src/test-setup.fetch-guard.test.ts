import { describe, expect, it, vi } from "vitest"
import {
  OffMachineRequestError,
  createOffMachineFetchGuard,
  takeOffMachineRequestViolations,
} from "./test-setup.fetch-guard"

/**
 * Self-test for the AQU-1277 guard. The negative case the issue asks for — an
 * unmocked `fetch` to production identity — is asserted against the *installed*
 * global guard at the bottom, so this file fails if `src/test-setup.ts` ever
 * stops installing it.
 *
 * Every blocked call also records a violation that `test-setup`'s `afterEach`
 * re-raises, so each test here drains the record once it has asserted on it.
 */
describe("createOffMachineFetchGuard", () => {
  const passThrough = () => {
    const realFetch = vi.fn(async () => new Response("ok"))
    return { realFetch, guard: createOffMachineFetchGuard(realFetch as unknown as typeof fetch) }
  }

  it.each([
    ["http://localhost:3000/api/v2/projects"],
    ["http://127.0.0.1:18902/identity/api/v2/projects"],
    ["https://localhost:8787/sync/events"],
    ["http://[::1]:5173/version.json"],
    ["/api/v2/projects"], // relative — resolves against happy-dom's localhost page
    ["data:text/plain,hello"],
  ])("lets %s through to the real fetch", async (url) => {
    const { realFetch, guard } = passThrough()
    await guard(url)
    expect(realFetch).toHaveBeenCalledOnce()
    expect(takeOffMachineRequestViolations()).toEqual([])
  })

  it("blocks production identity and never calls the real fetch", () => {
    const { realFetch, guard } = passThrough()
    expect(() => guard("https://api.aquilla.app/identity/api/v2/projects")).toThrow(
      OffMachineRequestError,
    )
    expect(realFetch).not.toHaveBeenCalled()
    expect(takeOffMachineRequestViolations()).toHaveLength(1)
  })

  it("names the method, the URL and the test in the error", () => {
    const { realFetch } = passThrough()
    const named = createOffMachineFetchGuard(
      realFetch as unknown as typeof fetch,
      () => "src/components/MembersPanel.test.tsx › loads members",
    )
    expect(() =>
      named("https://api.aquilla.app/identity/api/v2/projects/p1/settings", { method: "patch" }),
    ).toThrow(
      /PATCH https:\/\/api\.aquilla\.app\/identity\/api\/v2\/projects\/p1\/settings[\s\S]*MembersPanel\.test\.tsx › loads members/,
    )
    expect(takeOffMachineRequestViolations()).toHaveLength(1)
  })

  it("reads method and URL off a Request object", () => {
    const { guard } = passThrough()
    const request = new Request("https://api.aquilla.app/identity/api/v2/orgs/42/members-matrix", {
      method: "POST",
    })
    expect(() => guard(request)).toThrow(/POST .*orgs\/42\/members-matrix/)
    expect(takeOffMachineRequestViolations()).toHaveLength(1)
  })

  it("treats an unparseable URL as off-machine rather than letting it through", () => {
    const { realFetch, guard } = passThrough()
    expect(() => guard("http://")).toThrow(OffMachineRequestError)
    expect(realFetch).not.toHaveBeenCalled()
    expect(takeOffMachineRequestViolations()).toHaveLength(1)
  })
})

describe("the guard installed by test-setup", () => {
  // The exact negative case from the AQU-1277 acceptance criteria: an unmocked
  // fetch to production identity must fail the test instead of being sent.
  it("blocks an unmocked fetch to production identity", () => {
    expect(() => fetch("https://api.aquilla.app/identity/api/v2/projects")).toThrow(
      /Blocked off-machine request/,
    )
    expect(takeOffMachineRequestViolations()).toEqual([
      expect.stringContaining("GET https://api.aquilla.app/identity/api/v2/projects"),
    ])
  })

  it("stays out of the way of a test that mocks fetch itself", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))
    await expect(fetch("https://api.aquilla.app/identity/api/v2/projects")).resolves.toBeInstanceOf(
      Response,
    )
    expect(takeOffMachineRequestViolations()).toEqual([])
    vi.restoreAllMocks()
  })
})
