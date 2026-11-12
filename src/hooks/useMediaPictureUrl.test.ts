import { renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useMediaPictureUrl } from "./useMediaPictureUrl"

vi.mock("@/lib/sync/sync-worker-url", () => ({
  syncWorkerHttpOrigin: () => "https://sync.example",
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "token",
}))

const args = {
  projectId: "p1", fileId: "f1", retryKey: 0,
  session: { username: "dev", jwt: "identity" },
}

describe("media picture URL", () => {
  it("streams an imported clip through the signed audio route", async () => {
    const { result } = renderHook(() => useMediaPictureUrl({
      ...args, src: "frontier-audio://clip.mp4",
    }))
    await waitFor(() => expect(result.current).toBe(
      "https://sync.example/audio/p1/f1/clip.mp4?t=token",
    ))
  })

  it("returns external picture URLs unchanged", () => {
    const { result } = renderHook(() => useMediaPictureUrl({
      ...args, src: "https://cdn.example/clip.mp4",
    }))
    expect(result.current).toBe("https://cdn.example/clip.mp4")
  })

  it("clears the signed picture when the session disappears", async () => {
    const { result, rerender } = renderHook(({ session }) =>
      useMediaPictureUrl({
        ...args, session, src: "frontier-audio://clip.mp4",
      }), { initialProps: { session: args.session as typeof args.session | null } },
    )
    await waitFor(() => expect(result.current).toContain("?t=token"))
    rerender({ session: null })
    expect(result.current).toBeNull()
  })

  it("never renders the previous file's signed URL during a switch", async () => {
    const { result, rerender } = renderHook(({ fileId }) =>
      useMediaPictureUrl({
        ...args, fileId, src: "frontier-audio://clip.mp4",
      }), { initialProps: { fileId: "f1" } },
    )
    await waitFor(() => expect(result.current).toContain("/f1/"))
    rerender({ fileId: "f2" })
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toContain("/f2/"))
  })
})
