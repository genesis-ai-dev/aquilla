import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

vi.mock("@/lib/store/project-index", () => ({
  patchProject: vi.fn(async () => {}),
}))

import { useProjectTts } from "./useProjectTts"
import { loadProjectTts } from "@/lib/store/project-tts-store"
import { patchProject } from "@/lib/store/project-index"
import { DEFAULT_INWORLD_VOICE } from "@/lib/audio/tts-providers"

const PROJECT_ID = "proj-omnivoice-migrate"

describe("useProjectTts OmniVoice persist (AQU-1189)", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(patchProject).mockClear()
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
  })
})
