// Tests for useOrgSettings:
//   • canExport / exportMinRole derivation (FRO-253)
//   • write-floor alignment with the server + optimistic-write rollback
//     (FRO-255 follow-up, org-settings-floor trace)
//
// SWARM-TODO click-path coverage:
//   1. viewer in an unset org → canExport=true (non-breaking default).
//   2. org sets floor=OWNER (700) → maintainer (600) canExport=false.
//   3. org viewer with direct project MAINTAINER grant → canExport=true under floor=MAINTAINER.
//
// Note: these are unit tests against the hook's derivation logic only (no
// actual network calls). The server-route integration is tested in the
// sync-worker tests.

import { describe, it, expect, vi, afterEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { useOrgSettings } from "./useOrgSettings"
import * as restClient from "@/lib/sync/org-settings"
import type { OrgSettingsResponse, OrgPatchResult } from "@/lib/sync/org-settings"
import type { TranslationRule } from "@/lib/parsers/types"

// Mock the session — always logged in with a JWT.
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "test-jwt", username: "tester" } }),
}))

// Mock fetchOrgSettings and patchOrgSettings so we control responses.
let mockFetchResponse: OrgSettingsResponse | null = null

vi.mock("@/lib/sync/org-settings", () => ({
  fetchOrgSettings: vi.fn(async () => mockFetchResponse),
  patchOrgSettings: vi.fn(async () => ({ kind: "ok", value: mockFetchResponse! })),
  postPromotionRequest: vi.fn(),
}))

function makeResponse(exportMinRole?: number): OrgSettingsResponse {
  return {
    orgId: 1,
    settings: exportMinRole !== undefined ? { exportMinRole } : {},
    version: 1,
    updatedAt: "2026-01-01T00:00:00Z",
    updatedBy: 1,
  }
}

afterEach(() => {
  vi.clearAllMocks()
  mockFetchResponse = null
})

describe("useOrgSettings — canExport non-breaking default (BLOCKER fix)", () => {
  it("viewer (100) in an org that has NOT set exportMinRole → canExport=true", async () => {
    // Non-breaking default: if the org hasn't configured a floor, no client gate.
    mockFetchResponse = makeResponse() // no exportMinRole key
    const orgRoleLevel = 100 // viewer
    const { result } = renderHook(() => useOrgSettings(1, orgRoleLevel))

    await waitFor(() => expect(result.current.hasFetched).toBe(true))

    expect(result.current.exportMinRole).toBeNull() // not set
    expect(result.current.canExport).toBe(true) // ALLOW — non-breaking default
  })

  it("contributor (400) in an org that has NOT set exportMinRole → canExport=true", async () => {
    mockFetchResponse = makeResponse()
    const { result } = renderHook(() => useOrgSettings(1, 400))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))
    expect(result.current.canExport).toBe(true)
  })
})

describe("useOrgSettings — explicit floor gating (FRO-253)", () => {
  it("org sets floor=OWNER (700), maintainer (600) → canExport=false", async () => {
    mockFetchResponse = makeResponse(700) // owner-only
    const { result } = renderHook(() => useOrgSettings(1, 600))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))

    expect(result.current.exportMinRole).toBe(700)
    expect(result.current.canExport).toBe(false)
  })

  it("org sets floor=OWNER (700), owner (700) → canExport=true", async () => {
    mockFetchResponse = makeResponse(700)
    const { result } = renderHook(() => useOrgSettings(1, 700))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))
    expect(result.current.canExport).toBe(true)
  })

  it("org sets floor=MAINTAINER (600), contributor (400) → canExport=false", async () => {
    mockFetchResponse = makeResponse(600)
    const { result } = renderHook(() => useOrgSettings(1, 400))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))
    expect(result.current.canExport).toBe(false)
  })

  it("org sets floor=MAINTAINER (600), maintainer (600) → canExport=true", async () => {
    mockFetchResponse = makeResponse(600)
    const { result } = renderHook(() => useOrgSettings(1, 600))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))
    expect(result.current.canExport).toBe(true)
  })
})

