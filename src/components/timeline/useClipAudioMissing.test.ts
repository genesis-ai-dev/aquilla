// resolveEntryAudio: recording-over-generated-voice picking + legacy-url guard.
// useClipAudioMissing: only a definitive 404 flips the badge on; cache hits and
// transient "unknown" results never do; switching clips discards stale probes.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { FrontierSession } from "@/lib/frontier/types"

const probeMock = vi.fn()
const cacheMock = vi.fn()

vi.mock("@/lib/audio/upload", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audio/upload")>("@/lib/audio/upload")
  return { ...actual, probeCellAudioPresent: (...a: unknown[]) => probeMock(...a) }
})
vi.mock("@/lib/audio/bytes-cache", () => ({
  audioCacheGet: (...a: unknown[]) => cacheMock(...a),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "tok",
}))

import { resolveEntryAudio, useClipAudioMissing, type ClipAudio } from "./useClipAudioMissing"

const session = { jwt: "jwt", username: "u" } as unknown as FrontierSession

function entry(over: Partial<CellAudioEntry>): CellAudioEntry {
  return {
    attachments: {}, selectedAudioId: null, selectedGeneratedVoiceAudioId: null,
    audioTimings: {}, ...over,
  }
}

describe("resolveEntryAudio", () => {
  it("prefers the recording slot over generated voice", () => {
    expect(
      resolveEntryAudio(entry({
        selectedAudioId: "rec",
        selectedGeneratedVoiceAudioId: "gen",
        attachments: {
          rec: { audioId: "rec", url: "frontier-audio://rec.webm" } as never,
          gen: { audioId: "gen", url: "frontier-audio://gen.wav" } as never,
        },
      })),
    ).toEqual({ audioId: "rec", ext: "webm" })
  })

  it("falls back to generated voice when there is no recording", () => {
    expect(
      resolveEntryAudio(entry({
        selectedGeneratedVoiceAudioId: "gen",
        attachments: { gen: { audioId: "gen", url: "frontier-audio://gen.wav" } as never },
      })),
    ).toEqual({ audioId: "gen", ext: "wav" })
  })

  it("returns null for a missing entry, no selection, or a legacy (non-frontier) url", () => {
    expect(resolveEntryAudio(undefined)).toBeNull()
    expect(resolveEntryAudio(entry({}))).toBeNull()
    expect(
      resolveEntryAudio(entry({
        selectedAudioId: "x",
        attachments: { x: { audioId: "x", url: "/.project/attachments/legacy.webm" } as never },
      })),
    ).toBeNull()
  })
})

describe("useClipAudioMissing", () => {
  beforeEach(() => {
    probeMock.mockReset()
    cacheMock.mockReset()
    cacheMock.mockResolvedValue(null)
  })

  const base = { projectId: "p1", fileId: "f1", session }
  const clip = (audioId: string): ClipAudio => ({ audioId, ext: "webm" })

  it("stays false and never probes when there is no audio", () => {
    const { result } = renderHook(() => useClipAudioMissing({ ...base, audio: null }))
    expect(result.current).toBe(false)
    expect(probeMock).not.toHaveBeenCalled()
  })

  it("flips true when the probe reports the clip missing", async () => {
    probeMock.mockResolvedValue("missing")
    const { result } = renderHook(() => useClipAudioMissing({ ...base, audio: clip("a1") }))
    await waitFor(() => expect(result.current).toBe(true))
  })

  it("stays false for a transient 'unknown' probe result", async () => {
    probeMock.mockResolvedValue("unknown")
    const { result } = renderHook(() => useClipAudioMissing({ ...base, audio: clip("a2") }))
    await waitFor(() => expect(probeMock).toHaveBeenCalled())
    expect(result.current).toBe(false)
  })

  it("treats a locally-cached take as present without probing", async () => {
    cacheMock.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const { result } = renderHook(() => useClipAudioMissing({ ...base, audio: clip("a3") }))
    await waitFor(() => expect(cacheMock).toHaveBeenCalled())
    expect(result.current).toBe(false)
    expect(probeMock).not.toHaveBeenCalled()
  })

  it("clears the badge when the selection changes to a clip with no audio", async () => {
    probeMock.mockResolvedValue("missing")
    const { result, rerender } = renderHook(
      ({ audio }) => useClipAudioMissing({ ...base, audio }),
      { initialProps: { audio: clip("a1") as ClipAudio | null } },
    )
    await waitFor(() => expect(result.current).toBe(true))
    rerender({ audio: null })
    await waitFor(() => expect(result.current).toBe(false))
  })
})
