import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, fireEvent, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { renderWithTooltips, expectTooltip } from "@/test-utils/tooltip"
import { setTtsStatus, ttsStatusKey } from "@/lib/audio/tts"

vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "idle", error: null, isPlaying: false, currentTime: 0, duration: 10,
    peaks: [], peaksState: "idle",
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
  }),
}))
const generateCellVoice = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true))
vi.mock("@/lib/audio/voice-generate-helpers", () => ({
  generateCellVoice: (...a: unknown[]) => generateCellVoice(...a),
}))

import { CellVoicePanel } from "./CellVoicePanel"
import { SharedVoiceClipsContext } from "./shared-voice-clips"

const voices: Voice[] = [
  { id: "v-mary", name: "Mary", color: "#000", provider: "gemini", voiceName: "Kore", prompt: "{text}" },
  { id: "v-john", name: "John", color: "#111", provider: "gemini", voiceName: "Puck", prompt: "{text}" },
]

/** A line with a generated voice. */
const generated = {
  id: "cell-1", fileId: "file-1", type: "text",
  translated: "hola",
  selectedGeneratedVoiceAudioId: "a1",
  attachments: { a1: { url: "blob:x", type: "audio/wav" } },
} as unknown as CellData
/** A line with a recording. */
const recorded = {
  ...generated,
  selectedAudioId: "r1",
  selectedGeneratedVoiceAudioId: undefined,
  attachments: { r1: { url: "blob:r", type: "audio/wav" } },
} as unknown as CellData
/** A line with no audio yet. */
const empty = { ...generated, selectedGeneratedVoiceAudioId: undefined, attachments: {} } as unknown as CellData

const settings = { voices, defaultVoiceId: "v-mary" } as ProjectTtsSettings
/** The same line with John cast on it. */
const castJohn = { ...settings, castAssignments: { "cell-1": "v-john" } } as ProjectTtsSettings
/** A generated take that remembers Mary made it. */
const byMary = {
  ...generated,
  attachments: { a1: { url: "blob:x", type: "audio/wav", voiceId: "v-mary" } },
} as unknown as CellData
const project = { id: "proj-1", name: "P", ttsSettings: settings } as unknown as ProjectRecord

function draw(
  over: Partial<React.ComponentProps<typeof CellVoicePanel>> = {},
  { shared = new Set<string>() }: { shared?: ReadonlySet<string> } = {},
) {
  const onRecord = vi.fn()
  const onMakeCharacter = vi.fn()
  renderWithTooltips(
    <SharedVoiceClipsContext.Provider value={shared}>
      <CellVoicePanel
        cell={generated}
        project={project}
        projectId="proj-1"
        settings={settings}
        session={{ jwt: "x" } as unknown as never}
        username="tester"
        onRecord={onRecord}
        onAfterGenerate={() => {}}
        onMakeCharacter={onMakeCharacter}
        {...over}
      />
    </SharedVoiceClipsContext.Provider>,
  )
  return { onRecord, onMakeCharacter }
}

beforeEach(() => {
  generateCellVoice.mockClear()
  setTtsStatus(ttsStatusKey("cell-1"), { kind: "idle" })
})

const row = () => document.querySelector("[data-slot=voice-card-row]") as HTMLElement

