/**
 * NewVoiceModal.test.tsx — engine (TTS provider) selection during creation.
 *
 * The creation modal must honor the project's configured engine, not hardcode
 * Gemini: a Kokoro/MMS/OmniVoice project creates voices on that engine, and
 * the user can switch engines per-voice. Regression guard for the f7abd8790
 * simplification that dropped the 4-engine picker.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { NewVoiceModal } from "./NewVoiceModal"
import type { TtsProvider, Voice } from "@/lib/parsers/types"
import { GEMINI_TTS_VOICES } from "@/lib/audio/tts-providers"

// Stub heavy audio / network dependencies; the engine picker itself is pure UI.
vi.mock("@/components/VoiceCloneSection", () => ({
  VoiceCloneSection: () => null,
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: vi.fn(),
}))
vi.mock("@/lib/audio/voice-clone", () => ({
  buildVoiceReferenceId: vi.fn(),
  uploadVoiceReference: vi.fn(),
}))
vi.mock("@/lib/audio/upload", () => ({
  parseFrontierAudioUrl: vi.fn(),
  fetchCellAudio: vi.fn(),
}))

function renderCreate({
  provider,
  targetLanguage,
  paletteIndex = 0,
  onSave = vi.fn(),
}: {
  provider?: TtsProvider
  targetLanguage?: string
  paletteIndex?: number
  onSave?: (v: Voice) => void
} = {}) {
  render(
    <NewVoiceModal
      open
      onClose={vi.fn()}
      voice={null}
      provider={provider}
      targetLanguage={targetLanguage}
      isDefault={false}
      paletteIndex={paletteIndex}
      cells={[]}
      onSave={onSave}
    />,
  )
  return { onSave }
}

const engineCard = (name: RegExp) => screen.getByRole("button", { name })

function create(name = "Hero") {
  fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: name } })
  fireEvent.click(screen.getByRole("button", { name: /Create voice/ }))
}

describe("NewVoiceModal engine selection", () => {
  it("offers all four engines", () => {
    renderCreate({ provider: "omnivoice" })
    for (const label of [/OmniVoice/, /Gemini/, /Kokoro/, /MMS/]) {
      expect(engineCard(label)).toBeTruthy()
    }
  })

  it("seeds a new voice with the project's configured engine (kokoro)", () => {
    const { onSave } = renderCreate({ provider: "kokoro" })
    expect(engineCard(/Kokoro/).getAttribute("aria-pressed")).toBe("true")
    create()
    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.provider).toBe("kokoro")
    expect(saved.voiceName).toBe("af_heart")
  })

  it("seeds an MMS voice with the language inferred from targetLanguage", () => {
    const { onSave } = renderCreate({ provider: "mms", targetLanguage: "es" })
    create()
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.provider).toBe("mms")
    expect(saved.voiceName).toBe("spa")
  })

  it("lets the user switch engine before creating", () => {
    const { onSave } = renderCreate({ provider: "omnivoice" })
    fireEvent.click(engineCard(/Gemini/))
    expect(engineCard(/Gemini/).getAttribute("aria-pressed")).toBe("true")
    create()
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.provider).toBe("gemini")
    // Gemini keeps the rotated smart-default timbre (paletteIndex 0).
    expect(saved.voiceName).toBe(GEMINI_TTS_VOICES[0].name)
  })

  it("rotates the Gemini base timbre by paletteIndex", () => {
    const { onSave } = renderCreate({ provider: "gemini", paletteIndex: 2 })
    create()
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.voiceName).toBe(GEMINI_TTS_VOICES[2].name)
  })

  it("shows the engine's one knob: Describe for Gemini, voice id for Kokoro", () => {
    renderCreate({ provider: "gemini" })
    expect(screen.getByLabelText("Describe the voice")).toBeTruthy()
    fireEvent.click(engineCard(/Kokoro/))
    expect(screen.queryByLabelText("Describe the voice")).toBeNull()
    expect(screen.getByLabelText("Kokoro voice id")).toBeTruthy()
  })

  it("defaults to omnivoice when no project provider is passed", () => {
    const { onSave } = renderCreate()
    expect(engineCard(/OmniVoice/).getAttribute("aria-pressed")).toBe("true")
    create()
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.provider).toBe("omnivoice")
    expect(saved.voiceName).toBe("")
  })
})
