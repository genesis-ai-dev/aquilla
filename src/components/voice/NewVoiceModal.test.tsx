/**
 * NewVoiceModal.test.tsx — engine (TTS provider) selection during creation.
 *
 * The creation modal must honor the project's configured engine, not hardcode
 * Gemini: a Kokoro/MMS/Inworld project creates voices on that engine, and
 * the user can switch engines per-voice. Regression guard for the f7abd8790
 * simplification that dropped the 4-engine picker.
 */

import { afterEach, describe, it, expect, vi } from "vitest"
import { useState } from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NewVoiceModal } from "./NewVoiceModal"
import type { TtsProvider, Voice } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { GEMINI_TTS_VOICES } from "@/lib/audio/tts-providers"
import { buildVoiceReferenceId, uploadVoiceReference } from "@/lib/audio/voice-clone"
import { parseFrontierAudioUrl, fetchCellAudio } from "@/lib/audio/upload"
import { designInworldVoice, publishInworldVoice, listInworldSupportedLanguages } from "@/lib/sync/tts"
import { __resetInworldSupportedLanguagesCacheForTests } from "@/lib/audio/inworld-voices"
import type { InworldSupportedLanguage } from "@/lib/audio/inworld-supported-languages"
import type { FrontierSession } from "@/lib/frontier/types"

// Stub heavy audio / network dependencies; the engine picker itself is pure UI.
vi.mock("@/lib/sync/tts", () => ({
  listInworldVoices: vi.fn().mockResolvedValue([]),
  listInworldSupportedLanguages: vi.fn().mockResolvedValue([]),
  synthesizeCellTts: vi.fn(),
  designInworldVoice: vi.fn(),
  publishInworldVoice: vi.fn(),
}))
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
  getCellAudioStreamUrl: vi.fn(),
}))

