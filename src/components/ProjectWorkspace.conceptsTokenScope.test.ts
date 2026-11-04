/**
 * AQU-2079: the terminology read must not queue behind the project-details
 * response.
 *
 * The first term row took ~3.9 s to appear on prod for a 2-term project even
 * though `/concepts` answers in ~200 ms, because the read was wired to the
 * LOADED project (`project?.id`): details, then a sync-token mint, then the
 * terms — three requests end to end, ~3.6 s of which was waiting.
 *
 * `buildRouteScopedTokenFetcher` is the extracted seam ProjectWorkspace's
 * concepts read now mints through. Tested directly rather than by mounting the
 * whole workspace, same pattern as `fetchDeletedFilesWithProjectToken`
 * (AQU-1894) and `nextPaintGate` (AQU-1326).
 */

import { describe, it, expect, vi } from "vitest"
import { buildRouteScopedTokenFetcher } from "./project-workspace-helpers"

const ROUTE_PROJECT = "proj-from-the-url"
const TOKEN = "minted-sync-token"

/** Stand-in for buildFileScopedTokenFetcher, recording how it was scoped. */
function fakeBuilder() {
  const calls: Array<{ projectId: string; bootstrap: unknown; fileIds: string[] }> = []
  const build = vi.fn(
    (
      _getJwt: () => string | null,
      projectId: string,
      bootstrap: unknown = {},
    ) => {
      const entry = { projectId, bootstrap, fileIds: [] as string[] }
      calls.push(entry)
      return async (fileId: string) => {
        entry.fileIds.push(fileId)
        return TOKEN
      }
    },
  )
  return { build, calls }
}

describe("buildRouteScopedTokenFetcher (AQU-2079)", () => {
  it("mints against the route's project id, with no loaded project record", async () => {
    const { build, calls } = fakeBuilder()
    // The regression: on the first render `project` is still undefined. A
    // fetcher that needed it could not mint until the details response landed.
    const getToken = buildRouteScopedTokenFetcher({
      routeProjectId: ROUTE_PROJECT,
      getJwt: () => "session-jwt",
      build: build as never,
    })
    await expect(getToken("any")).resolves.toBe(TOKEN)
    expect(build).toHaveBeenCalledTimes(1)
    expect(calls[0].projectId).toBe(ROUTE_PROJECT)
    expect(calls[0].fileIds).toEqual(["any"])
  })

  it("sends no ProjectBootstrap — the only part of a mint that needs the record", async () => {
    const { build, calls } = fakeBuilder()
    const getToken = buildRouteScopedTokenFetcher({
      routeProjectId: ROUTE_PROJECT,
      getJwt: () => "session-jwt",
      build: build as never,
    })
    await getToken("any")
    // `projectName` / `gitlabProjectId` are accepted-and-IGNORED by
    // /api/v2/sync-token since AQU-299 / SEC-9. Reading them off the project
    // record is what chained the mint to the details response; carrying an
    // empty bootstrap keeps the mint answerable from the URL alone.
    expect(calls[0].bootstrap).toEqual({})
  })

  it("reuses one fetcher across calls, so the terms mint is not repeated per read", async () => {
    const { build } = fakeBuilder()
    const getToken = buildRouteScopedTokenFetcher({
      routeProjectId: ROUTE_PROJECT,
      getJwt: () => "session-jwt",
      build: build as never,
    })
    await getToken("any")
    await getToken("any")
    // The per-(project,file) token cache lives inside the built fetcher; a
    // builder called per read would mint twice for the same scope.
    expect(build).toHaveBeenCalledTimes(1)
  })

  it("returns null without minting when the route carries no project id", async () => {
    const { build } = fakeBuilder()
    const getToken = buildRouteScopedTokenFetcher({
      routeProjectId: undefined,
      getJwt: () => "session-jwt",
      build: build as never,
    })
    // AQU-1340 still holds: an unmintable token is an error upstream, never an
    // empty termbase. Guessing a scope here would be worse than failing closed.
    await expect(getToken("any")).resolves.toBeNull()
    expect(build).not.toHaveBeenCalled()
  })

  it("passes the caller's sync-token callbacks through to the fetcher", async () => {
    const { build } = fakeBuilder()
    const onUnauthorized = vi.fn()
    buildRouteScopedTokenFetcher({
      routeProjectId: ROUTE_PROJECT,
      getJwt: () => "session-jwt",
      callbacks: { onUnauthorized },
      build: build as never,
    })
    // AQU-994: a 401 on this mint must still raise the session-expired banner.
    expect(build).toHaveBeenCalledWith(
      expect.any(Function),
      ROUTE_PROJECT,
      {},
      undefined,
      { onUnauthorized },
    )
  })
})
