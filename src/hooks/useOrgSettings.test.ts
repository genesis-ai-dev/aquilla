import { describe, it, expect, vi, afterEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { useOrgSettings } from "./useOrgSettings"
import * as restClient from "@/lib/sync/org-settings"
import type { OrgSettingsResponse, OrgPatchResult } from "@/lib/sync/org-settings"
import type { TranslationRule } from "@/lib/parsers/types"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "test-jwt", username: "ryder" } }),
}))

afterEach(() => vi.restoreAllMocks())

const rule = (id: string): TranslationRule => ({
  id,
  name: `Rule ${id}`,
  description: `desc ${id}`,
  severity: "major",
  source: "user",
  scope: "org",
  check: { type: "source-requires-target", sourcePattern: "God", targetPattern: "Dieu" },
  enabled: true,
  createdAt: "2026-06-01T00:00:00Z",
})

const serverTruth = (): OrgSettingsResponse => ({
  orgId: 1,
  settings: { rules: [rule("r1")] },
  version: 3,
  updatedAt: "2026-06-01T00:00:00Z",
  updatedBy: 9,
})

function mockFetch() {
  return vi
    .spyOn(restClient, "fetchOrgSettings")
    .mockImplementation(async () => serverTruth())
}

describe("useOrgSettings — write floor matches server (FRO-255 follow-up)", () => {
  // The server enforces SETTINGS_WRITE_MIN_ROLE = MAINTAINER (600) in
  // auth-worker/src/routes/org-settings.ts. If the client floor drifts below
  // that, below-floor users see editable controls and their writes 403
  // silently — the original FRO-255 bug.
  it("canEdit is false at PROJECT_LEAD (500) and true at MAINTAINER (600)", async () => {
    mockFetch()

    const lead = renderHook(() => useOrgSettings(1, 500))
    await waitFor(() => expect(lead.result.current.hasFetched).toBe(true))
    expect(lead.result.current.canEdit).toBe(false)
    // Project leads can still *request* promotion (server floor is 500 there).
    expect(lead.result.current.canRequestPromotion).toBe(true)

    const maintainer = renderHook(() => useOrgSettings(1, 600))
    await waitFor(() => expect(maintainer.result.current.hasFetched).toBe(true))
    expect(maintainer.result.current.canEdit).toBe(true)
  })

  it("below-floor patch is blocked with no optimistic write and no network write", async () => {
    const fetchSpy = mockFetch()
    const patchSpy = vi.spyOn(restClient, "patchOrgSettings")

    const { result } = renderHook(() => useOrgSettings(1, 500))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))

    let outcome: Awaited<ReturnType<typeof result.current.patch>> | undefined
    await act(async () => {
      outcome = await result.current.patch({ rules: [rule("r1"), rule("r2")] })
    })

    expect(outcome).toEqual({ kind: "blocked" })
    // No optimistic apply: a synced below-floor user must never see a phantom edit.
    expect(result.current.orgRules.map((r) => r.id)).toEqual(["r1"])
    expect(patchSpy).not.toHaveBeenCalled()
    // Only the initial load fetched; the blocked path never re-fetches.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe("useOrgSettings — rollback on rejected writes (FRO-255 follow-up)", () => {
  it("server-forbidden write rolls back the optimistic state to server truth", async () => {
    mockFetch()
    let resolvePatch!: (v: OrgPatchResult) => void
    vi.spyOn(restClient, "patchOrgSettings").mockImplementation(
      () => new Promise((res) => { resolvePatch = res }),
    )

    const { result } = renderHook(() => useOrgSettings(1, 600))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))

    let pending!: Promise<OrgPatchResult | { kind: "blocked" }>
    act(() => {
      pending = result.current.patch({ rules: [rule("r1"), rule("r2")] })
    })

    // The optimistic write IS applied for an authorized caller…
    await waitFor(() =>
      expect(result.current.orgRules.map((r) => r.id)).toEqual(["r1", "r2"]),
    )

    // …then the server rejects it (e.g. role was demoted after the page loaded).
    await act(async () => {
      resolvePatch({ kind: "forbidden" })
      await pending
    })

    expect(await pending).toEqual({ kind: "forbidden" })
    // The rejected value must not linger locally — roll back to server truth.
    await waitFor(() =>
      expect(result.current.orgRules.map((r) => r.id)).toEqual(["r1"]),
    )
    expect(result.current.version).toBe(3)
  })

  it("server-error write rolls back the optimistic state to server truth", async () => {
    mockFetch()
    vi.spyOn(restClient, "patchOrgSettings").mockResolvedValue({
      kind: "error",
      status: 500,
      message: "boom",
    })

    const { result } = renderHook(() => useOrgSettings(1, 600))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))

    let outcome: OrgPatchResult | { kind: "blocked" } | undefined
    await act(async () => {
      outcome = await result.current.patch({ rules: [rule("r1"), rule("r2")] })
    })

    expect(outcome).toEqual({ kind: "error", status: 500, message: "boom" })
    await waitFor(() =>
      expect(result.current.orgRules.map((r) => r.id)).toEqual(["r1"]),
    )
  })

  it("successful write applies the server-confirmed value", async () => {
    mockFetch()
    const confirmed: OrgSettingsResponse = {
      orgId: 1,
      settings: { rules: [rule("r1"), rule("r2")] },
      version: 4,
      updatedAt: "2026-06-09T00:00:00Z",
      updatedBy: 9,
    }
    vi.spyOn(restClient, "patchOrgSettings").mockResolvedValue({
      kind: "ok",
      value: confirmed,
    })

    const { result } = renderHook(() => useOrgSettings(1, 600))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))

    await act(async () => {
      await result.current.patch({ rules: [rule("r1"), rule("r2")] })
    })

    expect(result.current.orgRules.map((r) => r.id)).toEqual(["r1", "r2"])
    expect(result.current.version).toBe(4)
  })
})
