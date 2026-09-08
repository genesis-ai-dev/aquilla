/**
 * InworldVoiceField — live catalog for the project's target-language lanes.
 * Language badges appear only when there is more than one lane (AQU-1189).
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InworldVoiceField } from "./InworldVoiceField"
import { listInworldVoices } from "@/lib/sync/tts"
import { __resetInworldCatalogCacheForTests } from "@/lib/audio/inworld-voices"
import type { FrontierSession } from "@/lib/frontier/types"

vi.mock("@/lib/sync/tts", () => ({
  synthesizeCellTts: vi.fn(),
  listInworldVoices: vi.fn(),
  listInworldSupportedLanguages: vi.fn().mockResolvedValue([]),
}))

const session = { jwt: "tok", username: "dev" } as FrontierSession

function renderField(languages: string[], language?: string, value = "Dennis") {
  const onChange = vi.fn()
  render(
    <InworldVoiceField
      value={value}
      language={language}
      onChange={onChange}
      targetLanguages={languages}
      projectId="p1"
      fileId="f1"
      session={session}
    />,
  )
  return { onChange }
}

describe("InworldVoiceField", () => {
  afterEach(() => {
    __resetInworldCatalogCacheForTests()
    vi.mocked(listInworldVoices).mockReset()
  })

  it("lists voices returned for every target-language lane", async () => {
    vi.mocked(listInworldVoices).mockResolvedValue([
      { voiceId: "Dennis", displayName: "Dennis", language: "en-US" },
      { voiceId: "Diego", displayName: "Diego", language: "es-ES" },
    ])
    const user = userEvent.setup()
    renderField(["en", "es"])
    await screen.findByText("Dennis")
    await user.click(screen.getByRole("combobox", { name: "Voice" }))
    expect(await screen.findByRole("option", { name: /Dennis/ })).toBeTruthy()
    expect(screen.getByRole("option", { name: /Diego/ })).toBeTruthy()
    expect(screen.getAllByText("en-US").length).toBeGreaterThan(0)
    expect(screen.getAllByText("es-ES").length).toBeGreaterThan(0)
  })

  it("does not badge names when the project has a single language lane", async () => {
    vi.mocked(listInworldVoices).mockResolvedValue([
      { voiceId: "Dennis", displayName: "Dennis", language: "en-US" },
      { voiceId: "Sarah", displayName: "Sarah", language: "en-US" },
    ])
    const user = userEvent.setup()
    renderField(["en"])
    await screen.findByText("Dennis")
    await user.click(screen.getByRole("combobox", { name: "Voice" }))
    expect(await screen.findByRole("option", { name: "Dennis" })).toBeTruthy()
    expect(screen.queryByText("en-US")).toBeNull()
  })

  it("fetches the user-chosen language when the lane is not a code Inworld maps", async () => {
    vi.mocked(listInworldVoices).mockResolvedValue([
      { voiceId: "Emile", displayName: "Emile", language: "fr-FR" },
    ])
    renderField(["French"], "fr-FR")
    await waitFor(() => {
      expect(listInworldVoices).toHaveBeenCalledWith(
        expect.objectContaining({ languages: ["fr-FR"] }),
        expect.any(Function),
      )
    })
  })

  it("keeps a designed voice id that is not in the catalog", async () => {
    vi.mocked(listInworldVoices).mockResolvedValue([
      { voiceId: "Dennis", displayName: "Dennis", language: "en-US" },
    ])
    const { onChange } = renderField(["en"], undefined, "ws__design-voice-38b05df9")
    expect(await screen.findByText("Designed voice")).toBeTruthy()
    await waitFor(() => {
      expect(listInworldVoices).toHaveBeenCalled()
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})
