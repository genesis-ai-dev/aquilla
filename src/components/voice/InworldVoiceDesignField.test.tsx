import { afterEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InworldVoiceDesignField, type InworldDesignSelection } from "./InworldVoiceDesignField"
import { designInworldVoice, synthesizeCellTts } from "@/lib/sync/tts"
import { getCellAudioStreamUrl, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT } from "@/lib/audio/inworld-voice-design"
import type { FrontierSession } from "@/lib/frontier/types"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"

vi.mock("@/lib/sync/tts", () => ({
  designInworldVoice: vi.fn(),
  publishInworldVoice: vi.fn(),
  listInworldVoices: vi.fn().mockResolvedValue([]),
  listInworldSupportedLanguages: vi.fn().mockResolvedValue([]),
  synthesizeCellTts: vi.fn(),
}))

vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "tok",
}))

vi.mock("@/lib/audio/upload", () => ({
  parseFrontierAudioUrl: vi.fn(),
  getCellAudioStreamUrl: vi.fn(),
}))

const session = { jwt: "tok", username: "dev" } as FrontierSession
const LONG_PROMPT = "A middle-aged male voice with a clear British accent speaking at a steady pace and with a warm, neutral tone."

function renderField(opts: {
  prompt?: string
  onPromptChange?: (prompt: string) => void
  onSelectionChange?: (selection: InworldDesignSelection | null) => void
  existingVoiceId?: string
  speakingRate?: number
  deliveryMode?: "STABLE" | "BALANCED" | "CREATIVE"
  audioQuality?: "standard" | "highest"
} = {}) {
  const onPromptChange = opts.onPromptChange ?? vi.fn()
  const onSelectionChange = opts.onSelectionChange ?? vi.fn()
  function Harness() {
    const [selection, setSelection] = useState<InworldDesignSelection | null>(null)
    const [language, setLanguage] = useState("en-US")
    return (
      <InworldVoiceDesignField
        prompt={opts.prompt ?? ""}
        onPromptChange={onPromptChange}
        selection={selection}
        onSelectionChange={(next) => {
          onSelectionChange(next)
          setSelection(next)
        }}
        existingVoiceId={opts.existingVoiceId}
        language={language}
        onLanguageChange={setLanguage}
        projectId="p1"
        fileId="f1"
        session={session}
        speakingRate={opts.speakingRate}
        deliveryMode={opts.deliveryMode}
        audioQuality={opts.audioQuality}
      />
    )
  }
  const view = renderWithTooltips(<Harness />)
  return { onPromptChange, onSelectionChange, unmount: view.unmount }
}

