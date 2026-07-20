// Tests for the R2-backed audio hook. Verifies the happy-path progressive
// playback flow (element streams from the authenticated /audio URL — play()
// must NOT download the whole object first), the blob fallback when the
// stream errors, plus the error states the UI renders (legacy LFS
// attachment, no session, server failure).

import "fake-indexeddb/auto"
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"

const session = { jwt: "user-jwt", username: "u" }

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session }),
}))

// Stub the sync-token fetch so the hook never tries to hit the auth-worker.
// Returns a fixed token that we don't actually verify in tests; the audio
// endpoint mock checks for its presence in the Authorization header.
vi.mock("@/lib/sync/sync-token", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sync/sync-token")>("@/lib/sync/sync-token")
  return {
    ...actual,
    fetchSyncToken: vi.fn(async () => ({
      token: "sync-token-stub",
      expiresIn: 900,
      role: { level: 400, name: "contributor", source: "creator" as const },
    })),
  }
})

// Pull useCellAudio after mocks are declared.
import { useCellAudio } from "./useCellAudio"
import { buildFrontierAudioUrl } from "@/lib/audio/upload"

let nextUrlId = 0
const createdUrls: string[] = []
const revokedUrls: string[] = []
const audioInstances: Array<InstanceType<typeof Audio>> = []

beforeEach(() => {
  nextUrlId = 0
  createdUrls.length = 0
  revokedUrls.length = 0
  audioInstances.length = 0
  Object.defineProperty(globalThis.URL, "createObjectURL", {
    writable: true, configurable: true,
    value: vi.fn((_blob: Blob) => {
      const u = `blob:mock-${++nextUrlId}`
      createdUrls.push(u)
      return u
    }),
  })
  Object.defineProperty(globalThis.URL, "revokeObjectURL", {
    writable: true, configurable: true,
    value: vi.fn((u: string) => { revokedUrls.push(u) }),
  })
  Object.defineProperty(globalThis, "Audio", {
    writable: true, configurable: true,
    value: class {
      src: string = ""
      public onplay: (() => void) | null = null
      public onpause: (() => void) | null = null
      public onended: (() => void) | null = null
      public onerror: (() => void) | null = null
      constructor(src?: string) {
        if (src) this.src = src
        audioInstances.push(this as unknown as InstanceType<typeof Audio>)
      }
      async play() { this.onplay?.() }
      pause() { this.onpause?.() }
    },
  })
})
afterEach(() => { vi.restoreAllMocks() })

function makeProject(): ProjectRecord {
  return {
    id: "p1", name: "P", sourceLanguage: "en", targetLanguage: "es",
    createdAt: "", files: [], members: [],
  } as unknown as ProjectRecord
}

function makeCell(selectedAudioId: string, attachmentUrl: string): CodexCell {
  return {
    kind: 2, languageId: "html", value: "",
    metadata: {
      id: "cell-1", type: "text",
      attachments: { [selectedAudioId]: { url: attachmentUrl, type: "audio" } },
      selectedAudioId,
    },
  } as unknown as CodexCell
}