// Sam, 2026-09-28: the take, then a row under it with the line's voice, Generate
// again, volume and clone. Validation lives in its column, not on the card.
describe("CellVoicePanel — the take, then a row with its voice", () => {
  it("has no validation of its own", () => {
    draw()
    expect(screen.queryByTestId("voice-card-waveform-validated")).toBeNull()
    expect(document.querySelector("[data-slot=voice-take-tools]")).toBeNull()
  })

  it("puts the host's voice picker at the start of the row under the waveform", () => {
    draw({ voicePicker: <button type="button">Narrator</button> })
    const picker = screen.getByRole("button", { name: "Narrator" })
    expect(row().contains(picker)).toBe(true)
    expect(row().firstElementChild!.contains(picker)).toBe(true)
    expect(screen.getByTestId("voice-card-waveform").contains(row())).toBe(false)
  })

  it("is 56px tall, the height of an empty card too", () => {
    draw()
    expect(screen.getByTestId("voice-card-waveform").style.height).toBe("56px")
  })

  // Sam, 2026-09-26: the take wears its file's dub-track colour.
  it("wears the file's dub-track colour, a generated voice at its lighter strength", () => {
    draw({ project: { ...project, files: [{ id: "file-1", trackOverrides: { "target-audio": { color: "azure" } } }] } as unknown as ProjectRecord })
    const card = screen.getByTestId("voice-card-waveform")
    expect(card.style.getPropertyValue("--tl-track-hue")).toBe("#2489eb")
    expect(card.className).toContain("bg-[color:var(--tl-track-gen)]")
  })

  it("is the media view's default green when the file has no colour", () => {
    draw()
    expect(screen.getByTestId("voice-card-waveform").style.getPropertyValue("--tl-track-hue")).toBe("#40c06e")
  })

  it("plays from the waveform's corner", () => {
    draw()
    expect(screen.getByTestId("voice-card-waveform-play")).toHaveAttribute("aria-label", "Play audio")
  })

  it("trims a generated voice right on the card", () => {
    draw()
    expect(screen.getByRole("slider", { name: "Start of the kept audio" })).toBeInTheDocument()
    expect(screen.getByRole("slider", { name: "End of the kept audio" })).toBeInTheDocument()
  })

  it("puts volume and clone at the end of the row, always visible", () => {
    draw()
    const wave = screen.getByTestId("voice-card-waveform")
    for (const name of ["Volume", "Clone a voice from this take"]) {
      const b = screen.getByRole("button", { name })
      expect(row().lastElementChild!.contains(b)).toBe(true)
      expect(wave.contains(b)).toBe(false)
      expect(b.className).not.toContain("opacity-0")
    }
  })

  it("opens the volume popover from its button", async () => {
    const user = userEvent.setup()
    draw()
    const volume = screen.getByRole("button", { name: "Volume" })
    await user.click(volume)
    expect(volume).toHaveAttribute("aria-expanded", "true")
  })

  it("shows a tooltip on volume", async () => {
    draw()
    await expectTooltip(screen.getByRole("button", { name: "Volume" }), "Volume")
  })

  it("asks the host to open the clone-from-take modal", async () => {
    const user = userEvent.setup()
    const { onMakeCharacter } = draw()
    await user.click(screen.getByRole("button", { name: /clone/i }))
    expect(onMakeCharacter).toHaveBeenCalledTimes(1)
  })

  it("is read-only for someone who can't edit: no trimming, no clone, no Generate again", () => {
    draw({ canEdit: false })
    // An untrimmed take shown read-only has no lines at all (a trimmed one
    // would show them grey).
    expect(screen.queryByRole("slider", { name: "Start of the kept audio" })).toBeNull()
    expect(screen.queryByRole("button", { name: /clone/i })).toBeNull()
    expect(screen.queryByTestId("voice-card-regenerate")).toBeNull()
    expect(screen.getByRole("button", { name: "Volume" })).toBeInTheDocument()
  })
})

// Sam, 2026-09-28: on every generated voice, whatever its voice — the same
// voice can come out differently a second time. Never on a recording.
describe("CellVoicePanel — Generate again", () => {
  it("sits beside the picker as a quiet icon naming the voice, and regenerates in it", async () => {
    draw({ voicePicker: <span data-testid="picker" /> })
    const again = screen.getByTestId("voice-card-regenerate")
    expect(row().contains(again)).toBe(true)
    expect(again).toHaveAttribute("data-stale", "false")
    expect(again).toHaveAccessibleName("Generate again · Mary")
    expect(again.textContent).toBe("")
    await expectTooltip(again, "Generate again · Mary")
    await act(async () => { fireEvent.click(again) })
    expect(generateCellVoice).toHaveBeenCalledTimes(1)
    expect((generateCellVoice.mock.calls[0][0] as { voiceId: string }).voiceId).toBe("v-mary")
  })

  it("stays quiet when the take is in the line's voice", () => {
    draw({ cell: byMary })
    expect(screen.getByTestId("voice-card-regenerate")).toHaveAttribute("data-stale", "false")
  })

  // Picking only assigns, so the take can be in a voice the line no longer has.
  it("shows its label and the new voice, highlighted, when the line's voice changed since", async () => {
    draw({ cell: byMary, settings: castJohn })
    const again = screen.getByTestId("voice-card-regenerate")
    expect(again).toHaveAttribute("data-stale", "true")
    expect(again).toHaveTextContent("Generate again · John")
    expect(again.className).toContain("var(--tl-track-hue)")
    await expectTooltip(again, "This take was voiced by Mary")
    await act(async () => { fireEvent.click(again) })
    expect((generateCellVoice.mock.calls[0][0] as { voiceId: string }).voiceId).toBe("v-john")
  })

  it("is off an untranslated line", () => {
    draw({ cell: { ...generated, translated: "" } as unknown as CellData })
    expect(screen.queryByTestId("voice-card-regenerate")).toBeNull()
  })

  it("is never on a recording", () => {
    draw({ cell: recorded })
    expect(screen.getByTestId("voice-card-waveform")).toBeInTheDocument()
    expect(screen.queryByTestId("voice-card-regenerate")).toBeNull()
  })

  it("stays off a clip shared by lines voiced together", () => {
    draw({}, { shared: new Set(["a1"]) })
    expect(screen.queryByTestId("voice-card-regenerate")).toBeNull()
  })
})

