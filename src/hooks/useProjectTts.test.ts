import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

const mockCapture = vi.hoisted(() => vi.fn())
vi.mock("@/lib/posthog", () => ({
  default: { capture: mockCapture },
}))

vi.mock("@/lib/store/project-index", () => ({
  patchProject: vi.fn(async () => {}),
}))

import { useProjectTts } from "./useProjectTts"
import { loadProjectTts } from "@/lib/store/project-tts-store"
import { patchProject } from "@/lib/store/project-index"
import { DEFAULT_INWORLD_VOICE } from "@/lib/audio/tts-providers"
import { OMNIVOICE_VOICES_MIGRATED } from "@/lib/event-names"

const PROJECT_ID = "proj-omnivoice-migrate"

describe("useProjectTts OmniVoice persist (AQU-1189)", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(patchProject).mockClear()
    mockCapture.mockClear()
  })

  it("rewrites omnivoice settings to inworld and stores the Inworld language", async () => {
    const server: ProjectTtsSettings = {
      provider: "omnivoice",
      voices: [{ id: "v1", name: "Narrator", provider: "omnivoice", language: "eng" }],
      defaultVoiceId: "v1",
    }
    const onSyncTts = vi.fn()
    const { result } = renderHook(() =>
      useProjectTts(PROJECT_ID, server, [], onSyncTts, "spa"),
    )

    expect(result.current.settings?.provider).toBe("inworld")
    expect(result.current.settings?.voices?.[0]).toMatchObject({
      provider: "inworld",
      voiceName: DEFAULT_INWORLD_VOICE,
      language: "en-US",
    })

    await waitFor(() => expect(onSyncTts).toHaveBeenCalled())
    expect(onSyncTts).toHaveBeenCalledTimes(1)
    expect(onSyncTts.mock.calls[0][0].provider).toBe("inworld")
    expect(loadProjectTts(PROJECT_ID)?.provider).toBe("inworld")
    expect(loadProjectTts(PROJECT_ID)?.voices?.[0].language).toBe("en-US")
    expect(mockCapture).toHaveBeenCalledTimes(1)
    expect(mockCapture).toHaveBeenCalledWith(OMNIVOICE_VOICES_MIGRATED, {
      project_id: PROJECT_ID,
      source: "both",
      project_provider_migrated: true,
      voice_count: 1,
      cloned_voice_count: 0,
      from_languages: ["eng"],
      to_languages: ["en-US"],
    })
  })

  it("does not persist when settings are already inworld", async () => {
    const server: ProjectTtsSettings = {
      provider: "inworld",
      voices: [{ id: "v1", name: "Narrator", provider: "inworld", voiceName: "Dennis", language: "en-US" }],
    }
    const onSyncTts = vi.fn()
    renderHook(() => useProjectTts(PROJECT_ID, server, [], onSyncTts, "en"))
    await act(async () => {})
    expect(onSyncTts).not.toHaveBeenCalled()
    expect(loadProjectTts(PROJECT_ID)).toBeUndefined()
    expect(mockCapture).not.toHaveBeenCalled()
  })
})

// AQU-1943: the server caps the voice library, and this store is what a reload
// reads FIRST — so a refused value kept here would resurrect the voice the
// server just refused and re-send it on every later save.
describe("useProjectTts refused-write rollback (AQU-1943)", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(patchProject).mockClear()
    mockCapture.mockClear()
  })

  it("rolls the durable copy back to the pre-write settings when the server refuses the value", async () => {
    const PROJECT = "proj-tts-cap"
    const server: ProjectTtsSettings = {
      provider: "inworld",
      voices: [{ id: "v1", name: "Narrator", provider: "inworld", voiceName: "Dennis", language: "en-US" }],
    }
    const onSyncTts = vi.fn(async () => ({ rejected: true }))
    const { result } = renderHook(() => useProjectTts(PROJECT, server, [], onSyncTts, "en"))

    await act(async () => {
      await result.current.saveTts({
        voices: [...(server.voices ?? []), { id: "v2", name: "Over the cap", provider: "inworld" }],
      })
    })

    await waitFor(() => expect(loadProjectTts(PROJECT)?.voices).toHaveLength(1))
    expect(loadProjectTts(PROJECT)?.voices?.[0].id).toBe("v1")
    expect(result.current.voices.map((v) => v.id)).toEqual(["v1"])
  })

  it("does not undo a later save that succeeded", async () => {
    const PROJECT = "proj-tts-race"
    let settle: ((outcome: { rejected: boolean }) => void) | null = null
    const onSyncTts = vi
      .fn()
      // The refused write answers LAST, after the accepted one has landed.
      .mockImplementationOnce(() => new Promise<{ rejected: boolean }>((r) => { settle = r }))
      .mockImplementation(async () => ({ rejected: false }))
    const { result } = renderHook(() => useProjectTts(PROJECT, undefined, [], onSyncTts, "en"))

    await act(async () => {
      await result.current.saveTts({ voices: [{ id: "big", name: "Over the cap", provider: "inworld" }] })
    })
    await act(async () => {
      await result.current.saveTts({ voices: [{ id: "small", name: "Pruned", provider: "inworld" }] })
    })
    await act(async () => {
      settle?.({ rejected: true })
    })

    await waitFor(() => expect(onSyncTts).toHaveBeenCalledTimes(2))
    expect(loadProjectTts(PROJECT)?.voices?.[0].id).toBe("small")
  })

  it("keeps the durable copy when the write is merely blocked (role / offline)", async () => {
    const PROJECT = "proj-tts-blocked"
    const onSyncTts = vi.fn(async () => ({ rejected: false }))
    const { result } = renderHook(() => useProjectTts(PROJECT, undefined, [], onSyncTts, "en"))

    await act(async () => {
      await result.current.saveTts({
        voices: [{ id: "v9", name: "Local only", provider: "inworld" }],
      })
    })

    await waitFor(() => expect(onSyncTts).toHaveBeenCalled())
    expect(loadProjectTts(PROJECT)?.voices?.[0].id).toBe("v9")
  })
})