describe("useCellAudio", () => {
  const fetchMock = vi.fn()
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset() })

  it("happy path: streams from the authenticated /audio URL without downloading bytes first", async () => {
    const project = makeProject()
    const cell = makeCell("a1", buildFrontierAudioUrl("a1", "webm"))
    const { result } = renderHook(() => useCellAudio(project, cell, "file-1"))

    // Cell has a frontier-audio:// pointer → starts in "cloud" state (bytes not fetched yet).
    expect(result.current.state).toBe("cloud")

    await act(async () => { await result.current.play() })

    expect(result.current.state).toBe("ready")
    expect(result.current.error).toBeNull()
    // Progressive playback: the element streams straight from the worker —
    // play() must NOT pull the whole object through fetch (that was the
    // 27MB-in-memory / long-silent-wait bug) and needs no object URL.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(createdUrls.length).toBe(0)
    expect(audioInstances).toHaveLength(1)
    const src = audioInstances[0].src
    expect(src).toContain("/audio/p1/file-1/a1.webm")
    // The sync-token rides in the URL because <audio src> can't send headers.
    expect(src).toContain("t=sync-token-stub")
  })

  it("surfaces pointer-invalid for legacy LFS attachment URLs", async () => {
    const project = makeProject()
    const cell = makeCell("a2", "/.project/attachments/files/JUD/legacy.webm")
    const { result } = renderHook(() => useCellAudio(project, cell, "file-1"))

    await act(async () => { await result.current.play() })
    expect(result.current.state).toBe("error")
    expect(result.current.error).toMatchObject({ kind: "pointer-invalid" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("surfaces pointer-missing when the cell has no audio attachment", async () => {
    const project = makeProject()
    const cell = {
      kind: 2, languageId: "html", value: "",
      metadata: { id: "c", type: "text" },
    } as unknown as CodexCell
    const { result } = renderHook(() => useCellAudio(project, cell, "file-1"))

    await act(async () => { await result.current.play() })
    expect(result.current.state).toBe("error")
    expect(result.current.error).toMatchObject({ kind: "pointer-missing" })
  })

  // The stream src failing is the only signal the element gives us (media
  // errors carry no HTTP status), so the hook must fall back to the byte
  // fetch once — both to recover from transient failures AND to translate a
  // permanent 404 into the precise "audio-deleted" UI state.
  it("surfaces download-failed when the stream errors and the byte fallback hits a 5xx", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }))

    const project = makeProject()
    const cell = makeCell("a3", buildFrontierAudioUrl("a3", "webm"))
    const { result } = renderHook(() => useCellAudio(project, cell, "file-1"))

    await act(async () => { await result.current.play() })
    expect(result.current.state).toBe("ready") // streaming src wired up
    act(() => { audioInstances[0].onerror?.(new Event("error")) })
    await waitFor(() => expect(result.current.state).toBe("error"))
    expect(result.current.error?.kind).toBe("download-failed")
  })

  it("F10: surfaces audio-deleted (not download-failed) when the audio is gone (404)", async () => {
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }))

    const project = makeProject()
    const cell = makeCell("a-deleted", buildFrontierAudioUrl("a-deleted", "webm"))
    const { result } = renderHook(() => useCellAudio(project, cell, "file-1"))

    await act(async () => { await result.current.play() })
    act(() => { audioInstances[0].onerror?.(new Event("error")) })
    await waitFor(() => expect(result.current.state).toBe("error"))
    // Must be "audio-deleted", not the generic "download-failed" —
    // so the UI knows not to show a retry affordance.
    expect(result.current.error?.kind).toBe("audio-deleted")
    expect(result.current.error?.message).toMatch(/deleted/)
  })

  it("reuses the existing element on a second play (no new element, no fetch)", async () => {
    const project = makeProject()
    const cell = makeCell("a4", buildFrontierAudioUrl("a4", "webm"))
    const { result } = renderHook(() => useCellAudio(project, cell, "file-1"))

    await act(async () => { await result.current.play() })
    expect(audioInstances).toHaveLength(1)

    await act(async () => { await result.current.play() })
    // Second play reuses the existing HTMLAudioElement; still zero byte fetches.
    expect(audioInstances).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("dedups concurrent loads: two parallel fetches collapse to a single GET", async () => {
    // Only ONE response is queued. Before the in-flight dedup, two callers
    // firing on the same mount (waveform peak decode + play) each triggered a
    // fetch; the second got `undefined` and a transient failure could flip
    // shared state to "error" despite the first succeeding.
    const bytes = new TextEncoder().encode("dedup-audio")
    fetchMock.mockResolvedValueOnce(new Response(bytes.buffer as ArrayBuffer, { status: 200 }))

    const project = makeProject()
    const cell = makeCell("a6", buildFrontierAudioUrl("a6", "webm"))
    const { result } = renderHook(() => useCellAudio(project, cell, "file-1"))

    await act(async () => {
      await Promise.all([result.current.ensureBytes(), result.current.ensureBytes()])
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("plays from a blob and revokes the object URL on unmount when bytes are already loaded", async () => {
    const bytes = new TextEncoder().encode("revoke-test")
    fetchMock.mockResolvedValueOnce(new Response(bytes.buffer as ArrayBuffer, { status: 200 }))

    const project = makeProject()
    const cell = makeCell("a5", buildFrontierAudioUrl("a5", "webm"))
    const { result, unmount } = renderHook(() => useCellAudio(project, cell, "file-1"))
    // Bytes fetched up front (e.g. waveform peaks) → play() must reuse them
    // via a blob object URL instead of opening a second network stream…
    await act(async () => { await result.current.ensureBytes() })
    await act(async () => { await result.current.play() })
    expect(createdUrls.length).toBe(1)
    expect(audioInstances[0].src).toBe(createdUrls[0])

    // …and the object URL must not leak past unmount.
    unmount()
    expect(revokedUrls).toContain(createdUrls[0])
  })

  it("cloud state: starts as 'cloud' when frontier-audio:// pointer exists but bytes not fetched", () => {
    const project = makeProject()
    const cell = makeCell("a-cloud", buildFrontierAudioUrl("a-cloud", "webm"))
    const { result } = renderHook(() => useCellAudio(project, cell, "file-1"))
    // Before any play(), bytes are unfetched — state should be "cloud".
    expect(result.current.state).toBe("cloud")
  })

  it("cloud state: stays 'idle' when no attachment url is present", () => {
    const project = makeProject()
    const cell = {
      kind: 2, languageId: "html", value: "",
      metadata: { id: "c-no-att", type: "text" },
    } as unknown as CodexCell
    const { result } = renderHook(() => useCellAudio(project, cell, "file-1"))
    expect(result.current.state).toBe("idle")
  })
})