describe("useOrgSettings — project-resolved role (WARN fix: AD-12 max-wins)", () => {
  it("org viewer (100) + direct project MAINTAINER grant (600) → canExport=true under floor=MAINTAINER", async () => {
    // FRO-253 WARN: compare project-resolved role, not org role.
    // org VIEWER (100) + direct project MAINTAINER grant → project-resolved = 600.
    mockFetchResponse = makeResponse(600) // floor = MAINTAINER
    const orgRoleLevel = 100       // viewer in org
    const projectRoleLevel = 600   // maintainer on this project (direct grant)

    const { result } = renderHook(() =>
      useOrgSettings(1, orgRoleLevel, projectRoleLevel),
    )
    await waitFor(() => expect(result.current.hasFetched).toBe(true))

    // Should pass: project-resolved (600) >= floor (600)
    expect(result.current.canExport).toBe(true)
  })

  it("org viewer (100) without project grant → canExport=false under floor=MAINTAINER", async () => {
    mockFetchResponse = makeResponse(600)
    const orgRoleLevel = 100
    const projectRoleLevel = 100   // no better grant

    const { result } = renderHook(() =>
      useOrgSettings(1, orgRoleLevel, projectRoleLevel),
    )
    await waitFor(() => expect(result.current.hasFetched).toBe(true))

    expect(result.current.canExport).toBe(false)
  })

  it("falls back to orgRoleLevel when projectRoleLevel is not provided", async () => {
    mockFetchResponse = makeResponse(600)
    // org maintainer (600), no explicit project role passed → should use org role
    const { result } = renderHook(() => useOrgSettings(1, 600))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))
    expect(result.current.canExport).toBe(true)
  })
})

describe("useOrgSettings — optimistic pre-fetch behavior", () => {
  it("allows canExport=true before settings are fetched (optimistic)", async () => {
    // The fetch never resolves during this test (we check the immediate state).
    let resolveOnce!: (v: OrgSettingsResponse) => void
    const { fetchOrgSettings } = await import("@/lib/sync/org-settings")
    vi.mocked(fetchOrgSettings).mockImplementationOnce(
      () => new Promise((res) => { resolveOnce = res }),
    )

    const { result } = renderHook(() => useOrgSettings(1, 100))

    // Before fetch resolves: canExport should be optimistically true
    expect(result.current.hasFetched).toBe(false)
    expect(result.current.canExport).toBe(true)

    // Resolve the fetch with a restrictive floor — canExport should now flip.
    act(() => { resolveOnce(makeResponse(700)) })
    await waitFor(() => expect(result.current.hasFetched).toBe(true))
    // org viewer (100) vs floor (700)
    expect(result.current.canExport).toBe(false)
  })
})

describe("useOrgSettings — garbage exportMinRole in server response", () => {
  it("treats a garbage server value (9999) as not-set → canExport=true for viewer", async () => {
    // Server coerced garbage — resolveExportFloor would reject it, but even if
    // it leaks through, the client should treat it as null (not-set).
    mockFetchResponse = { ...makeResponse(), settings: { exportMinRole: 9999 } }
    const { result } = renderHook(() => useOrgSettings(1, 100))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))
    // 9999 is out-of-range → treated as null → no client gate
    expect(result.current.exportMinRole).toBeNull()
    expect(result.current.canExport).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// FRO-255 follow-up (org-settings-floor trace): write floor + rollback
// ───────────────────────────────────────────────────────────────────────────

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

describe("useOrgSettings — write floor matches server (FRO-255 follow-up)", () => {
  // The server enforces SETTINGS_WRITE_MIN_ROLE = MAINTAINER (600) in
  // auth-worker/src/routes/org-settings.ts. If the client floor drifts below
  // that, below-floor users see editable controls and their writes 403
  // silently — the original FRO-255 bug.
  it("canEdit is false at PROJECT_LEAD (500) and true at MAINTAINER (600)", async () => {
    mockFetchResponse = serverTruth()

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
    mockFetchResponse = serverTruth()

    const { result } = renderHook(() => useOrgSettings(1, 500))
    await waitFor(() => expect(result.current.hasFetched).toBe(true))

    let outcome: Awaited<ReturnType<typeof result.current.patch>> | undefined
    await act(async () => {
      outcome = await result.current.patch({ rules: [rule("r1"), rule("r2")] })
    })

    expect(outcome).toEqual({ kind: "blocked" })
    // No optimistic apply: a synced below-floor user must never see a phantom edit.
    expect(result.current.orgRules.map((r) => r.id)).toEqual(["r1"])
    expect(vi.mocked(restClient.patchOrgSettings)).not.toHaveBeenCalled()
    // Only the initial load fetched; the blocked path never re-fetches.
    expect(vi.mocked(restClient.fetchOrgSettings)).toHaveBeenCalledTimes(1)
  })
})

describe("useOrgSettings — rollback on rejected writes (FRO-255 follow-up)", () => {
  it("server-forbidden write rolls back the optimistic state to server truth", async () => {
    mockFetchResponse = serverTruth()
    let resolvePatch!: (v: OrgPatchResult) => void
    vi.mocked(restClient.patchOrgSettings).mockImplementationOnce(
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
    mockFetchResponse = serverTruth()
    vi.mocked(restClient.patchOrgSettings).mockResolvedValueOnce({
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
    mockFetchResponse = serverTruth()
    const confirmed: OrgSettingsResponse = {
      orgId: 1,
      settings: { rules: [rule("r1"), rule("r2")] },
      version: 4,
      updatedAt: "2026-06-09T00:00:00Z",
      updatedBy: 9,
    }
    vi.mocked(restClient.patchOrgSettings).mockResolvedValueOnce({
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
