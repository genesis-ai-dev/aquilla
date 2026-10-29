import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { renderWithTooltips, expectTooltip } from "@/test-utils/tooltip"
import { TooltipProvider } from "@/components/ui/tooltip"

const { play } = vi.hoisted(() => ({ play: vi.fn() }))

vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "idle", error: null, isPlaying: false, currentTime: 0, duration: 10,
    peaks: [], peaksState: "idle",
    play, pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
  }),
}))
vi.mock("@/lib/audio/voice-generate-helpers", () => ({
  generateCellVoice: vi.fn(async () => true),
}))
vi.mock("@/lib/audio/change-voice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audio/change-voice")>()),
  changeCellVoice: vi.fn(async () => true),
}))

import { CellVoicePanel } from "./CellVoicePanel"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { changeCellVoice, voiceReferenceFingerprint } from "@/lib/audio/change-voice"

const stock: Voice = { id: "v-mary", name: "Mary", color: "#000", provider: "gemini", voiceName: "Kore", prompt: "{text}" }
/** A trained custom voice — the kind of voice Change voice can use. */
const anna: Voice = { id: "v-anna", name: "Anna", color: "#111", libraryVoiceId: "c-0a1b2c3d" }
const voices = [stock, anna]
const NOT_TRAINED = "Mary has no trained voice model yet — Change voice works with character voices and trained voices."

const recorded = {
  id: "cell-1", fileId: "file-1", type: "text",
  translated: "hola",
  selectedAudioId: "audio-cell-1-1-aaaa",
  attachments: { "audio-cell-1-1-aaaa": { url: "blob:x", type: "audio/webm", slot: "recording" } },
} as unknown as CellData

const unvoiced = {
  id: "cell-1", fileId: "file-1", type: "text",
  translated: "hola", attachments: {},
} as unknown as CellData

function renderPanel(
  cell: CellData,
  defaultVoiceId: string,
  onAfterGenerate = vi.fn(),
  onRecord?: () => void,
  voiceFromText = true,
) {
  const settings = { voices, defaultVoiceId } as ProjectTtsSettings
  const project = { id: "proj-1", name: "P", ttsSettings: settings } as unknown as ProjectRecord
  renderWithTooltips(
    <CellVoicePanel
      cell={cell}
      project={project}
      projectId="proj-1"
      settings={settings}
      session={{ jwt: "x" } as unknown as never}
      username="tester"
      onRecord={onRecord}
      onAfterGenerate={onAfterGenerate}
      voiceFromText={voiceFromText}
    />,
  )
  return { onAfterGenerate }
}

