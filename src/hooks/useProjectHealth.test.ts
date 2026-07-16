// AQU-190 — unit tests for useProjectHealth.
//
// The critical invariant tested here: useProjectHealth MUST mint a sync-token
// via `makeSyncTokenFetcher` (which calls POST /api/v2/sync-token and returns a
// JWT with aud=sync). Passing the raw session.jwt is WRONG — the sync-worker's
// verifyTokenForProject rejects it with 401 "invalid token signature" because
// the auth-worker JWT does not have aud=sync.
//
// These tests fail if someone reverts the fix to `async () => session.jwt`.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

// --- module mocks (hoisted before imports) ---

// We capture the minted-token getToken function that useHealthRollup receives.
let capturedGetToken: (() => Promise<string | null>) | undefined

vi.mock("./useHealthRollup", () => ({
  useHealthRollup: vi.fn((args: { getToken?: () => Promise<string | null>; projectHealth?: number; loading?: boolean; [key: string]: unknown }) => {
    capturedGetToken = args.getToken
    return { projectHealth: 42, fileHealth: new Map(), loading: false, error: null }
  }),
}))

// Track calls to makeSyncTokenFetcher so we can assert it is called (not session.jwt).
const mockFetcher = vi.fn(async () => "minted-sync-token")
const makeSyncTokenFetcherMock = vi.fn(() => mockFetcher)

vi.mock("@/lib/sync/sync-token", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  makeSyncTokenFetcher: (...args: any[]) => (makeSyncTokenFetcherMock as (...a: unknown[]) => typeof mockFetcher)(...args),
}))

vi.mock("./useFrontierSession", () => ({
  useFrontierSession: vi.fn(() => ({
    session: { jwt: "raw-auth-jwt", username: "alice" },
  })),
}))

// --- import after mocks ---
import { useProjectHealth } from "./useProjectHealth"

describe("useProjectHealth (AQU-190)", () => {
  beforeEach(() => {
    capturedGetToken = undefined
    makeSyncTokenFetcherMock.mockClear()
    mockFetcher.mockClear()
  })

  it("calls makeSyncTokenFetcher with the projectId and sentinel __project__ fileId", async () => {
    const { result } = renderHook(() => useProjectHealth("proj-abc"))

    await waitFor(() => expect(result.current.projectHealth).toBe(42))

    // makeSyncTokenFetcher must have been called — raw jwt bypass would skip this.
    expect(makeSyncTokenFetcherMock).toHaveBeenCalled()

    const call = makeSyncTokenFetcherMock.mock.calls[0] as unknown as [() => string | null, string, string]
    const [getJwt, projectId, fileId] = call
    expect(projectId).toBe("proj-abc")
    // The sentinel must match the established convention used across the codebase.
    expect(fileId).toBe("__project__")
    // The jwt accessor must return the session jwt.
    expect(getJwt()).toBe("raw-auth-jwt")
  })

  it("passes the MINTED token (not session.jwt) to useHealthRollup via getToken", async () => {
    renderHook(() => useProjectHealth("proj-abc"))

    await waitFor(() => expect(capturedGetToken).toBeDefined())

    // Calling the getToken that useHealthRollup receives must call our mock fetcher,
    // NOT return the raw auth JWT directly.
    const token = await capturedGetToken!()

    // Must be the value our mock fetcher returned, not the raw auth-worker JWT.
    expect(token).toBe("minted-sync-token")
    expect(token).not.toBe("raw-auth-jwt")
    // The mock fetcher (representing the actual sync-token mint) was called.
    expect(mockFetcher).toHaveBeenCalled()
  })

  it("returns null projectHealth when projectId is null (no fetch, no mint)", () => {
    const { result } = renderHook(() => useProjectHealth(null))

    // getToken should be undefined — there's nothing to mint for a null projectId.
    expect(capturedGetToken).toBeUndefined()
    // makeSyncTokenFetcher should not be called when projectId is null.
    expect(makeSyncTokenFetcherMock).not.toHaveBeenCalled()
    // Hook returns stable shape.
    expect(result.current.loading).toBe(false)
  })

  it("reuses the same fetcher instance for the same projectId across re-renders (no stampede)", async () => {
    // Re-rendering the hook with the same projectId must not call makeSyncTokenFetcher again.
    const { rerender } = renderHook(() => useProjectHealth("proj-xyz"))
    await waitFor(() => expect(makeSyncTokenFetcherMock).toHaveBeenCalledTimes(1))

    rerender()
    rerender()

    // Still only one fetcher built — cache hit.
    expect(makeSyncTokenFetcherMock).toHaveBeenCalledTimes(1)
  })
})
