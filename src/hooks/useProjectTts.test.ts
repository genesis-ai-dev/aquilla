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

// AQU-2125: a character is cast once, a save folds line-by-line casting, and a
// surface that only knows a line id still hears the character's voice.
describe("useProjectTts casting by character (AQU-2125)", () => {
  const PROJECT = "proj-character-cast"
  const voices = [{ id: "v-n", name: "Narrator" }, { id: "v-j", name: "JESUS" }, { id: "v-new", name: "Clone" }]
  const line = (id: string, castName?: string) =>
    ({ id, fileId: "f1", index: 0, original: "", translated: "x", context: "", group: "", type: "text", status: "unvalidated", validationStatus: "unvalidated", activeValidators: [], validated: false, ...(castName ? { castName } : {}) }) as never

  beforeEach(() => {
    localStorage.clear()
  })

  it("lets a line found by id alone hear its character's voice", () => {
    const server: ProjectTtsSettings = { voices, castAssignments: { "character:JESUS": "v-j" } }
    const { result } = renderHook(() => useProjectTts(PROJECT, server, [line("a", "JESUS"), line("b")], vi.fn()))
    expect(result.current.laneSettings?.castAssignments?.a).toBe("v-j")
    expect(result.current.laneSettings?.castAssignments).not.toHaveProperty("b")
    // …in the view only: the stored settings stay one entry per character.
    expect(result.current.settings?.castAssignments).toEqual({ "character:JESUS": "v-j" })
    expect(result.current.castStats.get("v-j")?.assigned).toBe(1)
  })

  it("folds the lines in view on a save by someone who may rewrite the project cast", async () => {
    const server: ProjectTtsSettings = { voices, castAssignments: { a: "v-j", b: "v-j", c: "v-n" } }
    const cells = [line("a", "JESUS"), line("b", "JESUS"), line("c", "JESUS")]
    const onSync = vi.fn()
    const { result } = renderHook(() =>
      useProjectTts(PROJECT, server, cells, onSync, undefined, null, "", { mayWriteProjectCast: true }),
    )
    await act(async () => { await result.current.saveTts({ provider: "inworld" }) })
    expect(loadProjectTts(PROJECT)?.castAssignments).toEqual({ "character:JESUS": "v-j", c: "v-n" })
    expect(onSync.mock.calls.at(-1)?.[0].castAssignments).toEqual({ "character:JESUS": "v-j", c: "v-n" })
  })

  it("leaves the project cast alone for a role that may not rewrite it", async () => {
    const server: ProjectTtsSettings = { voices, castAssignments: { a: "v-j", b: "v-j" } }
    const { result } = renderHook(() =>
      useProjectTts(PROJECT, server, [line("a", "JESUS"), line("b", "JESUS")], vi.fn(), undefined, null, "", { mayWriteProjectCast: false }),
    )
    await act(async () => { await result.current.saveTts({ provider: "inworld" }) })
    expect(loadProjectTts(PROJECT)?.castAssignments).toEqual({ a: "v-j", b: "v-j" })
  })

  it("casts a whole character on the lane with one entry", async () => {
    const server: ProjectTtsSettings = { voices, castAssignments: { "character:JESUS": "v-j" } }
    const { result } = renderHook(() =>
      useProjectTts(PROJECT, server, [line("a", "JESUS"), line("b", "JESUS")], vi.fn()),
    )
    await act(async () => { result.current.assignCharacter("JESUS", "v-new", ["a", "b"]) })
    expect(loadProjectTts(PROJECT)?.laneCastAssignments).toEqual({ "": { "character:JESUS": "v-new" } })
    expect(result.current.laneSettings?.castAssignments?.a).toBe("v-new")
    expect(result.current.laneSettings?.castAssignments?.b).toBe("v-new")
  })
})

describe("applySplitCastCopies (AQU-2101)", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(patchProject).mockClear()
  })

  it("copies each lane's voice onto the new narration pieces without a settings save", () => {
    const server: ProjectTtsSettings = {
      provider: "inworld",
      voices: [{ id: "sina", name: "Sina", provider: "inworld", voiceName: "Dennis", language: "en-US" }],
      castAssignments: { line: "narrator" },
      laneCastAssignments: {
        sm: { line: "sina" },
        ar: { line: "layla" },
      },
    }
    const onSyncTts = vi.fn()
    const { result } = renderHook(() => useProjectTts("proj-split-cast", server, [], onSyncTts, "en"))
    act(() => {
      result.current.applySplitCastCopies([{ cellId: "line", sameKindAsFirst: ["line-b"] }])
    })
    const stored = loadProjectTts("proj-split-cast")
    expect(stored?.castAssignments).toEqual({ line: "narrator", "line-b": "narrator" })
    expect(stored?.laneCastAssignments).toEqual({
      sm: { line: "sina", "line-b": "sina" },
      ar: { line: "layla", "line-b": "layla" },
    })
    expect(onSyncTts).not.toHaveBeenCalled()
  })
})