describe("CellVoicePanel voice actions (AQU-1109)", () => {
  beforeEach(() => {
    vi.mocked(generateCellVoice).mockClear()
    vi.mocked(changeCellVoice).mockClear()
    play.mockClear()
  })

  it("Record opens the recording window", async () => {
    const user = userEvent.setup()
    const onRecord = vi.fn()
    renderPanel(recorded, "v-anna", vi.fn(), onRecord)
    await user.click(screen.getByRole("button", { name: "Record audio" }))
    expect(onRecord).toHaveBeenCalledTimes(1)
    expect(generateCellVoice).not.toHaveBeenCalled()
    expect(changeCellVoice).not.toHaveBeenCalled()
  })

  it("an unvoiced line offers Generate but not Change voice", async () => {
    const user = userEvent.setup()
    const { onAfterGenerate } = renderPanel(unvoiced, "v-mary")
    expect(screen.queryByRole("button", { name: "Change voice" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Generate · Mary" }))
    await waitFor(() => expect(onAfterGenerate).toHaveBeenCalledTimes(1))
    expect(vi.mocked(generateCellVoice).mock.calls[0][0]).toMatchObject({ voiceId: "v-mary", slot: undefined })
  })

  it("Generate lands on top of a change-voice take, in that take's slot", async () => {
    const user = userEvent.setup()
    const changed = {
      ...recorded,
      selectedAudioId: "vc-a8dcd319-q25-audio-cell-1-1-bbbb.wav",
      attachments: {
        "vc-a8dcd319-q25-audio-cell-1-1-bbbb.wav": { url: "blob:y", type: "audio/wav", slot: "recording" },
      },
    } as unknown as CellData
    renderPanel(changed, "v-mary")
    await user.click(screen.getByRole("button", { name: "Generate audio from text" }))
    await waitFor(() => expect(generateCellVoice).toHaveBeenCalled())
    expect(vi.mocked(generateCellVoice).mock.calls[0][0]).toMatchObject({ slot: "recording" })
  })

  it("Change voice converts the take into the assigned trained voice in one click", async () => {
    const user = userEvent.setup()
    const { onAfterGenerate } = renderPanel(recorded, "v-anna")
    const button = screen.getByTestId("voice-card-change-voice")
    expect(button).toBeEnabled()
    await user.click(button)
    await waitFor(() => expect(onAfterGenerate).toHaveBeenCalledTimes(1))
    // AQU-2291: no quality popover, no diffusion steps.
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByRole("combobox", { name: "Quality" })).toBeNull()
    expect(vi.mocked(changeCellVoice).mock.calls[0][0]).toMatchObject({
      projectId: "proj-1",
      voice: { id: "v-anna" },
      author: "tester",
    })
    expect(vi.mocked(changeCellVoice).mock.calls[0][0]).not.toHaveProperty("diffusionSteps")
    expect(generateCellVoice).not.toHaveBeenCalled()
    expect(play).not.toHaveBeenCalled()
  })

  it("plays the converted take once it replaces the one that was selected", async () => {
    const user = userEvent.setup()
    const settings = { voices, defaultVoiceId: "v-anna" } as ProjectTtsSettings
    const project = { id: "proj-1", name: "P", ttsSettings: settings } as unknown as ProjectRecord
    const props = {
      project,
      projectId: "proj-1",
      settings,
      session: { jwt: "x" } as unknown as never,
      username: "tester",
      onAfterGenerate: () => {},
    }
    const { rerender } = renderWithTooltips(<CellVoicePanel cell={recorded} {...props} />)
    await user.click(screen.getByTestId("voice-card-change-voice"))
    await waitFor(() => expect(changeCellVoice).toHaveBeenCalled())
    expect(play).not.toHaveBeenCalled()

    const nextId = "vc-converted-audio"
    const next = {
      ...recorded,
      selectedAudioId: nextId,
      attachments: {
        ...(recorded.attachments as object),
        [nextId]: { url: "blob:z", type: "audio/wav", slot: "recording" },
      },
    } as unknown as CellData
    rerender(
      <TooltipProvider delay={0}>
        <CellVoicePanel cell={next} {...props} />
      </TooltipProvider>,
    )
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1))
  })

  it("Change voice is greyed out, with the not-trained reason, for a plain TTS voice", async () => {
    renderPanel(recorded, "v-mary")
    const trigger = screen.getByTestId("voice-card-change-voice")
    expect(trigger).toBeDisabled()
    expect(screen.queryByRole("dialog")).toBeNull()
    // Same stand-in AppTooltip uses for every disabled control (AQU-959).
    const standIn = trigger.closest('[data-slot="tooltip-disabled-trigger"]')
    expect(standIn).not.toBeNull()
    expect(standIn).not.toHaveAttribute("disabled")
    await expectTooltip(
      standIn as HTMLElement,
      NOT_TRAINED,
    )
  })

  it("still explains the greyed icon after the assigned voice changes", async () => {
    const settings = { voices, defaultVoiceId: "v-anna" } as ProjectTtsSettings
    const project = { id: "proj-1", name: "P", ttsSettings: settings } as unknown as ProjectRecord
    const props = {
      cell: recorded,
      project,
      projectId: "proj-1",
      settings,
      session: { jwt: "x" } as unknown as never,
      username: "tester",
      onAfterGenerate: () => {},
    }
    const { rerender } = renderWithTooltips(<CellVoicePanel {...props} />)
    expect(screen.getByTestId("voice-card-change-voice")).toBeEnabled()

    rerender(
      <TooltipProvider delay={0}>
        <CellVoicePanel {...props} settings={{ voices, defaultVoiceId: "v-mary" } as ProjectTtsSettings} />
      </TooltipProvider>,
    )
    const trigger = screen.getByTestId("voice-card-change-voice")
    expect(trigger).toBeDisabled()
    const standIn = trigger.closest('[data-slot="tooltip-disabled-trigger"]')
    expect(standIn).not.toBeNull()
    await expectTooltip(
      standIn as HTMLElement,
      NOT_TRAINED,
    )
  })

  it("Change voice is disabled when the take already wears this voice", async () => {
    const id = `vc-${voiceReferenceFingerprint("library:c-0a1b2c3d")}-audio-cell-1-2-bbbb`
    const converted = {
      ...recorded,
      selectedAudioId: id,
      attachments: {
        ...(recorded.attachments as object),
        [id]: {
          url: "blob:y", type: "audio/wav", slot: "recording",
          voiceId: "v-anna", referenceAudioId: "audio-cell-1-1-aaaa",
        },
      },
    } as unknown as CellData
    renderPanel(converted, "v-anna")
    expect(screen.getByTestId("voice-card-change-voice")).toBeDisabled()
  })

  it("blocks a voice that still carries a removed short-clip clone field (AQU-2291)", async () => {
    const legacy = { ...stock, id: "v-old", name: "Mary", referenceAudioId: "ref.wav" } as Voice
    const settings = { voices: [legacy], defaultVoiceId: "v-old" } as ProjectTtsSettings
    const project = { id: "proj-1", name: "P", ttsSettings: settings } as unknown as ProjectRecord
    renderWithTooltips(
      <CellVoicePanel
        cell={recorded}
        project={project}
        projectId="proj-1"
        settings={settings}
        session={{ jwt: "x" } as unknown as never}
        username="tester"
        onAfterGenerate={() => {}}
      />,
    )
    const trigger = screen.getByTestId("voice-card-change-voice")
    expect(trigger).toBeDisabled()
    await expectTooltip(trigger.closest('[data-slot="tooltip-disabled-trigger"]') as HTMLElement, NOT_TRAINED)
  })
})

// Media redesign slice 2 (P2.3): a language that delivers Audio and no text
// has nothing to speak, so its cards offer no voice generated from text.
describe("CellVoicePanel in an Audio language", () => {
  it("an empty card offers Record only, no Generate", () => {
    renderPanel(unvoiced, "v-mary", vi.fn(), vi.fn(), false)
    expect(screen.getByTestId("voice-card-empty")).toHaveAttribute("data-state", "record-only")
    expect(screen.queryByTestId("voice-card-generate")).toBeNull()
    expect(screen.queryByRole("button", { name: /Generate/ })).toBeNull()
    expect(screen.getByTestId("voice-card-record")).toBeInTheDocument()
  })

  it("a recorded card keeps Change voice and drops Generate audio from text", () => {
    renderPanel(recorded, "v-anna", vi.fn(), vi.fn(), false)
    expect(screen.queryByRole("button", { name: "Generate audio from text" })).toBeNull()
    expect(screen.getByTestId("voice-card-change-voice")).toBeInTheDocument()
  })
})
