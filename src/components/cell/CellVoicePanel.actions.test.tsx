import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
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
import { resetChangeVoiceQualityCacheForTests } from "@/lib/store/change-voice-quality"

const stock: Voice = { id: "v-mary", name: "Mary", color: "#000", provider: "gemini", voiceName: "Kore", prompt: "{text}" }
const clone: Voice = {
  id: "v-anna", name: "Anna", color: "#111", provider: "gemini", voiceName: "Kore", prompt: "{text}",
  referenceAudioId: "ref-anna.wav",
}
const voices = [stock, clone]

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
      onMakeCharacter={() => {}}
    />,
  )
  return { onAfterGenerate }
}

async function openChangeVoice(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("voice-card-change-voice"))
  return screen.getByRole("dialog")
}

describe("CellVoicePanel voice actions (AQU-1109)", () => {
  beforeEach(() => {
    localStorage.clear()
    resetChangeVoiceQualityCacheForTests()
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

  it("Change voice converts the take into the assigned cloned voice", async () => {
    const user = userEvent.setup()
    const { onAfterGenerate } = renderPanel(recorded, "v-anna")
    const dialog = await openChangeVoice(user)
    const button = within(dialog).getByRole("button", { name: "Change voice" })
    expect(button).toBeEnabled()
    await user.click(button)
    await waitFor(() => expect(onAfterGenerate).toHaveBeenCalledTimes(1))
    expect(vi.mocked(changeCellVoice).mock.calls[0][0]).toMatchObject({
      projectId: "proj-1",
      voice: { id: "v-anna" },
      author: "tester",
      diffusionSteps: 25,
    })
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
      onMakeCharacter: () => {},
    }
    const { rerender } = renderWithTooltips(<CellVoicePanel cell={recorded} {...props} />)
    const dialog = await openChangeVoice(user)
    await user.click(within(dialog).getByRole("button", { name: "Change voice" }))
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

  it("Change voice is greyed out, with a reason, for a stock voice", async () => {
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
      "Mary has no reference clip. Assign a cloned voice to change this take.",
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
      onMakeCharacter: () => {},
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
      "Mary has no reference clip. Assign a cloned voice to change this take.",
    )
  })

  it("Change voice is disabled when the take already wears this voice", async () => {
    const id = `vc-${voiceReferenceFingerprint("ref-anna.wav")}-q25-audio-cell-1-2-bbbb`
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
    const dialog = await openChangeVoice(userEvent.setup())
    expect(within(dialog).getByRole("button", { name: "Change voice" })).toBeDisabled()
  })

  it("sends the quality the user picks, and a higher quality can run again", async () => {
    const user = userEvent.setup()
    const id = `vc-${voiceReferenceFingerprint("ref-anna.wav")}-q25-audio-cell-1-2-bbbb`
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
    const dialog = await openChangeVoice(user)
    const quality = within(dialog).getByRole("combobox", { name: "Quality" })
    expect(quality).toHaveTextContent("Standard")
    await user.click(quality)
    await user.click(screen.getByRole("option", { name: "High" }))
    const button = within(dialog).getByRole("button", { name: "Change voice" })
    expect(button).toBeEnabled()
    await user.click(button)
    await waitFor(() => expect(changeCellVoice).toHaveBeenCalled())
    expect(vi.mocked(changeCellVoice).mock.calls[0][0]).toMatchObject({ diffusionSteps: 40 })
  })
})
