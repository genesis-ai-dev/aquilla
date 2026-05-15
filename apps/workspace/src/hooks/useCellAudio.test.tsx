// Tests for the R2-backed audio hook. Verifies the happy-path fetch flow
// against the sync-worker /audio endpoint, plus the error states the UI
// renders (legacy LFS attachment, no session, server failure).

import "fake-indexeddb/auto"
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"

const session = { jwt: "user-jwt", username: "u" }

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session }),
}))

// Stub the sync-token fetch so the hook never tries to hit identity.
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

beforeEach(() => {
  nextUrlId = 0
  createdUrls.length = 0
  revokedUrls.length = 0
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
      constructor(src?: string) { if (src) this.src = src }
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

  it("happy path: GETs from sync-worker /audio and plays", async () => {
    const bytes = new TextEncoder().encode("audio-bytes")
    fetchMock.mockResolvedValueOnce(new Response(bytes.buffer as ArrayBuffer, { status: 200 }))

    const project = makeProject()
    const cell = makeCell("a1", buildFrontierAudioUrl("a1", "webm"))
    const { result } = renderHook(() => useCellAudio(project, cell, "file-1"))

    expect(result.current.state).toBe("idle")

    await act(async () => { await result.current.play() })

    expect(result.current.state).toBe("ready")
    expect(result.current.error).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(String(url)).toContain("/audio/p1/file-1/a1.webm")
    expect((opts as RequestInit)?.headers).toMatchObject({
      Authorization: "Bearer sync-token-stub",
    })
    expect(createdUrls.length).toBe(1)
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

  it("surfaces download-failed when sync-worker returns 5xx", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }))

    const project = makeProject()
    const cell = makeCell("a3", buildFrontierAudioUrl("a3", "webm"))
    const { result } = renderHook(() => useCellAudio(project, cell, "file-1"))

    await act(async () => { await result.current.play() })
    expect(result.current.state).toBe("error")
    expect(result.current.error?.kind).toBe("download-failed")
  })

  it("does not re-fetch bytes on a second play after the audio element exists", async () => {
    const bytes = new TextEncoder().encode("cached-audio")
    fetchMock.mockResolvedValueOnce(new Response(bytes.buffer as ArrayBuffer, { status: 200 }))

    const project = makeProject()
    const cell = makeCell("a4", buildFrontierAudioUrl("a4", "webm"))
    const { result } = renderHook(() => useCellAudio(project, cell, "file-1"))

    await act(async () => { await result.current.play() })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => { await result.current.play() })
    // Second play reuses the existing HTMLAudioElement; no further fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("revokes the object URL on unmount", async () => {
    const bytes = new TextEncoder().encode("revoke-test")
    fetchMock.mockResolvedValueOnce(new Response(bytes.buffer as ArrayBuffer, { status: 200 }))

    const project = makeProject()
    const cell = makeCell("a5", buildFrontierAudioUrl("a5", "webm"))
    const { result, unmount } = renderHook(() => useCellAudio(project, cell, "file-1"))
    await act(async () => { await result.current.play() })
    expect(createdUrls.length).toBe(1)

    unmount()
    expect(revokedUrls).toContain(createdUrls[0])
  })
})
