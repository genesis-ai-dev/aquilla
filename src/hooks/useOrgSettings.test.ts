// Tests for useOrgSettings — specifically the canExport / exportMinRole logic (FRO-253).
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
import type { OrgSettingsResponse } from "@/lib/sync/org-settings"

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
