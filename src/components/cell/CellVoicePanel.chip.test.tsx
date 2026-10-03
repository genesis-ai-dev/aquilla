import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, cleanup, fireEvent, screen } from "@testing-library/react"
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

function draw(over: Partial<React.ComponentProps<typeof CellVoicePanel>> = {}) {
  const onRecord = vi.fn()
  const onMakeCharacter = vi.fn()
  renderWithTooltips(
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
    />,
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

  it("ends the row in the take's tools — the recorder, volume, clone — always visible", () => {
    draw()
    const wave = screen.getByTestId("voice-card-waveform")
    const tools = row().lastElementChild!.querySelectorAll("button")
    expect([...tools].map((b) => b.getAttribute("aria-label"))).toEqual(["Change voice", "Generate audio from text", "Record audio", "Volume", "Clone voice from take"])
    for (const name of ["Change voice", "Generate audio from text", "Record audio", "Volume", "Clone voice from take"]) {
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

  it("is read-only for someone who can't edit: no trimming, no recorder, no clone", () => {
    draw({ canEdit: false })
    // An untrimmed take shown read-only has no lines at all (a trimmed one
    // would show them grey).
    expect(screen.queryByRole("slider", { name: "Start of the kept audio" })).toBeNull()
    expect(screen.queryByRole("button", { name: /clone/i })).toBeNull()
    expect(screen.queryByTestId("voice-card-record")).toBeNull()
    expect(screen.getByRole("button", { name: "Volume" })).toBeInTheDocument()
  })
})

// Sam, 2026-09-28: the mic replaced Generate again — the recorder already
// generates again, and records over, uploads and switches takes.
describe("CellVoicePanel — the recorder, from a line with audio", () => {
  it("opens the recorder from the mic, on a recording and on a generated voice", async () => {
    for (const cell of [recorded, generated]) {
      const { onRecord } = draw({ cell })
      const mic = screen.getByTestId("voice-card-record")
      await expectTooltip(mic, "Record audio")
      fireEvent.click(mic)
      expect(onRecord).toHaveBeenCalledTimes(1)
      cleanup()
    }
  })

  it("offers no Generate again of its own", () => {
    draw()
    expect(screen.queryByRole("button", { name: /Generate again/ })).toBeNull()
  })

  it("keeps the mic but refuses it, with the reason, where this browser can't record", async () => {
    const { onRecord } = draw({ recordUnavailable: "this browser has no MediaRecorder" })
    const mic = screen.getByTestId("voice-card-record")
    expect(mic).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(mic)
    expect(onRecord).not.toHaveBeenCalled()
    await expectTooltip(mic, "this browser has no MediaRecorder")
  })
})

// Sam, 2026-09-28: picking a voice only assigns it, so a generated take can be
// in a voice the line no longer has — a pill beside the time names it.
describe("CellVoicePanel — the take's voice", () => {
  const pill = () => screen.queryByTestId("voice-card-take-voice")

  it("names the take's voice beside the time when the line's voice changed since", async () => {
    draw({ cell: byMary, settings: castJohn })
    expect(pill()).toHaveTextContent("Mary")
    expect(pill()).toHaveAttribute("data-tone", "amber")
    expect(pill()).toHaveAttribute("data-wave-overlay")
    const time = screen.getByText("0:00 / 0:10")
    expect(time.parentElement!.contains(pill())).toBe(true)
    await expectTooltip(pill()!, "This take was voiced by Mary. The line’s voice is now John.")
  })

  it("is not there when the take is in the line's voice", () => {
    draw({ cell: byMary })
    expect(pill()).toBeNull()
  })

  it("is not there when the take doesn't say which voice made it", () => {
    draw({ settings: castJohn })
    expect(pill()).toBeNull()
  })

  it("is never on a recording", () => {
    draw({ cell: { ...recorded, attachments: { r1: { url: "blob:r", type: "audio/wav", voiceId: "v-mary" } } } as unknown as CellData, settings: castJohn })
    expect(pill()).toBeNull()
  })

  it("says so when the take's voice was removed from the project", async () => {
    draw({ cell: { ...generated, attachments: { a1: { url: "blob:x", type: "audio/wav", voiceId: "v-gone" } } } as unknown as CellData })
    expect(pill()).toHaveTextContent("Removed voice")
    await expectTooltip(pill()!, "This take was voiced by a voice no longer in the project. The line’s voice is now Mary.")
  })

  it("turns blue on a file coloured amber", () => {
    draw({
      cell: byMary,
      settings: castJohn,
      project: { ...project, files: [{ id: "file-1", trackOverrides: { "target-audio": { color: "amber" } } }] } as unknown as ProjectRecord,
    })
    expect(pill()).toHaveAttribute("data-tone", "blue")
  })

  it("shows to someone who can't edit too", () => {
    draw({ cell: byMary, settings: castJohn, canEdit: false })
    expect(pill()).toHaveTextContent("Mary")
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
    // Record is in the slot; the mic joins the row once there is audio.
    expect(row().querySelector("[data-testid=voice-card-record]")).toBeNull()
    expect(slot().contains(screen.getByTestId("voice-card-record"))).toBe(true)
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