function renderCreate({
  provider,
  targetLanguage,
  targetLanes,
  paletteIndex = 0,
  onSave = vi.fn(),
  initialMode,
  cells = [],
  seedCellId,
  projectId,
  fileId,
  session,
}: {
  provider?: TtsProvider
  targetLanguage?: string
  targetLanes?: string[]
  paletteIndex?: number
  onSave?: (v: Voice) => void
  initialMode?: "tts" | "clone"
  cells?: CellData[]
  seedCellId?: string | null
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
} = {}) {
  render(
    <NewVoiceModal
      open
      onClose={vi.fn()}
      voice={null}
      provider={provider}
      targetLanguage={targetLanguage}
      targetLanes={targetLanes}
      isDefault={false}
      paletteIndex={paletteIndex}
      cells={cells}
      onSave={onSave}
      initialMode={initialMode}
      seedCellId={seedCellId}
      projectId={projectId}
      fileId={fileId}
      session={session}
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
    __resetInworldSupportedLanguagesCacheForTests()
    vi.mocked(listInworldSupportedLanguages).mockReset()
    vi.mocked(listInworldSupportedLanguages).mockResolvedValue([])
  })
  it("offers all four engines", () => {
    renderCreate({ provider: "inworld" })
    for (const label of [/Inworld/, /Gemini/, /Kokoro/, /MMS/]) {
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
    const { onSave } = renderCreate({ provider: "inworld" })
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

  it("defaults to inworld when no project provider is passed", () => {
    const { onSave } = renderCreate()
    expect(engineCard(/Inworld/).getAttribute("aria-pressed")).toBe("true")
    create()
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.provider).toBe("inworld")
    expect(saved.voiceName).toBe("Dennis")
    expect(saved.audioQuality).toBe("highest")
    expect(saved.deliveryMode).toBe("STABLE")
  })

  it("remaps a persisted omnivoice project to the Inworld card", () => {
    renderCreate({ provider: "omnivoice" })
    expect(engineCard(/Inworld/).getAttribute("aria-pressed")).toBe("true")
    expect(screen.queryByRole("button", { name: /OmniVoice/ })).toBeNull()
  })

  it("shows Inworld quality, delivery, and talking speed on the TTS tab", () => {
    renderCreate({ provider: "inworld" })
    expect(screen.getByRole("switch", { name: "Audio quality" })).toBeTruthy()
    expect(screen.getByRole("group", { name: "Delivery" })).toBeTruthy()
    expect(screen.getByRole("group", { name: "Talking speed" })).toBeTruthy()
  })

  it("hides Inworld playground knobs when the engine is Gemini", () => {
    renderCreate({ provider: "inworld" })
    fireEvent.click(engineCard(/Gemini/))
    expect(screen.queryByRole("switch", { name: "Audio quality" })).toBeNull()
    expect(screen.getByLabelText("Describe the voice")).toBeTruthy()
  })

  it("explains that playground knobs do not affect Voice Design previews", async () => {
    const user = userEvent.setup()
    renderCreate({ provider: "inworld" })
    expect(screen.queryByText(/options below only apply/)).toBeNull()
    expect(screen.queryByText(/Previews ignore audio quality/)).toBeNull()
    await user.click(screen.getByRole("tab", { name: /Voice design/ }))
    expect(screen.getByText("Previews ignore audio quality, delivery, and talking speed.")).toBeTruthy()
    expect(screen.getByText("The options below only apply when you generate a line with this voice. They don't affect the voices you hear in this dialog.")).toBeTruthy()
  })

  it("defaults Inworld voices to Highest quality with Stable delivery", () => {
    const { onSave } = renderCreate({ provider: "inworld" })
    expect(screen.getByRole("switch", { name: "Audio quality" })).toBeChecked()
    expect(screen.getByText("Highest")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Best practices" })).toBeTruthy()
    expect(screen.getByRole("group", { name: "Delivery" })).not.toHaveAttribute("data-disabled")
    create()
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.audioQuality).toBe("highest")
    expect(saved.deliveryMode).toBe("STABLE")
  })

  it("saves Standard quality when Highest is turned off", async () => {
    const user = userEvent.setup()
    const { onSave } = renderCreate({ provider: "inworld" })
    await user.click(screen.getByRole("switch", { name: "Audio quality" }))
    expect(screen.queryByRole("link", { name: "Best practices" })).toBeNull()
    create()
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.audioQuality).toBe("standard")
  })

  it("maps a display-name project lane onto the searchable Inworld catalog", async () => {
    const user = userEvent.setup()
    const { onSave } = renderCreate({ provider: "inworld", targetLanguage: "French" })
    expect(screen.getByRole("combobox", { name: "Language" })).toBeTruthy()
    expect(screen.queryByText(/isn't a code Inworld recognizes/)).toBeNull()
    await user.click(screen.getByRole("combobox", { name: "Language" }))
    await user.click(await screen.findByRole("option", { name: /^French$/i }))
    create()
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.language).toBe("fr")
  })

  it("saves a searched Inworld language from the catalog", async () => {
    const user = userEvent.setup()
    const { onSave } = renderCreate({ provider: "inworld", targetLanguage: "French" })
    await user.click(screen.getByRole("combobox", { name: "Language" }))
    await user.type(screen.getByRole("combobox", { name: "Find a language" }), "swedish")
    await user.click(await screen.findByRole("option", { name: /^Swedish$/i }))
    create()
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.language).toBe("sv")
  })

  it("always offers the searchable Inworld language catalog on Prebuilt", async () => {
    const user = userEvent.setup()
    renderCreate({ provider: "inworld", targetLanguage: "en" })
    expect(screen.getByRole("combobox", { name: "Language" })).toBeTruthy()
    expect(screen.getByRole("combobox", { name: "Accent" })).toBeTruthy()
    expect(screen.getByRole("combobox", { name: "Voice" })).toBeTruthy()
    await user.click(screen.getByRole("combobox", { name: "Language" }))
    expect(screen.queryByRole("option", { name: "Other" })).toBeNull()
    expect(await screen.findByRole("option", { name: /^Swahili$/i })).toBeTruthy()
  })

  it("lets the user pick a catalog language when an extra lane is unrecognized", async () => {
    const user = userEvent.setup()
    const { onSave } = renderCreate({
      provider: "inworld",
      targetLanguage: "en",
      targetLanes: ["French"],
    })
    expect(screen.getByRole("combobox", { name: "Language" })).toBeTruthy()
    create()
    expect(onSave).toHaveBeenCalled()
    ;(onSave as ReturnType<typeof vi.fn>).mockClear()
    await user.click(screen.getByRole("combobox", { name: "Language" }))
    await user.click(await screen.findByRole("option", { name: /^French$/i }))
    create()
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.language).toBe("fr")
  })
})

