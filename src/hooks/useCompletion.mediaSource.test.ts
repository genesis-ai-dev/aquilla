// SUB-28 (AQU-646): the completion engine must read a media section's
// TRANSCRIPT as its source — `original` holds the import FILENAME, which the
// model was faithfully "translating". Untranscribed sections have no source
// text at all: completeSingle errors clearly, completeBatch skips them.

import { describe, it, expect, vi, beforeEach } from "vitest"

interface MinimalCell {
  id: string
  fileId: string
  original: string
  translated: string
  status: string
  medium?: "text" | "media"
  transcription?: string
}

vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn(), captureException: vi.fn() } }))
vi.mock("@/lib/completion/frontier-health", () => ({
  useFrontierHealth: () => ({ available: true }),
}))
vi.mock("@/lib/store/user-provider-override", () => ({
  getUserProviderOverride: () => null,
}))
vi.mock("@/lib/store/user-api-keys", () => ({
  resolveApiKey: (_: string, key: string | undefined) => key ?? null,
}))
vi.mock("@/lib/completion/batch-completion", () => ({
  resetBatchCompletionState: vi.fn(() => "run-1"),
  clearBatchCompletionProgress: vi.fn(),
  incrementBatchCompletionDone: vi.fn(),
  incrementBatchCompletionFailed: vi.fn(),
  isBatchCompletionCancelled: vi.fn(() => false),
  getBatchCompletionSignal: vi.fn(() => new AbortController().signal),
  cancelBatchCompletion: vi.fn(),
}))
vi.mock("@/lib/completion/compress-examples", () => ({
  compressExampleSource: (src: string) => src,
  dedupeExamples: (exs: unknown[]) => exs,
  dropPrecedingContextDuplicates: (exs: unknown[]) => exs,
  dropValidatedPairDuplicates: (exs: unknown[]) => exs,
}))

import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { renderHook, act } from "@testing-library/react"
import { useCompletion } from "./useCompletion"
import { DEFAULT_DRAFT_CONTEXT } from "@/lib/completion/draft-context"

const SESSION: FrontierSession = {
  jwt: "jwt-test",
  username: "tester",
  createdAt: new Date().toISOString(),
}

const SETTINGS: CompletionSettings = {
  provider: "custom",
  endpoint: "http://localhost:9999",
  model: "test-model",
  maxTokens: 512,
  temperature: 0.3,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}

const TRANSCRIBED: MinimalCell = {
  id: "sec-1", fileId: "file-a", original: "episode.mp3", translated: "", status: "draft",
  medium: "media", transcription: "In the beginning was the word",
}
const UNTRANSCRIBED: MinimalCell = {
  id: "sec-2", fileId: "file-a", original: "episode.mp3", translated: "", status: "draft",
  medium: "media",
}
// A validated media cell in the corpus — its EXAMPLE source must be the
// transcript too (corpus pollution guard).
const VALIDATED_MEDIA: MinimalCell = {
  id: "sec-9", fileId: "file-a", original: "episode.mp3", translated: "Au commencement", status: "validated",
  medium: "media", transcription: "In the beginning",
}

const searchMock = vi.fn().mockResolvedValue([])
const searchPassagesMock = vi.fn().mockResolvedValue([])

function mockFetchCapturing(bodies: string[], content = "A translation") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      bodies.push(init.body as string)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content } }] }),
        body: null,
      })
    }),
  )
}

function renderCompletion(commitMock: ReturnType<typeof vi.fn>, cells: MinimalCell[]) {
  return renderHook(() =>
    useCompletion(
      SETTINGS, "English", "French",
      searchMock, searchPassagesMock,
      SESSION, commitMock as never, [],
      cells as never, undefined, DEFAULT_DRAFT_CONTEXT,
    ),
  )
}

describe("SUB-28 — completion sources from the transcript, never the filename", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    searchMock.mockClear()
  })

  it("completeSingle prompts with the transcript; the filename never reaches the request", async () => {
    const bodies: string[] = []
    mockFetchCapturing(bodies)
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock, [TRANSCRIBED])

    await act(async () => {
      await result.current.completeSingle(TRANSCRIBED as never)
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain("In the beginning was the word")
    expect(bodies[0]).not.toContain("episode.mp3")
    // The few-shot retrieval query is the transcript too.
    expect(searchMock).toHaveBeenCalledWith("In the beginning was the word", expect.anything(), "sec-1")
    expect(commitMock).toHaveBeenCalledTimes(1)
  })

  it("completeSingle on an UNtranscribed section errors clearly and never fetches", async () => {
    const bodies: string[] = []
    mockFetchCapturing(bodies)
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock, [UNTRANSCRIBED])

    await act(async () => {
      await result.current.completeSingle(UNTRANSCRIBED as never)
    })

    expect(bodies).toHaveLength(0)
    expect(commitMock).not.toHaveBeenCalled()
    expect(result.current.errors.get("sec-2")).toMatch(/transcribe/i)
    expect(result.current.completing.get("sec-2")).toBe("error")
  })

  it("a validated media cell contributes its TRANSCRIPT as the example source", async () => {
    const bodies: string[] = []
    mockFetchCapturing(bodies)
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock, [TRANSCRIBED, VALIDATED_MEDIA])

    await act(async () => {
      await result.current.completeSingle(TRANSCRIBED as never)
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain("In the beginning") // validated pair source = transcript
    expect(bodies[0]).not.toContain("episode.mp3")
  })

  it("completeBatch skips untranscribed sections and prompts transcripts for the rest", async () => {
    const bodies: string[] = []
    mockFetchCapturing(bodies, "<v1>Une traduction</v1>")
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock, [TRANSCRIBED, UNTRANSCRIBED])

    await act(async () => {
      await result.current.completeBatch([TRANSCRIBED, UNTRANSCRIBED] as never)
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain("In the beginning was the word")
    expect(bodies[0]).not.toContain("episode.mp3")
  })

  it("a plain text cell is untouched (identity path)", async () => {
    const textCell: MinimalCell = {
      id: "t1", fileId: "file-a", original: "Verse one source", translated: "", status: "draft",
    }
    const bodies: string[] = []
    mockFetchCapturing(bodies)
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock, [textCell])

    await act(async () => {
      await result.current.completeSingle(textCell as never)
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain("Verse one source")
  })
})

describe("SUB-29 flight — error hygiene", () => {
  it("the 'transcribe first' error CLEARS when a retry starts after transcription", async () => {
    const bodies: string[] = []
    mockFetchCapturing(bodies)
    const commitMock = vi.fn().mockResolvedValue(undefined)
    const { result } = renderCompletion(commitMock, [UNTRANSCRIBED])

    await act(async () => {
      await result.current.completeSingle(UNTRANSCRIBED as never)
    })
    expect(result.current.errors.get("sec-2")).toMatch(/transcribe/i)

    // Transcription lands; the user retries — the stale guidance must clear.
    const nowTranscribed = { ...UNTRANSCRIBED, transcription: "and the word was heard" }
    await act(async () => {
      await result.current.completeSingle(nowTranscribed as never)
    })
    expect(result.current.errors.get("sec-2")).toBeUndefined()
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain("and the word was heard")
  })
})
