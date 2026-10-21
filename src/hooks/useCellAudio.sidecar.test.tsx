// AQU-2095: the Audio view card's waveform, from the stored shape.
//
// WHY: the card is the main thing the ticket is about — a chapter of them used
// to download every recording just to draw. Each case here is a way the card
// could quietly cost more than it should, or draw less than it used to:
//   - a stored shape must stand in for the recording, length included (a clip
//     with no length on its attachment — a voice-together clip — learned it
//     only by being decoded, and without it the card has no trim ends);
//   - a recording already on this device must draw without any request;
//   - a card that did download the clip leaves its shape for everyone else;
//   - a card that wants fewer bins narrows the shared shape, never writes its own.

import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "user-jwt", username: "u" } }) }))
vi.mock("@/lib/sync/sync-token", async () => ({
  ...(await vi.importActual<typeof import("@/lib/sync/sync-token")>("@/lib/sync/sync-token")),
  fetchSyncToken: vi.fn(async () => ({ token: "sync-token-stub", expiresIn: 900, role: { level: 400, name: "contributor", source: "creator" as const } })),
}))
vi.mock("@/lib/offline/connectivity", () => ({ isOnline: async () => null }))

const fetchPeaksSidecar = vi.fn()
const publishPeaksSidecarOnce = vi.fn()
vi.mock("@/lib/audio/peaks-sidecar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audio/peaks-sidecar")>()),
  fetchPeaksSidecar: (a: unknown) => fetchPeaksSidecar(a),
  publishPeaksSidecarOnce: (a: unknown) => publishPeaksSidecarOnce(a),
}))
const decodePeaks = vi.fn()
vi.mock("@/lib/audio/peaks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audio/peaks")>()),
  decodePeaks: (...a: unknown[]) => decodePeaks(...a),
}))
const audioCacheGet = vi.fn()
vi.mock("@/lib/audio/bytes-cache", () => ({
  audioCacheGet: (...a: unknown[]) => audioCacheGet(...a),
  audioCachePut: vi.fn(async () => {}),
  audioCacheEvict: vi.fn(async () => {}),
}))
vi.mock("@/lib/audio/peaks-cache", () => ({ peaksCacheGet: vi.fn(async () => null), peaksCachePut: vi.fn(async () => {}) }))
const fetchCellAudio = vi.fn()
vi.mock("@/lib/audio/upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audio/upload")>()),
  fetchCellAudio: (...a: unknown[]) => fetchCellAudio(...a),
}))

import { useCellAudio } from "./useCellAudio"
import { buildFrontierAudioUrl } from "@/lib/audio/upload"
import { SIDECAR_BINS } from "@/lib/audio/peaks-sidecar"

const project = { id: "p1", name: "P", sourceLanguage: "en", targetLanguage: "es", createdAt: "", files: [], members: [] } as unknown as ProjectRecord
// No length on the attachment, like a voice-together clip.
const cell = {
  kind: 2, languageId: "html", value: "",
  metadata: { id: "cell-1", type: "text", attachments: { a1: { url: buildFrontierAudioUrl("a1", "webm"), type: "audio" } }, selectedAudioId: "a1" },
} as unknown as CodexCell

beforeEach(() => {
  fetchPeaksSidecar.mockReset().mockResolvedValue(null)
  publishPeaksSidecarOnce.mockReset().mockResolvedValue(undefined)
  decodePeaks.mockReset().mockResolvedValue({ peaks: new Float32Array(SIDECAR_BINS).fill(0.4), duration: 3, sampleRate: 48000 })
  audioCacheGet.mockReset().mockResolvedValue(null)
  fetchCellAudio.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]))
})

async function drawn(bins = SIDECAR_BINS) {
  const hook = renderHook(() => useCellAudio(project, cell, "file-1"))
  await act(async () => { await hook.result.current.requestPeaks(bins) })
  return hook.result
}

describe("useCellAudio — the waveform from the stored shape (AQU-2095)", () => {
  it("draws from the stored shape, with its length, and never downloads the recording", async () => {
    fetchPeaksSidecar.mockResolvedValue({ peaks: new Float32Array(SIDECAR_BINS).fill(0.7), durationMs: 4200 })
    const result = await drawn()
    expect(result.current.peaksState).toBe("ready")
    expect(result.current.peaks?.length).toBe(SIDECAR_BINS)
    expect(result.current.duration).toBeCloseTo(4.2)
    expect(fetchCellAudio).not.toHaveBeenCalled()
    expect(decodePeaks).not.toHaveBeenCalled()
  })

  it("draws a recording already on this device without asking the server", async () => {
    audioCacheGet.mockResolvedValue(new Uint8Array([9, 9]))
    const result = await drawn()
    expect(result.current.peaksState).toBe("ready")
    expect(fetchPeaksSidecar).not.toHaveBeenCalled()
    expect(fetchCellAudio).not.toHaveBeenCalled()
    expect(publishPeaksSidecarOnce).toHaveBeenCalledWith(expect.objectContaining({ audioId: "a1", ext: "webm", durationMs: 3000 }))
  })

  it("downloads the clip when there is no stored shape, and leaves its shape behind", async () => {
    const result = await drawn()
    expect(result.current.peaksState).toBe("ready")
    expect(fetchCellAudio).toHaveBeenCalledOnce()
    expect(publishPeaksSidecarOnce).toHaveBeenCalledWith(expect.objectContaining({ audioId: "a1", peaks: expect.any(Float32Array), durationMs: 3000 }))
  })

  it("narrows the shared shape for a card that wants fewer bins", async () => {
    fetchPeaksSidecar.mockResolvedValue({ peaks: new Float32Array(SIDECAR_BINS).fill(0.7), durationMs: null })
    const result = await drawn(SIDECAR_BINS / 2)
    expect(result.current.peaks?.length).toBe(SIDECAR_BINS / 2)
    expect(fetchCellAudio).not.toHaveBeenCalled()
  })
})