describe("NewVoiceModal clone tab engines", () => {
  it("offers only cloud clone engines, not Kokoro or MMS", () => {
    renderCreate({ provider: "inworld", initialMode: "clone" })
    expect(engineCard(/Inworld/)).toBeTruthy()
    expect(engineCard(/Gemini/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Kokoro/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /MMS/ })).toBeNull()
  })

  it("remaps a Kokoro project default to Inworld on the clone tab", () => {
    renderCreate({ provider: "kokoro", initialMode: "clone" })
    expect(engineCard(/Inworld/).getAttribute("aria-pressed")).toBe("true")
    expect(screen.queryByRole("button", { name: /Kokoro/ })).toBeNull()
  })

  it("keeps Gemini when the project default already clones", () => {
    renderCreate({ provider: "gemini", initialMode: "clone" })
    expect(engineCard(/Gemini/).getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByLabelText("Describe the voice")).toBeTruthy()
  })

  it("lets the user pick Gemini as the clone engine and saves it", () => {
    const { onSave } = renderCreate({ provider: "inworld", initialMode: "clone" })
    fireEvent.click(engineCard(/Gemini/))
    fireEvent.click(screen.getByRole("button", { name: "Add reference" }))
    create("Keean")
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.provider).toBe("gemini")
    expect(saved.referenceAudioId).toBe("ref.webm")
  })

  it("switching from the TTS tab remaps Kokoro to Inworld", () => {
    renderCreate({ provider: "kokoro" })
    expect(engineCard(/Kokoro/).getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(screen.getByRole("tab", { name: /Clone voice/ }))
    expect(engineCard(/Inworld/).getAttribute("aria-pressed")).toBe("true")
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
    renderCreate({ provider: "inworld", initialMode: "clone" })
    expect(screen.getByRole("tab", { name: "Reference audio" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "From a line" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Add reference" })).toBeTruthy()
  })

  it("shows an empty state on From a line when the file has no takes", () => {
    renderCreate({ provider: "inworld", initialMode: "clone" })
    fireEvent.click(screen.getByRole("tab", { name: "From a line" }))
    expect(screen.getByText(/No line audio yet/)).toBeTruthy()
  })

  it("opens From a line when seeded from a cell take", () => {
    renderCreate({
      provider: "inworld",
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
      provider: "inworld",
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
      provider: "inworld",
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
      provider: "inworld",
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
      provider: "inworld",
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

  it("shows a selectable error when lifting a take has no project context", () => {
    renderCreate({
      provider: "inworld",
      initialMode: "clone",
      cells: [lineTakeCell],
      seedCellId: "cell-1",
    })
    fireEvent.click(screen.getByRole("button", { name: /hola mundo/ }))
    const alerts = screen.getAllByText("No project context to lift a take.")
    expect(alerts.length).toBeGreaterThan(0)
    expect(alerts.every((node) => node.classList.contains("select-text"))).toBe(true)
  })
})

const DESIGN_PROMPT =
  "A middle-aged male voice with a clear British accent speaking at a steady pace and with a warm, neutral tone."

describe("NewVoiceModal Inworld Voice Design", () => {
  afterEach(() => {
    vi.mocked(designInworldVoice).mockReset()
    vi.mocked(publishInworldVoice).mockReset()
    vi.mocked(uploadVoiceReference).mockReset()
    __resetInworldSupportedLanguagesCacheForTests()
    vi.mocked(listInworldSupportedLanguages).mockReset()
    vi.mocked(listInworldSupportedLanguages).mockResolvedValue([])
  })

  it("nests Prebuilt and Voice design under Inworld TTS", () => {
    renderCreate({ provider: "inworld" })
    expect(screen.getByRole("tab", { name: /Prebuilt voice/ })).toBeTruthy()
    expect(screen.getByRole("tab", { name: /Voice design/ })).toBeTruthy()
    expect(screen.getByRole("combobox", { name: "Voice" })).toBeTruthy()
  })

  it("opens Edit for an existing Inworld voice without crashing", () => {
    render(
      <NewVoiceModal
        open
        onClose={vi.fn()}
        voice={{
          id: "voice-1",
          name: "Narrator",
          color: "#e2e8f0",
          provider: "inworld",
          voiceName: "Dennis",
          language: "en-US",
          builtIn: false,
        }}
        isDefault={false}
        paletteIndex={0}
        cells={[]}
        onSave={vi.fn()}
      />,
    )
    expect(screen.getByText("Edit voice")).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Prebuilt voice" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Voice design" })).toBeTruthy()
  })

  it("opens Edit for a saved Voice Design voice on that tab with playback", () => {
    render(
      <NewVoiceModal
        open
        onClose={vi.fn()}
        voice={{
          id: "voice-1",
          name: "Designed",
          color: "#e2e8f0",
          provider: "inworld",
          voiceName: "ws__design-voice-saved",
          language: "en-US",
          builtIn: false,
        }}
        isDefault={false}
        paletteIndex={0}
        cells={[]}
        onSave={vi.fn()}
        projectId="p1"
        fileId="f1"
        session={{ jwt: "tok", username: "dev" } as FrontierSession}
      />,
    )
    expect(screen.getByText("Edit voice")).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Voice design" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByText("Saved voice")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Play saved voice" })).toBeEnabled()
  })

  it("hides the catalog picker on the Voice design tab", async () => {
    const user = userEvent.setup()
    renderCreate({ provider: "inworld" })
    await user.click(screen.getByRole("tab", { name: /Voice design/ }))
    expect(screen.queryByRole("combobox", { name: "Voice" })).toBeNull()
    expect(screen.getByLabelText("Describe the voice")).toBeTruthy()
    expect(screen.getByLabelText("Preview script")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Generate previews" })).toBeDisabled()
  })

  it("always offers Language and Accent on Voice design, without Other", async () => {
    const user = userEvent.setup()
    renderCreate({ provider: "inworld", targetLanguage: "en" })
    expect(screen.getByRole("combobox", { name: "Language" })).toBeTruthy()
    expect(screen.getByRole("combobox", { name: "Accent" })).toBeTruthy()
    await user.click(screen.getByRole("tab", { name: /Voice design/ }))
    expect(screen.getByRole("combobox", { name: "Language" })).toBeTruthy()
    expect(screen.getByRole("combobox", { name: "Accent" })).toBeTruthy()
    await user.click(screen.getByRole("combobox", { name: "Language" }))
    expect(screen.queryByRole("option", { name: "Other" })).toBeNull()
  })

  it("hides Other on Prebuilt and Voice design, and lists stock voices only on Prebuilt", async () => {
    vi.mocked(listInworldSupportedLanguages).mockResolvedValue([
      {
        code: "kbt",
        familyCode: "kbt",
        familyDisplayName: "Abadi",
        accentDisplayName: "",
        displayName: "Abadi",
        creationEnabled: true,
        hasVoices: false,
      } satisfies InworldSupportedLanguage,
      {
        code: "en",
        familyCode: "en",
        familyDisplayName: "English",
        accentDisplayName: "",
        displayName: "English",
        creationEnabled: true,
        hasVoices: true,
      },
      {
        code: "sw",
        familyCode: "sw",
        familyDisplayName: "Swahili",
        accentDisplayName: "",
        displayName: "Swahili",
        creationEnabled: true,
        hasVoices: true,
      },
    ])
    const user = userEvent.setup()
    renderCreate({
      provider: "inworld",
      targetLanguage: "en",
      projectId: "p1",
      fileId: "f1",
      session: { jwt: "tok", username: "dev" } as FrontierSession,
    })
    expect(screen.getByRole("button", { name: /Can't find the language/ })).toBeTruthy()
    await user.click(screen.getByRole("combobox", { name: "Language" }))
    expect(screen.queryByRole("option", { name: "Other" })).toBeNull()
    expect(screen.queryByRole("option", { name: /^Abadi$/i })).toBeNull()
    expect(await screen.findByRole("option", { name: /^Swahili$/i })).toBeTruthy()
    await user.keyboard("{Escape}")
    await user.click(screen.getByRole("button", { name: /Can't find the language/ }))
    expect(screen.getByRole("tab", { name: /Voice design/ })).toHaveAttribute("aria-selected", "true")
    await user.click(screen.getByRole("combobox", { name: "Language" }))
    expect(screen.queryByRole("option", { name: "Other" })).toBeNull()
    expect(await screen.findByRole("option", { name: /^Abadi$/i })).toBeTruthy()
  })

  it("blocks Create on Voice design until a preview is generated", async () => {
    const user = userEvent.setup()
    const { onSave } = renderCreate({ provider: "inworld" })
    await user.click(screen.getByRole("tab", { name: /Voice design/ }))
    create()
    expect(onSave).not.toHaveBeenCalled()
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent(/Generate previews and pick one/)
    expect(alert).toHaveClass("select-text")
  })

  it("publishes the chosen preview when Create is pressed", async () => {
    vi.mocked(designInworldVoice).mockResolvedValue([
      { voiceId: "ws__design-voice-a", previewText: "Hello", previewAudio: "UklGRQ==" },
    ])
    vi.mocked(publishInworldVoice).mockResolvedValue("ws__design-voice-a")
    vi.mocked(uploadVoiceReference).mockResolvedValue(undefined)
    const user = userEvent.setup()
    const { onSave } = renderCreate({
      provider: "inworld",
      projectId: "p1",
      fileId: "f1",
      session: { jwt: "tok", username: "dev" } as FrontierSession,
    })
    await user.click(screen.getByRole("tab", { name: /Voice design/ }))
    await user.type(screen.getByLabelText("Describe the voice"), DESIGN_PROMPT)
    await user.click(screen.getByRole("button", { name: "Generate previews" }))
    expect(await screen.findByText("Preview 1")).toBeTruthy()
    create("British narrator")
    await waitFor(() => {
      expect(publishInworldVoice).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          voiceId: "ws__design-voice-a",
          displayName: "British narrator",
        }),
        expect.any(Function),
      )
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = (onSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as Voice
    expect(saved.voiceName).toBe("ws__design-voice-a")
    expect(saved.prompt).toBe(DESIGN_PROMPT)
    expect(uploadVoiceReference).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        fileId: "f1",
        blob: expect.any(Blob),
      }),
    )
    expect(saved.designPreviewAudioId).toMatch(/^design-preview-.+\.wav$/)
  })

  it("stops the design preview when the dialog closes", async () => {
    const pause = vi.fn()
    vi.stubGlobal(
      "Audio",
      class {
        src = ""
        play = vi.fn().mockResolvedValue(undefined)
        pause = pause
        onended: (() => void) | null = null
        removeAttribute = vi.fn()
        load = vi.fn()
      },
    )
    vi.mocked(designInworldVoice).mockResolvedValue([
      { voiceId: "ws__design-voice-a", previewText: "Hello", previewAudio: "UklGRQ==" },
    ])
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <NewVoiceModal
          open={open}
          onClose={() => setOpen(false)}
          voice={null}
          provider="inworld"
          isDefault={false}
          paletteIndex={0}
          cells={[]}
          onSave={vi.fn()}
          projectId="p1"
          fileId="f1"
          session={{ jwt: "tok", username: "dev" } as FrontierSession}
        />
      )
    }
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("tab", { name: /Voice design/ }))
    await user.type(screen.getByLabelText("Describe the voice"), DESIGN_PROMPT)
    await user.click(screen.getByRole("button", { name: "Generate previews" }))
    expect(await screen.findByText("Preview 1")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(pause).toHaveBeenCalled()
  })
})
