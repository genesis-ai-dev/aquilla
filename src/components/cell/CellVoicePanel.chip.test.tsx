import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, cleanup, fireEvent, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { renderWithTooltips, expectTooltip, expectClickNote, expectDisabledNote } from "@/test-utils/tooltip"
import { setTtsStatus, ttsStatusKey } from "@/lib/audio/tts"

vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "idle", error: null, isPlaying: false, currentTime: 0, duration: 10,
    peaks: [], peaksState: "idle",
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
  }),
}))
// AQU-1642 follow-up: what the bottom bar's run is doing on this line.
const runHere = vi.hoisted(() => ({ kind: null as "playing" | "loading" | "paused" | null, sec: null as number | null }))
vi.mock("@/lib/audio/play-queue", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueueCellKind: (cellId?: string) => (cellId ? runHere.kind : null),
  useQueueCellPosition: (cellId?: string) => (cellId ? runHere.sec : null),
}))
const generateCellVoice = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true))
vi.mock("@/lib/audio/voice-generate-helpers", () => ({
  generateCellVoice: (...a: unknown[]) => generateCellVoice(...a),
}))
const emitCellAudioDeselect = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => "evt-1"))
const injectOptimisticAudioDeselect = vi.hoisted(() => vi.fn())
const notifyAudioAttachmentsChanged = vi.hoisted(() => vi.fn())
vi.mock("@/lib/sync/events-emit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/events-emit")>()
  return { ...actual, emitCellAudioDeselect: (...a: unknown[]) => emitCellAudioDeselect(...a) }
})
vi.mock("@/lib/audio/audio-attachments-bus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audio/audio-attachments-bus")>()
  return {
    ...actual,
    injectOptimisticAudioDeselect: (...a: unknown[]) => injectOptimisticAudioDeselect(...a),
    notifyAudioAttachmentsChanged: (...a: unknown[]) => notifyAudioAttachmentsChanged(...a),
  }
})

const changeCellVoice = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true))
vi.mock("@/lib/audio/change-voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audio/change-voice")>()
  return { ...actual, changeCellVoice: (...a: unknown[]) => changeCellVoice(...a) }
})

import { CellVoicePanel, type CellVoicePickerContext } from "./CellVoicePanel"

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
  runHere.kind = null
  runHere.sec = null
  generateCellVoice.mockClear()
  changeCellVoice.mockClear()
  emitCellAudioDeselect.mockClear()
  injectOptimisticAudioDeselect.mockClear()
  notifyAudioAttachmentsChanged.mockClear()
  setTtsStatus(ttsStatusKey("cell-1"), { kind: "idle" })
})

const row = () => document.querySelector("[data-slot=voice-card-row]") as HTMLElement

