import { afterEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InworldVoiceDesignField, type InworldDesignSelection } from "./InworldVoiceDesignField"
import { designInworldVoice, synthesizeCellTts } from "@/lib/sync/tts"
import { getCellAudioStreamUrl, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { fetchVoiceReference } from "@/lib/audio/voice-clone"
import {
  INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT,
  blankStructuredDesignPrompt,
  inworldDesignPresetPrompt,
} from "@/lib/audio/inworld-voice-design"
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

vi.mock("@/lib/audio/voice-clone", () => ({
  fetchVoiceReference: vi.fn(),
}))

const session = { jwt: "tok", username: "dev" } as FrontierSession
const LONG_PROMPT = "A middle-aged male voice with a clear British accent speaking at a steady pace and with a warm, neutral tone."

function renderField(opts: {
  prompt?: string
  onPromptChange?: (prompt: string) => void
  onSelectionChange?: (selection: InworldDesignSelection | null) => void
  existingVoiceId?: string
  existingPreviewAudioId?: string
  speakingRate?: number
  deliveryMode?: "STABLE" | "BALANCED" | "CREATIVE"
  audioQuality?: "standard" | "highest"
} = {}) {
  const onPromptChange = opts.onPromptChange ?? vi.fn()
  const onSelectionChange = opts.onSelectionChange ?? vi.fn()
  function Harness() {
    const [selection, setSelection] = useState<InworldDesignSelection | null>(null)
    const [language, setLanguage] = useState("en-US")
    const [prompt, setPrompt] = useState(opts.prompt ?? "")
    return (
      <InworldVoiceDesignField
        prompt={prompt}
        onPromptChange={(next) => {
          onPromptChange(next)
          setPrompt(next)
        }}
        selection={selection}
        onSelectionChange={(next) => {
          onSelectionChange(next)
          setSelection(next)
        }}
        existingVoiceId={opts.existingVoiceId}
        existingPreviewAudioId={opts.existingPreviewAudioId}
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
    vi.mocked(fetchVoiceReference).mockReset()
    if (vi.isMockFunction(URL.createObjectURL)) vi.mocked(URL.createObjectURL).mockRestore()
    if (vi.isMockFunction(URL.revokeObjectURL)) vi.mocked(URL.revokeObjectURL).mockRestore()
    vi.unstubAllGlobals()
  })

  it("keeps Generate enabled and shows a field error when the description is too short", async () => {
    const user = userEvent.setup()
    renderField({ prompt: "too short for a useful voice" })
    const generate = screen.getByRole("button", { name: "Generate previews" })
    expect(generate).toBeEnabled()
    expect(screen.queryByText(/at least 30 characters/)).toBeNull()
    await user.click(generate)
    expect(screen.getByText(/at least 30 characters/)).toBeTruthy()
    expect(designInworldVoice).not.toHaveBeenCalled()
  })

  it("keeps Generate enabled and shows a field error when the preview script is too short", async () => {
    const user = userEvent.setup()
    renderField({ prompt: LONG_PROMPT })
    const generate = screen.getByRole("button", { name: "Generate previews" })
    expect(generate).toBeEnabled()
    await user.clear(screen.getByLabelText("Preview script"))
    await user.type(screen.getByLabelText("Preview script"), "too short")
    expect(generate).toBeEnabled()
    await user.click(generate)
    expect(screen.getByText(/at least 50 characters/)).toBeTruthy()
    expect(designInworldVoice).not.toHaveBeenCalled()
  })

  it("explains Freeform and Structured on hover", async () => {
    renderField()
    const freeformHelp =
      "Describe the voice in your own words, and we build the full voice profile from it"
    const structuredHelp =
      "Edit the voice profile directly for full control over the voice's nuances"
    expect(screen.queryByRole("tooltip")).toBeNull()
    await expectTooltip(screen.getByRole("tab", { name: "Freeform" }), freeformHelp)
    await expectTooltip(screen.getByRole("tab", { name: "Structured" }), structuredHelp)
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
    const tabs = screen.getByRole("tablist", { name: "Voice design mode" })
    const input = screen.getByLabelText("Describe the voice")
    const guide = screen.getByRole("link", { name: /Voice design guide/ })
    expect(label.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(hint.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tabs.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
      previewAudio: "UklGRQ==",
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
      previewAudio: "UklGRQ==",
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
    expect(screen.getByText(/Play the sample you picked, or generate new previews/i)).toBeTruthy()
  })

  it("plays a saved designed voice from the stored preview clip", async () => {
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
    vi.mocked(fetchVoiceReference).mockResolvedValue(new Uint8Array([1, 2, 3]))
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:design-preview")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    const user = userEvent.setup()
    renderField({
      existingVoiceId: "ws__design-voice-saved",
      existingPreviewAudioId: "design-preview-1.wav",
    })
    await user.click(screen.getByRole("button", { name: "Play saved voice" }))
    await waitFor(() => {
      expect(fetchVoiceReference).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          fileId: "f1",
          referenceAudioId: "design-preview-1.wav",
        }),
      )
    })
    expect(synthesizeCellTts).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(play).toHaveBeenCalledTimes(1)
      expect(screen.getByRole("button", { name: "Stop saved voice" })).toBeTruthy()
    })
    await user.click(screen.getByRole("button", { name: "Stop saved voice" }))
    await user.click(screen.getByRole("button", { name: "Play saved voice" }))
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2))
    expect(fetchVoiceReference).toHaveBeenCalledTimes(1)
  })

  it("plays a legacy designed voice by synthesizing the preview script", async () => {
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

  it("switches to Structured with a key: value textarea", async () => {
    const user = userEvent.setup()
    renderField()
    expect(screen.getByRole("tab", { name: "Freeform" })).toHaveAttribute("aria-selected", "true")
    await user.click(screen.getByRole("tab", { name: "Structured" }))
    expect(screen.getByRole("tab", { name: "Structured" })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByLabelText("Describe the voice")).toBeNull()
    const profile = screen.getByLabelText("Voice profile")
    const hint = screen.getByText(/One attribute per line/)
    const tabs = screen.getByRole("tablist", { name: "Voice design mode" })
    expect(hint.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tabs.compareDocumentPosition(profile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(profile).toHaveValue(blankStructuredDesignPrompt())
    expect(profile).toHaveClass("font-mono")
    expect(screen.queryByLabelText("Dialect")).toBeNull()
    expect(screen.getByRole("button", { name: "Generate previews" })).toBeEnabled()
    await user.click(screen.getByRole("button", { name: "Generate previews" }))
    expect(screen.getByText(/Fill in at least one attribute/)).toBeTruthy()
    expect(designInworldVoice).not.toHaveBeenCalled()
    const chips = screen.getByRole("group", { name: "Voice design presets" })
    const reset = screen.getByRole("button", { name: "Reset" })
    expect(reset).toBeDisabled()
    expect(chips.compareDocumentPosition(reset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
    const filled = [
      "dialect: British English",
      "gender: male",
      "age: middle-aged",
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
    ].join("\n")
    fireEvent.change(screen.getByLabelText("Voice profile"), { target: { value: filled } })
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
    const saved = [
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
    ].join("\n")
    renderField({ prompt: saved })
    expect(screen.getByRole("tab", { name: "Structured" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByLabelText("Voice profile")).toHaveValue(saved)
    expect(screen.getByRole("button", { name: "Generate previews" })).toBeEnabled()
  })

  it("clears the structured profile back to the empty template", async () => {
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
    const chips = screen.getByRole("group", { name: "Voice design presets" })
    const reset = screen.getByRole("button", { name: "Reset" })
    expect(chips.compareDocumentPosition(reset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await user.click(reset)
    expect(screen.getByLabelText("Voice profile")).toHaveValue(blankStructuredDesignPrompt())
    expect(onPromptChange).toHaveBeenCalledWith(blankStructuredDesignPrompt())
    expect(screen.getByRole("button", { name: "Generate previews" })).toBeEnabled()
    expect(reset).toBeDisabled()
  })

  it("places outline preset chips under the freeform prompt", () => {
    renderField()
    const input = screen.getByLabelText("Describe the voice")
    const group = screen.getByRole("group", { name: "Voice design presets" })
    expect(input.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByRole("button", { name: "Narrator" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Instructor" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Pirate" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Companion" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull()
  })

  it("fills Freeform from a preset and keeps Structured independent", async () => {
    const user = userEvent.setup()
    const { onPromptChange } = renderField()
    await user.click(screen.getByRole("button", { name: "Agent" }))
    const agent = inworldDesignPresetPrompt("agent", "freeform")
    expect(screen.getByLabelText("Describe the voice")).toHaveValue(agent)
    expect(onPromptChange).toHaveBeenCalledWith(agent)
    expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Generate previews" })).toBeEnabled()

    await user.click(screen.getByRole("tab", { name: "Structured" }))
    expect(screen.getByLabelText("Voice profile")).toHaveValue(blankStructuredDesignPrompt())
    expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "false")
    await user.click(screen.getByRole("button", { name: "Narrator" }))
    const narrator = inworldDesignPresetPrompt("narrator", "structured")
    expect(screen.getByLabelText("Voice profile")).toHaveValue(narrator)
    expect(screen.getByRole("button", { name: "Narrator" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Generate previews" })).toBeEnabled()

    await user.click(screen.getByRole("tab", { name: "Freeform" }))
    expect(screen.getByLabelText("Describe the voice")).toHaveValue(agent)
    expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true")
  })

  it("clears the selected preset after the profile is edited", async () => {
    const user = userEvent.setup()
    renderField()
    await user.click(screen.getByRole("tab", { name: "Structured" }))
    await user.click(screen.getByRole("button", { name: "Pirate" }))
    expect(screen.getByRole("button", { name: "Pirate" })).toHaveAttribute("aria-pressed", "true")
    await user.type(screen.getByLabelText("Voice profile"), " extra")
    expect(screen.getByRole("button", { name: "Pirate" })).toHaveAttribute("aria-pressed", "false")
  })
})