// A line with no audio: the timeline's empty slot, Generate and Record.
describe("CellVoicePanel — a line with no audio yet", () => {
  const slot = () => screen.getByTestId("voice-card-empty")

  it("has the same row under the slot, holding the picker and nothing else", () => {
    draw({ cell: empty, voicePicker: <span data-testid="picker" /> })
    expect(row().contains(screen.getByTestId("picker"))).toBe(true)
    expect(slot().contains(row())).toBe(false)
    expect(screen.queryByRole("button", { name: "Volume" })).toBeNull()
    expect(screen.queryByTestId("voice-card-regenerate")).toBeNull()
  })

  it("offers Generate in the default voice, saying why on hover, and Record", async () => {
    const { onRecord } = draw({ cell: empty })
    expect(slot()).toHaveAttribute("data-state", "ready")
    expect(slot().className).toContain("border-dashed")
    const generate = screen.getByTestId("voice-card-generate")
    expect(generate).toHaveTextContent("Generate · Mary")
    await expectTooltip(generate, /uses the default voice/)
    fireEvent.click(screen.getByTestId("voice-card-record"))
    expect(onRecord).toHaveBeenCalledTimes(1)
  })

  it("names the line's character when one is cast, with no default-voice tooltip", () => {
    draw({ cell: empty, settings: castJohn })
    expect(screen.getByTestId("voice-card-generate")).toHaveTextContent("Generate · John")
  })

  it("generates in the line's voice", async () => {
    draw({ cell: empty })
    await act(async () => { fireEvent.click(screen.getByTestId("voice-card-generate")) })
    expect((generateCellVoice.mock.calls[0][0] as { voiceId: string }).voiceId).toBe("v-mary")
  })

  it("greys Generate out on an untranslated line, and keeps Record", async () => {
    draw({ cell: { ...empty, translated: "" } as unknown as CellData })
    expect(slot()).toHaveAttribute("data-state", "notext")
    expect(screen.getByTestId("voice-card-generate")).toBeDisabled()
    await expectTooltip(screen.getByTestId("voice-card-generate").parentElement!, /translate the line first/)
    expect(screen.getByTestId("voice-card-record")).toBeEnabled()
  })

  it("shows the voice being generated, and keeps Record available", () => {
    setTtsStatus(ttsStatusKey("cell-1"), { kind: "synthesizing" })
    draw({ cell: empty })
    expect(slot()).toHaveAttribute("data-state", "generating")
    expect(slot()).toHaveTextContent("Generating as Mary…")
    expect(screen.getByTestId("voice-card-record")).toBeEnabled()
  })

  it("after a failure, offers Try again with the reason on hover", async () => {
    setTtsStatus(ttsStatusKey("cell-1"), { kind: "error", message: "no voice engine is set up" })
    draw({ cell: empty })
    expect(slot()).toHaveAttribute("data-state", "failed")
    const retry = screen.getByTestId("voice-card-retry")
    expect(retry).toHaveTextContent("Try again")
    await expectTooltip(retry, "Couldn’t generate: no voice engine is set up")
    await act(async () => { fireEvent.click(retry) })
    expect(generateCellVoice).toHaveBeenCalledTimes(1)
  })

  it("tells someone who can't edit that there is no audio, with nothing to press", () => {
    draw({ cell: empty, canEdit: false, voicePicker: <span data-testid="picker">Narrator</span> })
    expect(slot()).toHaveAttribute("data-state", "readonly")
    expect(slot()).toHaveTextContent("No audio yet")
    expect(screen.queryByRole("button")).toBeNull()
    // The voice is still named, under the slot.
    expect(row().contains(screen.getByTestId("picker"))).toBe(true)
  })

  it("keeps Record but refuses it, with the reason, where this browser can't record", async () => {
    const { onRecord } = draw({ cell: empty, recordUnavailable: "this browser has no MediaRecorder" })
    const record = screen.getByTestId("voice-card-record")
    expect(record).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(record)
    expect(onRecord).not.toHaveBeenCalled()
    await expectTooltip(record, "this browser has no MediaRecorder")
  })
})

// AQU-1211: the row hands its player in so the word highlight in the cell
// follows this play button.
describe("CellVoicePanel — the row's player", () => {
  it("plays the row's player so the cell highlight follows this button", () => {
    const play = vi.fn()
    draw({
      controller: {
        state: "ready", error: null, isPlaying: false, currentTime: 0, duration: 2,
        peaks: null, peaksState: "idle",
        play, pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
        setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
      },
    })
    fireEvent.click(screen.getByTestId("voice-card-waveform-play"))
    expect(play).toHaveBeenCalledOnce()
  })
})
