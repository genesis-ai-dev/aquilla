/**
 * InworldVoiceField — live catalog for the project's target-language lanes.
 * Language badges appear only when there is more than one lane (AQU-1189).
 *
 * AQU-2035: when the lookup runs and the chosen language has no stock voices
 * (or the request fails), the picker is disabled on the voice that will be
 * saved. It no longer swaps in the built-in English list under a note reading
 * like an error.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InworldVoiceField } from "./InworldVoiceField"
import { listInworldVoices } from "@/lib/sync/tts"
import { __resetInworldCatalogCacheForTests } from "@/lib/audio/inworld-voices"
import { CATALOGS } from "@/lib/i18n/messages/all"
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

  // AQU-2035 — reported on Danish/Default: the lookup came back empty, the
  // field swapped in the built-in English list (Conrad, …) and printed
  // "Couldn't load Inworld voices…" under it. English voices are the wrong
  // choices for Danish and the note reads as an error, so the picker is
  // disabled on the saved voice instead.
  it("disables the picker and keeps the saved voice when the language has no stock voices", async () => {
    vi.mocked(listInworldVoices).mockResolvedValue([])
    const { onChange } = renderField(["Danish"], "da-DK", "Mads")
    const trigger = await screen.findByRole("combobox", { name: "Voice" })
    await waitFor(() => expect(trigger).toBeDisabled())
    expect(trigger).toHaveTextContent("Mads")
    expect(screen.queryByText(/Showing the built-in list/i)).toBeNull()
    expect(screen.queryByText("Dennis")).toBeNull()
    // The saved voice survives: nothing reselects it behind the user's back.
    expect(onChange).not.toHaveBeenCalled()
  })

  it("disables the picker when the voice lookup itself fails", async () => {
    vi.mocked(listInworldVoices).mockRejectedValue(new Error("network"))
    renderField(["Danish"], "da-DK", "Mads")
    const trigger = await screen.findByRole("combobox", { name: "Voice" })
    await waitFor(() => expect(trigger).toBeDisabled())
    expect(screen.queryByText(/Showing the built-in list/i)).toBeNull()
  })

  it("shows the built-in default rather than a blank when there is no saved voice", async () => {
    vi.mocked(listInworldVoices).mockResolvedValue([])
    renderField(["Danish"], "da-DK", undefined)
    const trigger = await screen.findByRole("combobox", { name: "Voice" })
    await waitFor(() => expect(trigger).toBeDisabled())
    expect(trigger).toHaveTextContent("Dennis")
  })

  it("re-enables the picker for a language that does have stock voices", async () => {
    vi.mocked(listInworldVoices).mockResolvedValue([
      { voiceId: "Dennis", displayName: "Dennis", language: "en-US" },
      { voiceId: "Sarah", displayName: "Sarah", language: "en-US" },
    ])
    const user = userEvent.setup()
    renderField(["en"])
    const trigger = await screen.findByRole("combobox", { name: "Voice" })
    await waitFor(() => expect(trigger).toBeEnabled())
    await user.click(trigger)
    expect(await screen.findByRole("option", { name: "Sarah" })).toBeTruthy()
  })

  // Same guard one layer down: a translated note would reappear in a
  // non-English UI if any catalog still carried the retired key.
  it("carries no built-in-list note in any locale (AQU-2035)", () => {
    const retired = "audio.newVoice.inworldVoiceUnavailable"
    const survivors = Object.entries(CATALOGS)
      .filter(([, catalog]) => retired in catalog)
      .map(([locale]) => locale)
    expect(survivors).toEqual([])
  })
})
