/**
 * NewVoiceModal.test.tsx — engine (TTS provider) selection during creation.
 *
 * The creation modal must honor the project's configured engine, not hardcode
 * Gemini: a Kokoro/MMS/OmniVoice project creates voices on that engine, and
 * the user can switch engines per-voice. Regression guard for the f7abd8790
 * simplification that dropped the 4-engine picker.
 */

import { afterEach, describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NewVoiceModal } from "./NewVoiceModal"
import type { TtsProvider, Voice } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { GEMINI_TTS_VOICES } from "@/lib/audio/tts-providers"
import { buildVoiceReferenceId, uploadVoiceReference } from "@/lib/audio/voice-clone"
import { parseFrontierAudioUrl, fetchCellAudio } from "@/lib/audio/upload"

// Stub heavy audio / network dependencies; the engine picker itself is pure UI.
vi.mock("@/components/VoiceCloneSection", () => ({
  VoiceCloneSection: ({
    voice,
    onChange,
  }: {
    voice: Voice
    onChange: (patch: Partial<Voice>) => void
  }) => (
    <>
      <button
        type="button"
        onClick={() => onChange({ referenceAudioId: "ref.webm", referenceTakeKey: undefined })}
      >
        Add reference
      </button>
      <span>{voice.referenceAudioId && !voice.referenceTakeKey ? "clip filled" : "clip empty"}</span>
    </>
  ),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "tok",
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
  initialMode,
  cells = [],
  seedCellId,
  projectId,
}: {
  provider?: TtsProvider
  targetLanguage?: string
  paletteIndex?: number
  onSave?: (v: Voice) => void
  initialMode?: "tts" | "clone"
  cells?: CellData[]
  seedCellId?: string | null
  projectId?: string
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
      cells={cells}
      onSave={onSave}
      initialMode={initialMode}
      seedCellId={seedCellId}
      projectId={projectId}
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
  afterEach(() => {
    vi.unstubAllGlobals()
  })
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

  it("shows the engine's one knob: Describe for Gemini, speaker list for Kokoro", () => {
    renderCreate({ provider: "gemini" })
    expect(screen.getByLabelText("Describe the voice")).toBeTruthy()
    fireEvent.click(engineCard(/Kokoro/))
    expect(screen.queryByLabelText("Describe the voice")).toBeNull()
    expect(screen.getByRole("combobox", { name: "Voice" })).toBeTruthy()
  })

  it("lists British speakers first when the project target is en-gb", async () => {
    const user = userEvent.setup()
    const { onSave } = renderCreate({ provider: "kokoro", targetLanguage: "en-gb" })
    const trigger = screen.getByRole("combobox", { name: "Voice" })
    expect(trigger).toHaveTextContent(/Emma/)
    await user.click(trigger)
    const options = screen.getAllByRole("option")
    expect(options[0]).toHaveTextContent(/Emma/)
    await user.click(screen.getByRole("option", { name: /Bella/ }))
    create()
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.voiceName).toBe("af_bella")
  })

  it("plays a Kokoro sample without changing the selected speaker", async () => {
    const play = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal(
      "Audio",
      class {
        src = ""
        play = play
        pause = vi.fn()
        load = vi.fn()
        removeAttribute = vi.fn()
        addEventListener = vi.fn()
        constructor(src?: string) {
          this.src = src ?? ""
        }
      },
    )
    const user = userEvent.setup()
    const { onSave } = renderCreate({ provider: "kokoro", targetLanguage: "en-gb" })
    await user.click(screen.getByRole("combobox", { name: "Voice" }))
    await user.click(screen.getByRole("button", { name: "Play Bella sample" }))
    expect(play).toHaveBeenCalled()
    expect(screen.getByRole("combobox", { name: "Voice" })).toHaveTextContent(/Emma/)
    await user.click(screen.getByRole("option", { name: /Bella/ }))
    create()
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.voiceName).toBe("af_bella")
  })

  it("explains that Kokoro is English-only for a non-English project language", () => {
    renderCreate({ provider: "kokoro", targetLanguage: "es" })
    expect(screen.getByText(/On-device Kokoro speaks English/)).toBeTruthy()
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

describe("NewVoiceModal clone tab engines", () => {
  it("offers only cloud clone engines, not Kokoro or MMS", () => {
    renderCreate({ provider: "omnivoice", initialMode: "clone" })
    expect(engineCard(/OmniVoice/)).toBeTruthy()
    expect(engineCard(/Gemini/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Kokoro/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /MMS/ })).toBeNull()
  })

  it("remaps a Kokoro project default to OmniVoice on the clone tab", () => {
    renderCreate({ provider: "kokoro", initialMode: "clone" })
    expect(engineCard(/OmniVoice/).getAttribute("aria-pressed")).toBe("true")
    expect(screen.queryByRole("button", { name: /Kokoro/ })).toBeNull()
  })

  it("keeps Gemini when the project default already clones", () => {
    renderCreate({ provider: "gemini", initialMode: "clone" })
    expect(engineCard(/Gemini/).getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByLabelText("Describe the voice")).toBeTruthy()
  })

  it("lets the user pick Gemini as the clone engine and saves it", () => {
    const { onSave } = renderCreate({ provider: "omnivoice", initialMode: "clone" })
    fireEvent.click(engineCard(/Gemini/))
    fireEvent.click(screen.getByRole("button", { name: "Add reference" }))
    create("Keean")
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.provider).toBe("gemini")
    expect(saved.referenceAudioId).toBe("ref.webm")
  })

  it("switching from the TTS tab remaps Kokoro to OmniVoice", () => {
    renderCreate({ provider: "kokoro" })
    expect(engineCard(/Kokoro/).getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(screen.getByRole("tab", { name: /Clone voice/ }))
    expect(engineCard(/OmniVoice/).getAttribute("aria-pressed")).toBe("true")
    expect(screen.queryByRole("button", { name: /Kokoro/ })).toBeNull()
  })
})

const lineTakeCell = {
  id: "cell-1",
  fileId: "file-1",
  type: "text",
  translated: "hola mundo",
  selectedAudioId: "a1",
  attachments: { a1: { url: "frontier-audio://a1.webm" } },
} as unknown as CellData

describe("NewVoiceModal clone reference source tabs", () => {
  it("splits record/upload and reuse-from-a-line into tabs", () => {
    renderCreate({ provider: "omnivoice", initialMode: "clone" })
    expect(screen.getByRole("tab", { name: "Reference audio" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "From a line" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Add reference" })).toBeTruthy()
  })

  it("shows an empty state on From a line when the file has no takes", () => {
    renderCreate({ provider: "omnivoice", initialMode: "clone" })
    fireEvent.click(screen.getByRole("tab", { name: "From a line" }))
    expect(screen.getByText(/No line audio yet/)).toBeTruthy()
  })

  it("opens From a line when seeded from a cell take", () => {
    renderCreate({
      provider: "omnivoice",
      initialMode: "clone",
      cells: [lineTakeCell],
      seedCellId: "cell-1",
    })
    expect(screen.getByRole("tab", { name: "From a line" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByRole("button", { name: /hola mundo/ })).toBeTruthy()
  })

  it("scrolls the seeded take into view when cloning from that line", () => {
    const spy = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {})
    const cells = Array.from({ length: 12 }, (_, i) => ({
      id: `cell-${i}`,
      fileId: "file-1",
      type: "text",
      translated: `line ${i} of the chapter`,
      selectedAudioId: `a${i}`,
      attachments: { [`a${i}`]: { url: `frontier-audio://a${i}.webm` } },
    })) as unknown as CellData[]
    renderCreate({
      provider: "omnivoice",
      initialMode: "clone",
      cells,
      seedCellId: "cell-11",
    })
    expect(screen.getByRole("button", { name: /line 11/ })).toBeTruthy()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("marks the chosen line with a check and generated takes with a sparkle", () => {
    renderCreate({
      provider: "omnivoice",
      initialMode: "clone",
      cells: [
        lineTakeCell,
        {
          id: "cell-2",
          fileId: "file-1",
          type: "text",
          translated: "generated line",
          selectedGeneratedVoiceAudioId: "g1",
          attachments: { g1: { url: "frontier-audio://g1.webm" } },
        } as unknown as CellData,
      ],
      seedCellId: "cell-1",
    })
    const chosen = screen.getByRole("button", { name: /hola mundo/ })
    const other = screen.getByRole("button", { name: /generated line/ })
    expect(chosen.getAttribute("aria-pressed")).toBe("true")
    expect(chosen.className).not.toMatch(/bg-emerald/)
    expect(chosen.querySelector(".lucide-check")).toBeTruthy()
    expect(other.getAttribute("aria-pressed")).toBe("false")
    expect(other.querySelector(".lucide-check")).toBeNull()
    expect(screen.getByLabelText("AI-generated")).toBeTruthy()
    expect(screen.getAllByRole("button", { name: "Play take" })).toHaveLength(2)
    expect(screen.queryByText("Recorded")).toBeNull()
    expect(screen.queryByText("AI-generated")).toBeNull()
  })

  it("does not fill Reference audio when a line take is reused", async () => {
    vi.mocked(parseFrontierAudioUrl).mockReturnValue({ audioId: "a1", ext: "webm" })
    vi.mocked(fetchCellAudio).mockResolvedValue(new Uint8Array([1]))
    vi.mocked(buildVoiceReferenceId).mockReturnValue("ref-line.webm")
    vi.mocked(uploadVoiceReference).mockResolvedValue(undefined)

    const { onSave } = renderCreate({
      provider: "omnivoice",
      initialMode: "clone",
      cells: [lineTakeCell],
      seedCellId: "cell-1",
      projectId: "p",
    })
    fireEvent.click(screen.getByRole("button", { name: /hola mundo/ }))
    await waitFor(() => expect(uploadVoiceReference).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("tab", { name: "Reference audio" }))
    expect(screen.getByText("clip empty")).toBeTruthy()
    expect(screen.queryByText("clip filled")).toBeNull()
    create("Keean")
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.referenceAudioId).toBe("ref-line.webm")
    expect(saved.referenceTakeKey).toBe("cell-1:recorded")
  })

  it("shows a spinner in the check slot while lifting, then the check", async () => {
    let finishUpload: () => void = () => {}
    vi.mocked(parseFrontierAudioUrl).mockReturnValue({ audioId: "a1", ext: "webm" })
    vi.mocked(fetchCellAudio).mockResolvedValue(new Uint8Array([1]))
    vi.mocked(buildVoiceReferenceId).mockReturnValue("ref-line.webm")
    vi.mocked(uploadVoiceReference).mockReturnValue(new Promise<void>((resolve) => { finishUpload = resolve }))

    renderCreate({
      provider: "omnivoice",
      initialMode: "clone",
      cells: [lineTakeCell],
      seedCellId: "cell-1",
      projectId: "p",
    })
    fireEvent.click(screen.getByRole("button", { name: /hola mundo/ }))
    expect(await screen.findByLabelText("Lifting take…")).toBeTruthy()
    expect(screen.queryByText("Lifting take…")).toBeNull()
    finishUpload()
    await waitFor(() => {
      expect(screen.queryByLabelText("Lifting take…")).toBeNull()
    })
    expect(screen.getByRole("button", { name: /hola mundo/ }).querySelector(".lucide-check")).toBeTruthy()
  })
})
