// Tests for the shared audio sync-token cache.
//
// EditorRow mounts two useCellAudio instances per row (recorded audio +
// generated voice). Before this fix, each `makeAudioSyncTokenFetcher()` call
// built its own private cache, so two rows (or two hook instances) playing
// audio for the same (projectId, fileId) each minted their own token instead
// of sharing one — a 500-row file could mint up to 1000 independent tokens.
// The cache now lives at module scope so every fetcher instance shares one
// mint. That module-level cache also outlives a logout/login within the same
// page session, so these tests also encode the safety requirement: a token
// minted under one session identity must never be served back under another.

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { FrontierSession } from "@/lib/frontier/types"

vi.mock("@/lib/sync/sync-token", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sync/sync-token")>("@/lib/sync/sync-token")
  return {
    ...actual,
    fetchSyncToken: vi.fn(),
  }
})

import { fetchSyncToken } from "@/lib/sync/sync-token"
import { makeAudioSyncTokenFetcher, __resetAudioSyncTokenCacheForTests } from "./sync-token-fetcher"

const mockedFetchSyncToken = vi.mocked(fetchSyncToken)

function makeSession(overrides: Partial<FrontierSession> = {}): FrontierSession {
  return { jwt: "jwt-alice", username: "alice", createdAt: "", ...overrides }
}

const ROLE = { level: 400, name: "contributor", source: "creator" as const }

beforeEach(() => {
  __resetAudioSyncTokenCacheForTests()
  mockedFetchSyncToken.mockReset()
  let call = 0
  mockedFetchSyncToken.mockImplementation(async () => ({
    token: `minted-${++call}`,
    expiresIn: 900,
    role: ROLE,
  }))
})

describe("makeAudioSyncTokenFetcher — shared module-level cache", () => {
  it("shares a single mint across independent fetcher instances for the same session", async () => {
    // Simulates two useCellAudio instances on the same row (recorded +
    // generated voice), each building its own fetcher via useMemo, both
    // requesting the same (projectId, fileId).
    const session = makeSession()
    const fetcherA = makeAudioSyncTokenFetcher(() => session)
    const fetcherB = makeAudioSyncTokenFetcher(() => session)

    const tokenA = await fetcherA("proj-1", "file-1")
    const tokenB = await fetcherB("proj-1", "file-1")

    expect(mockedFetchSyncToken).toHaveBeenCalledTimes(1)
    expect(tokenA).toBe(tokenB)
  })

  it("mints separately for different (projectId, fileId) pairs under the same session", async () => {
    const session = makeSession()
    const fetcher = makeAudioSyncTokenFetcher(() => session)

    await fetcher("proj-1", "file-1")
    await fetcher("proj-1", "file-2")

    expect(mockedFetchSyncToken).toHaveBeenCalledTimes(2)
  })

  it("does NOT reuse a token minted under a different session identity", async () => {
    // Correctness constraint: the cache is module-level and persists across a
    // logout/login (or multi-account switch), unlike the old per-instance
    // cache which died with the unmounted hook. Alice's cached token for
    // (proj-1, file-1) must never be handed to Bob just because he asks for
    // the same project/file.
    const alice = makeSession({ jwt: "jwt-alice", username: "alice" })
    const bob = makeSession({ jwt: "jwt-bob", username: "bob" })

    const fetcherAlice = makeAudioSyncTokenFetcher(() => alice)
    const tokenAlice = await fetcherAlice("proj-1", "file-1")

    const fetcherBob = makeAudioSyncTokenFetcher(() => bob)
    const tokenBob = await fetcherBob("proj-1", "file-1")

    expect(mockedFetchSyncToken).toHaveBeenCalledTimes(2)
    expect(tokenBob).not.toBe(tokenAlice)
    // Bob's mint must go out under his own JWT, not Alice's cached identity.
    expect(mockedFetchSyncToken.mock.calls[1][0]).toBe("jwt-bob")
  })

  it("re-partitions correctly when the same account logs back in after another user", async () => {
    const alice = makeSession({ jwt: "jwt-alice", username: "alice" })
    const bob = makeSession({ jwt: "jwt-bob", username: "bob" })

    const fetcherAlice1 = makeAudioSyncTokenFetcher(() => alice)
    await fetcherAlice1("proj-1", "file-1")

    const fetcherBob = makeAudioSyncTokenFetcher(() => bob)
    await fetcherBob("proj-1", "file-1")

    // Alice logs back in (fresh hook instance, same username) — her earlier
    // cache entry should still be hers to reuse, not clobbered by Bob's visit.
    const fetcherAlice2 = makeAudioSyncTokenFetcher(() => alice)
    const tokenAlice2 = await fetcherAlice2("proj-1", "file-1")

    expect(mockedFetchSyncToken).toHaveBeenCalledTimes(2) // no 3rd mint for Alice's return
    expect(tokenAlice2).toBe("minted-1")
  })

  it("returns null and never mints when the session has no JWT", async () => {
    const anon = { jwt: "", username: "anon", createdAt: "" } as FrontierSession
    const fetcher = makeAudioSyncTokenFetcher(() => anon)

    const token = await fetcher("proj-1", "file-1")

    expect(token).toBeNull()
    expect(mockedFetchSyncToken).not.toHaveBeenCalled()
  })

  it("re-mints once the cached token enters the refresh safety window", async () => {
    vi.useFakeTimers()
    try {
      const session = makeSession()
      const fetcher = makeAudioSyncTokenFetcher(() => session)

      mockedFetchSyncToken.mockResolvedValueOnce({
        token: "short-lived",
        expiresIn: 40, // 40s TTL; REFRESH_SAFETY_MS is 30s, so it's stale after 10s.
        role: ROLE,
      })
      await fetcher("proj-1", "file-1")
      expect(mockedFetchSyncToken).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(15_000) // now inside the 30s refresh safety window
      mockedFetchSyncToken.mockResolvedValueOnce({
        token: "fresh",
        expiresIn: 900,
        role: ROLE,
      })
      const token = await fetcher("proj-1", "file-1")

      expect(mockedFetchSyncToken).toHaveBeenCalledTimes(2)
      expect(token).toBe("fresh")
    } finally {
      vi.useRealTimers()
    }
  })
})