describe("InworldVoiceDesignField", () => {
  afterEach(() => {
    vi.mocked(designInworldVoice).mockReset()
    vi.mocked(synthesizeCellTts).mockReset()
    vi.mocked(parseFrontierAudioUrl).mockReset()
    vi.mocked(getCellAudioStreamUrl).mockReset()
    vi.unstubAllGlobals()
  })

  it("disables Generate until the description is at least 30 characters", () => {
    renderField({ prompt: "too short for a useful voice" })
    expect(screen.getByText(/at least 30 characters/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Generate previews" })).toBeDisabled()
  })

  it("disables Generate when the preview script is too short", async () => {
    const user = userEvent.setup()
    renderField({ prompt: LONG_PROMPT })
    expect(screen.getByRole("button", { name: "Generate previews" })).toBeEnabled()
    await user.clear(screen.getByLabelText("Preview script"))
    await user.type(screen.getByLabelText("Preview script"), "too short")
    expect(screen.getByText(/at least 50 characters/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Generate previews" })).toBeDisabled()
  })

  it("explains the preview script behind an info icon on the label", async () => {
    renderField()
    const help =
      "The previews speak this. About 50–400 characters in English shapes the voice best."
    expect(screen.queryByRole("tooltip")).toBeNull()
    expect(screen.queryByText(help)).toBeNull()
    const hint = screen.getByRole("button", { name: "About the preview script" })
    await expectTooltip(hint, help)
    expect(screen.getByLabelText("Preview script")).toHaveAccessibleName("Preview script")
  })

  it("puts the prompt hint above the textarea with the guide inline", () => {
    renderField()
    const label = screen.getByText("Describe the voice")
    const hint = screen.getByText(/Write in English/)
    const input = screen.getByLabelText("Describe the voice")
    const guide = screen.getByRole("link", { name: /Voice design guide/ })
    expect(label.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(hint.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(hint).toContainElement(guide)
  })

  it("places language and accent below the preview script", () => {
    renderField()
    const script = screen.getByLabelText("Preview script")
    const language = screen.getByRole("combobox", { name: "Language" })
    const accent = screen.getByRole("combobox", { name: "Accent" })
    const generate = screen.getByRole("button", { name: "Generate previews" })
    expect(script.compareDocumentPosition(language) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(language.compareDocumentPosition(accent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(accent.compareDocumentPosition(generate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("sends the chosen accent as the design language", async () => {
    const play = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal(
      "Audio",
      class {
        src = ""
        play = play
        pause = vi.fn()
        onended: (() => void) | null = null
        removeAttribute = vi.fn()
        load = vi.fn()
      },
    )
    vi.mocked(designInworldVoice).mockResolvedValue([
      { voiceId: "ws__design-voice-a", previewText: "Hello", previewAudio: "UklGRQ==" },
    ])
    const user = userEvent.setup()
    renderField({ prompt: LONG_PROMPT })
    await user.click(screen.getByRole("combobox", { name: "Accent" }))
    await user.click(await screen.findByRole("option", { name: /British/ }))
    await user.click(screen.getByRole("button", { name: "Generate previews" }))
    await waitFor(() => {
      expect(designInworldVoice).toHaveBeenCalledWith(
        expect.objectContaining({ language: "en-GB" }),
        expect.any(Function),
      )
    })
  })

  it("generates previews and auto-selects the first unpublished voice", async () => {
    const play = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal(
      "Audio",
      class {
        src = ""
        play = play
        pause = vi.fn()
        onended: (() => void) | null = null
        removeAttribute = vi.fn()
        load = vi.fn()
      },
    )
    vi.mocked(designInworldVoice).mockResolvedValue([
      { voiceId: "ws__design-voice-a", previewText: "Hello", previewAudio: "UklGRQ==" },
      { voiceId: "ws__design-voice-b", previewText: "Hello", previewAudio: "UklGRQ==" },
    ])
    const user = userEvent.setup()
    const { onSelectionChange } = renderField({ prompt: LONG_PROMPT })
    await user.click(screen.getByRole("button", { name: "Generate previews" }))
    await waitFor(() => {
      expect(designInworldVoice).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          designPrompt: LONG_PROMPT,
          previewText: INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT,
          language: "en-US",
          numberOfSamples: 3,
        }),
        expect.any(Function),
      )
    })
    expect(vi.mocked(designInworldVoice).mock.calls[0]?.[0].designPromptMode).toBeUndefined()
    expect(await screen.findByRole("radio", { name: "Preview 1" })).toBeChecked()
    expect(screen.getByRole("radio", { name: "Preview 2" })).not.toBeChecked()
    expect(onSelectionChange).toHaveBeenCalledWith({
      voiceId: "ws__design-voice-a",
      unpublished: true,
    })
    await waitFor(() => {
      expect(play).toHaveBeenCalledTimes(1)
      expect(screen.getByRole("button", { name: "Stop preview 1" })).toBeTruthy()
    })
    const firstRow = screen.getByRole("button", { name: "Stop preview 1" }).parentElement
    expect(firstRow).toContainElement(screen.getByRole("radio", { name: "Preview 1" }))
    expect(firstRow).toHaveClass("p-1")
    expect(firstRow).not.toHaveClass("pe-1")
    expect(screen.getByRole("radio", { name: "Preview 1" }).closest("label")).not.toHaveClass("cursor-pointer")

    await user.click(screen.getByRole("radio", { name: "Preview 2" }))
    expect(screen.getByRole("radio", { name: "Preview 2" })).toBeChecked()
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      voiceId: "ws__design-voice-b",
      unpublished: true,
    })
    await waitFor(() => {
      expect(play).toHaveBeenCalledTimes(2)
      expect(screen.getByRole("button", { name: "Stop preview 2" })).toBeTruthy()
    })
    const secondRow = screen.getByRole("button", { name: "Stop preview 2" }).parentElement
    expect(secondRow).toContainElement(screen.getByRole("radio", { name: "Preview 2" }))
  })

  it("stops preview audio when the field unmounts, even if play() settles later", async () => {
    let settlePlay: (() => void) | undefined
    const pause = vi.fn()
    const play = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { settlePlay = resolve }),
    )
    vi.stubGlobal(
      "Audio",
      class {
        src = ""
        play = play
        pause = pause
        onended: (() => void) | null = null
        removeAttribute = vi.fn()
        load = vi.fn()
      },
    )
    vi.mocked(designInworldVoice).mockResolvedValue([
      { voiceId: "ws__design-voice-a", previewText: "Hello", previewAudio: "UklGRQ==" },
    ])
    const user = userEvent.setup()
    const { unmount } = renderField({ prompt: LONG_PROMPT })
    await user.click(screen.getByRole("button", { name: "Generate previews" }))
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1))
    unmount()
    expect(pause).toHaveBeenCalled()
    const paused = pause.mock.calls.length
    settlePlay?.()
    await waitFor(() => expect(pause.mock.calls.length).toBeGreaterThan(paused))
  })

  it("explains that an already-published designed voice can be left as-is", () => {
    renderField({ existingVoiceId: "ws__design-voice-saved" })
    expect(screen.getByText("Saved voice")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Play saved voice" })).toBeEnabled()
    expect(screen.getByText(/Play it back, or generate new previews/i)).toBeTruthy()
  })

  it("plays a saved designed voice by synthesizing the preview script", async () => {
    const play = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal(
      "Audio",
      class {
        src = ""
        play = play
        pause = vi.fn()
        onended: (() => void) | null = null
        removeAttribute = vi.fn()
        load = vi.fn()
      },
    )
    vi.mocked(synthesizeCellTts).mockResolvedValue({
      audioId: "audio-tts-saved",
      durationSeconds: 2,
      objectName: "audio-tts-saved.wav",
      url: "frontier-audio://audio-tts-saved.wav",
    })
    vi.mocked(parseFrontierAudioUrl).mockReturnValue({ audioId: "audio-tts-saved", ext: "wav" })
    vi.mocked(getCellAudioStreamUrl).mockResolvedValue("https://stream.example/audio-tts-saved.wav")
    const user = userEvent.setup()
    renderField({
      existingVoiceId: "ws__design-voice-saved",
      speakingRate: 1.05,
      deliveryMode: "STABLE",
      audioQuality: "highest",
    })
    await user.click(screen.getByRole("button", { name: "Play saved voice" }))
    await waitFor(() => {
      expect(synthesizeCellTts).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          fileId: "f1",
          text: INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT,
          voiceId: "ws__design-voice-saved",
          language: "en-US",
          speakingRate: 1.05,
          deliveryMode: "STABLE",
          audioQuality: "highest",
        }),
        expect.any(Function),
      )
    })
    expect(getCellAudioStreamUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        fileId: "f1",
        audioId: "audio-tts-saved",
        ext: "wav",
      }),
    )
    await waitFor(() => {
      expect(play).toHaveBeenCalledTimes(1)
      expect(screen.getByRole("button", { name: "Stop saved voice" })).toBeTruthy()
    })

    await user.click(screen.getByRole("button", { name: "Stop saved voice" }))
    expect(screen.getByRole("button", { name: "Play saved voice" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Play saved voice" }))
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2))
    expect(synthesizeCellTts).toHaveBeenCalledTimes(1)
  })

  it("shows a selectable error when generation fails", async () => {
    vi.mocked(designInworldVoice).mockRejectedValue(new Error("Inworld 400: designPrompt too long"))
    const user = userEvent.setup()
    renderField({ prompt: LONG_PROMPT })
    await user.click(screen.getByRole("button", { name: "Generate previews" }))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Inworld 400: designPrompt too long")
    expect(alert).toHaveClass("select-text")
  })

  it("switches to Structured with one field per voice-profile attribute", async () => {
    const user = userEvent.setup()
    renderField()
    expect(screen.getByRole("tab", { name: "Freeform" })).toHaveAttribute("aria-selected", "true")
    await user.click(screen.getByRole("tab", { name: "Structured" }))
    expect(screen.getByRole("tab", { name: "Structured" })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByLabelText("Describe the voice")).toBeNull()
    expect(screen.getByLabelText("Dialect")).toBeTruthy()
    expect(screen.getByLabelText("Gender")).toBeTruthy()
    expect(screen.getByLabelText("Age")).toBeTruthy()
    expect(screen.getByLabelText("Emotion")).toBeTruthy()
    expect(screen.getByLabelText("Tone")).toBeTruthy()
    expect(screen.getByLabelText("Pitch")).toBeTruthy()
    expect(screen.getByLabelText("Volume")).toBeTruthy()
    expect(screen.getByLabelText("Speed")).toBeTruthy()
    expect(screen.getByLabelText("Clarity")).toBeTruthy()
    expect(screen.getByLabelText("Fluency")).toBeTruthy()
    expect(screen.getByLabelText("Personality")).toBeTruthy()
    expect(screen.getByLabelText("Texture")).toBeTruthy()
    expect(screen.getByLabelText("Environment")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Generate previews" })).toBeDisabled()
  })

  it("sends a verbatim structured profile when generating from Structured", async () => {
    const play = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal(
      "Audio",
      class {
        src = ""
        play = play
        pause = vi.fn()
        onended: (() => void) | null = null
        removeAttribute = vi.fn()
        load = vi.fn()
      },
    )
    vi.mocked(designInworldVoice).mockResolvedValue([
      { voiceId: "ws__design-voice-a", previewText: "Hello", previewAudio: "UklGRQ==" },
    ])
    const user = userEvent.setup()
    const { onPromptChange } = renderField()
    await user.click(screen.getByRole("tab", { name: "Structured" }))
    await user.type(screen.getByLabelText("Dialect"), "British English")
    await user.type(screen.getByLabelText("Gender"), "male")
    await user.type(screen.getByLabelText("Age"), "middle-aged")
    expect(onPromptChange).toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Generate previews" }))
    await waitFor(() => {
      expect(designInworldVoice).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          designPromptMode: "DESIGN_PROMPT_MODE_VERBATIM",
          language: "en-US",
          numberOfSamples: 3,
        }),
        expect.any(Function),
      )
    })
    const sent = vi.mocked(designInworldVoice).mock.calls[0]![0]
    expect(sent.designPrompt).toMatch(/^dialect: British English$/m)
    expect(sent.designPrompt).toMatch(/^gender: male$/m)
    expect(sent.designPrompt).toMatch(/^age: middle-aged$/m)
    expect(sent.designPrompt).toMatch(/^environment:$/m)
    expect(await screen.findByRole("radio", { name: "Preview 1" })).toBeChecked()
  })

  it("opens Structured when the saved prompt is already a voice profile", () => {
    renderField({
      prompt: [
        "dialect: British English",
        "gender: male",
        "age: ",
        "emotion: ",
        "tone: ",
        "pitch: ",
        "volume: ",
        "speed: ",
        "clarity: ",
        "fluency: ",
        "personality: ",
        "texture: ",
        "environment: ",
      ].join("\n"),
    })
    expect(screen.getByRole("tab", { name: "Structured" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByLabelText("Dialect")).toHaveValue("British English")
    expect(screen.getByLabelText("Gender")).toHaveValue("male")
    expect(screen.getByRole("button", { name: "Generate previews" })).toBeEnabled()
  })

  it("clears the structured profile back to empty fields", async () => {
    const user = userEvent.setup()
    const { onPromptChange } = renderField({
      prompt: [
        "dialect: British English",
        "gender: male",
        "age: ",
        "emotion: ",
        "tone: ",
        "pitch: ",
        "volume: ",
        "speed: ",
        "clarity: ",
        "fluency: ",
        "personality: ",
        "texture: ",
        "environment: ",
      ].join("\n"),
    })
    await user.click(screen.getByRole("button", { name: "Clear" }))
    expect(screen.getByLabelText("Dialect")).toHaveValue("")
    expect(screen.getByLabelText("Gender")).toHaveValue("")
    expect(onPromptChange).toHaveBeenCalledWith("")
    expect(screen.getByRole("button", { name: "Generate previews" })).toBeDisabled()
  })
})