/** AQU-2260: a control that carries its own words has no hover at all. */
async function expectNoHover(el: Element) {
  await userEvent.setup().hover(el)
  await act(() => new Promise((r) => setTimeout(r, 30)))
  expect(screen.queryByRole("tooltip")).toBeNull()
}

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

  // AQU-1642 follow-up (Sam, 2026-10-17): in the Audio view the bottom bar's
  // player is the card's player. The card shows where it is on this line —
  // moving while it plays, held while it waits — and its corner button is
  // Play, and a real Stop while the run plays here.
  const placed = () => {
    const place = { onPress: vi.fn(), onPick: vi.fn() }
    draw({ place })
    return place
  }
  const playline = () => screen.queryByTestId("voice-card-waveform-playline") as HTMLElement | null

  it("is Stop while the bar's run plays this line, and shows how far it has got", () => {
    runHere.kind = "playing"
    runHere.sec = 2.5
    const place = placed()
    const button = screen.getByTestId("voice-card-waveform-play")
    expect(button).toHaveAttribute("aria-label", "Stop")
    expect(playline()?.style.left).toBe("25%")
    fireEvent.click(button)
    expect(place.onPress).toHaveBeenCalledTimes(1)
  })

  it("holds the place while the run waits on this line, and Play carries on from it", () => {
    runHere.kind = "paused"
    runHere.sec = 4
    const place = placed()
    const button = screen.getByTestId("voice-card-waveform-play")
    expect(button).toHaveAttribute("aria-label", "Play audio")
    expect(playline()?.style.left).toBe("40%")
    expect(screen.getByTestId("voice-card-time")).toHaveTextContent("0:04")
    fireEvent.click(button)
    expect(place.onPress).toHaveBeenCalledTimes(1)
  })

  it("draws no place while the run is elsewhere, and Play starts this line", () => {
    const place = placed()
    expect(screen.getByTestId("voice-card-waveform-play")).toHaveAttribute("aria-label", "Play audio")
    expect(playline()).toBeNull()
    fireEvent.click(screen.getByTestId("voice-card-waveform-play"))
    expect(place.onPress).toHaveBeenCalledTimes(1)
  })

  it("puts the place where the waveform is clicked", () => {
    const place = placed()
    fireEvent.pointerDown(screen.getByTestId("voice-card-waveform-seek"), { clientX: 0 })
    expect(place.onPick).toHaveBeenCalledWith(0)
  })

  it("outside the Audio view, its button is still its own Play", () => {
    runHere.kind = "playing"
    runHere.sec = 2.5
    draw()
    expect(screen.getByTestId("voice-card-waveform-play")).toHaveAttribute("aria-label", "Play audio")
    expect(playline()).toBeNull()
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

  it("clones the take in one step: name it, press Clone (AQU-2212)", async () => {
    const user = userEvent.setup()
    const onCloneTake = vi.fn(async () => {})
    const { onMakeCharacter } = draw({ cell: recorded, onCloneTake })
    await user.click(screen.getByRole("button", { name: /clone voice from take/i }))
    // A person's own recording suggests their name.
    const name = screen.getByTestId("voice-card-clone-name")
    expect(name).toHaveValue("tester")
    await user.clear(name)
    await user.type(name, "Ana")
    await user.click(screen.getByTestId("voice-card-clone-submit"))
    expect(onCloneTake).toHaveBeenCalledWith("r1", "Ana")
    expect(onMakeCharacter).not.toHaveBeenCalled()
  })

  it("still offers the full dialog under More options", async () => {
    const user = userEvent.setup()
    const { onMakeCharacter } = draw({ onCloneTake: vi.fn(async () => {}) })
    await user.click(screen.getByRole("button", { name: /clone voice from take/i }))
    await user.click(screen.getByRole("button", { name: "More options" }))
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

  it("offers no Generate again of its own while the take's audio is here", () => {
    draw()
    expect(screen.queryByTestId("voice-card-generate")).toBeNull()
    expect(screen.queryByRole("button", { name: /Generate again/ })).toBeNull()
  })

  it("offers Generate on the card when this line's own clip is missing, and clears a recording so the new voice plays", async () => {
    const missing = {
      state: "error" as const, error: null, isPlaying: false, currentTime: 0, duration: 2,
      peaks: null, peaksState: "missing" as const,
      play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
      setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
    }
    draw({ cell: generated, controller: missing })
    const wave = screen.getByTestId("voice-card-waveform")
    expect(wave).toHaveTextContent("This clip's audio is missing.")
    const generate = screen.getByTestId("voice-card-generate")
    expect(wave.contains(generate)).toBe(true)
    expect(generate).toHaveTextContent("Generate · Mary")
    await act(async () => { fireEvent.click(generate) })
    expect((generateCellVoice.mock.calls[0][0] as { voiceId: string }).voiceId).toBe("v-mary")
    expect(emitCellAudioDeselect).not.toHaveBeenCalled()
    cleanup()

    const cell = {
      id: "cell-1", fileId: "file-1", type: "text", translated: "hola",
      selectedAudioId: "take-cell-1-abc.wav",
      attachments: { "take-cell-1-abc.wav": { url: "blob:r", type: "audio/wav", slot: "recording" } },
    } as unknown as CellData
    draw({ cell, controller: missing })
    await act(async () => { fireEvent.click(screen.getByTestId("voice-card-generate")) })
    expect(emitCellAudioDeselect).toHaveBeenCalledWith(expect.objectContaining({
      cellId: "cell-1", slot: "recording",
    }))
    expect(injectOptimisticAudioDeselect).toHaveBeenCalledWith("file-1", "cell-1", "recording", expect.any(Promise))
    expect(notifyAudioAttachmentsChanged).toHaveBeenCalledWith("file-1")
  })

  it("keeps the mic but refuses it, with the reason, where this browser can't record", async () => {
    const { onRecord } = draw({ recordUnavailable: "this browser has no MediaRecorder" })
    const mic = screen.getByTestId("voice-card-record")
    expect(mic).toBeDisabled()
    fireEvent.click(mic)
    expect(onRecord).not.toHaveBeenCalled()
    // AQU-2260: why, on a click.
    await expectDisabledNote(mic, "this browser has no MediaRecorder")
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
    // AQU-2260: on a click, never a hover.
    await expectClickNote(pill()!, "This take was voiced by Mary. The line’s voice is now John.")
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
    await expectClickNote(pill()!, "This take was voiced by a voice no longer in the project. The line’s voice is now Mary.")
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

  // AQU-2260 (Oct 29): Generate and Record carry their own words, so no hover.
  it("offers Generate in the default voice and Record, with no hover on either", async () => {
    const { onRecord } = draw({ cell: empty })
    expect(slot()).toHaveAttribute("data-state", "ready")
    expect(slot().className).toContain("border-dashed")
    const generate = screen.getByTestId("voice-card-generate")
    expect(generate).toHaveTextContent("Generate · Mary")
    await expectNoHover(generate)
    await expectNoHover(screen.getByTestId("voice-card-record"))
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
    await expectDisabledNote(screen.getByTestId("voice-card-generate"), /translate the line first/)
    expect(screen.getByTestId("voice-card-record")).toBeEnabled()
  })

  it("shows the voice being generated, and keeps Record available", () => {
    setTtsStatus(ttsStatusKey("cell-1"), { kind: "synthesizing" })
    draw({ cell: empty })
    expect(slot()).toHaveAttribute("data-state", "generating")
    expect(slot()).toHaveTextContent("Generating as Mary…")
    expect(screen.getByTestId("voice-card-record")).toBeEnabled()
  })

  // AQU-2260: the reason is behind the (i) beside it, on a click.
  it("after a failure, offers Try again with the reason behind its (i)", async () => {
    setTtsStatus(ttsStatusKey("cell-1"), { kind: "error", message: "no voice engine is set up" })
    draw({ cell: empty })
    expect(slot()).toHaveAttribute("data-state", "failed")
    const retry = screen.getByTestId("voice-card-retry")
    expect(retry).toHaveTextContent("Try again")
    await expectNoHover(retry)
    await expectClickNote(screen.getByRole("button", { name: "About Try again" }), "Couldn’t generate: no voice engine is set up")
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
    expect(record).toBeDisabled()
    fireEvent.click(record)
    expect(onRecord).not.toHaveBeenCalled()
    await expectDisabledNote(record, "this browser has no MediaRecorder")
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

// AQU-2212: the field names what you hear, and a pick acts on the line.
describe("CellVoicePanel — picking a voice acts on this line", () => {
  const hearth: Voice = { id: "v-hearth", name: "Hearth", color: "#222", libraryVoiceId: "narrator-hearth" }
  const withHearth = { voices: [...voices, hearth], defaultVoiceId: "v-mary" } as ProjectTtsSettings
  const drawPicker = (over: Partial<React.ComponentProps<typeof CellVoicePanel>> = {}) => {
    let ctx: CellVoicePickerContext | null = null
    draw({
      voicePicker: (c) => {
        ctx = c
        return <span data-testid="picker" />
      },
      ...over,
    })
    return () => ctx!
  }

  it("names a person's recording instead of the default voice", () => {
    expect(drawPicker({ cell: recorded })().takeLabel).toBe("Your recording")
    cleanup()
    const byAna = { ...recorded, attachments: { r1: { url: "blob:r", type: "audio/wav", recordedBy: "ana" } } } as unknown as CellData
    expect(drawPicker({ cell: byAna })().takeLabel).toBe("Recorded by ana")
    cleanup()
    expect(drawPicker({ cell: generated })().takeLabel).toBeUndefined()
  })

  it("re-voices a recording at once when the pick is a character", async () => {
    const ctx = drawPicker({ cell: recorded, settings: withHearth })
    await act(async () => ctx().onPicked("v-hearth"))
    expect(changeCellVoice).toHaveBeenCalledTimes(1)
    expect(changeCellVoice.mock.calls[0][0]).toMatchObject({ voice: { id: "v-hearth" } })
    expect(generateCellVoice).not.toHaveBeenCalled()
  })

  it("regenerates a generated take in a stock voice, but never reads over a recording", async () => {
    let ctx = drawPicker({ cell: generated })
    await act(async () => ctx().onPicked("v-john"))
    expect(generateCellVoice.mock.calls[0][0]).toMatchObject({ voiceId: "v-john" })
    cleanup()
    generateCellVoice.mockClear()
    ctx = drawPicker({ cell: recorded })
    await act(async () => ctx().onPicked("v-john"))
    expect(generateCellVoice).not.toHaveBeenCalled()
  })

  it("puts a labelled Change to … beside the field when the cast voice differs from the take", async () => {
    const user = userEvent.setup()
    draw({ cell: recorded, settings: { ...withHearth, castAssignments: { "cell-1": "v-hearth" } } as ProjectTtsSettings })
    const apply = screen.getByTestId("voice-card-apply")
    expect(apply).toHaveTextContent("Change to Hearth")
    await user.click(apply)
    expect(changeCellVoice).toHaveBeenCalledTimes(1)
  })

  it("offers Generate for a stock voice cast over a recording, and nothing once the take matches", () => {
    draw({ cell: recorded, settings: castJohn })
    expect(screen.getByTestId("voice-card-apply")).toHaveTextContent("Generate · John")
    cleanup()
    const byJohn = { ...generated, attachments: { a1: { url: "blob:x", type: "audio/wav", voiceId: "v-john" } } } as unknown as CellData
    draw({ cell: byJohn, settings: castJohn })
    expect(screen.queryByTestId("voice-card-apply")).toBeNull()
  })
})
