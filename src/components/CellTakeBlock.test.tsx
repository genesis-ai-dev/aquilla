// One recording's controls, and WHOSE recording they act on.
//
// The whole reason this component exists is that a subtitle line's take may
// live on another cell in another file (the heard line that performs it). So
// the thing worth pinning is not what it draws but where its effects land: a
// block pointed at a cue must read and write the CUE, never the row it is
// rendered inside. Get that wrong and a transcript silently lands on the wrong
// file — which is worse than the empty tab this fixes.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const audioCalls: Array<{ fileId: string; selectedAudioId: unknown; attachments: unknown }> = []
const transcribeCalls: Array<{ cellId: string; fileId: string; language?: string; askAgain?: boolean }> = []
const trimCalls: Array<[number | null, number | null]> = []
const setTrimSpy = (start: number | null, end: number | null) => { trimCalls.push([start, end]) }

vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: (_project: unknown, cell: { metadata?: Record<string, unknown> }, fileId: string) => {
    audioCalls.push({
      fileId,
      selectedAudioId: cell?.metadata?.selectedAudioId,
      attachments: cell?.metadata?.attachments,
    })
    return {
      state: "ready", error: null, isPlaying: false, currentTime: 0, duration: 3,
      peaks: null, peaksState: "idle",
      play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
      setTrim: setTrimSpy, requestPeaks: vi.fn(), ensureBytes: vi.fn(),
    }
  },
}))

vi.mock("@/lib/audio/transcribe", () => ({
  transcribeCell: vi.fn(async ({ cell, language, askAgain }: { cell: { id: string; fileId: string }; language?: string; askAgain?: boolean }) => {
    transcribeCalls.push({ cellId: cell.id, fileId: cell.fileId, language, askAgain })
    return 1
  }),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "j", username: "u" } }),
}))

// A corrected transcript rides a cell.audio.attach into the outbox — not what
// these tests are about.
const trimEmits: Array<Record<string, unknown>> = []
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async () => "evt-1"),
  emitCellAudioTrim: vi.fn(async (input: Record<string, unknown>) => { trimEmits.push(input); return "evt-trim" }),
}))

import { CellTakeBlock } from "./CellTakeBlock"
import { loadTranscriptCorrections } from "@/lib/store/transcript-corrections-store"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { WordTiming } from "@/lib/codex-editor/types"

const project = {
  id: "p1",
  sourceLanguage: "en",
  targetLanguage: "hy",
  audioMediaStrategy: "lazy",
} as unknown as ProjectRecord

/** A cue holding one take, as `mergeCellsWithAudio` leaves it. */
const cueOwner = (id = "cue-1"): CellData => {
  const audioId = `audio-${id}-1700000000-take.webm`
  return {
    id,
    fileId: "cue-sibling",
    original: "", translated: "", medium: "media",
    selectedAudioId: audioId,
    attachments: { [audioId]: { type: "audio", url: "frontier-audio://take" } },
  } as unknown as CellData
}

function draw(over: Partial<React.ComponentProps<typeof CellTakeBlock>> = {}) {
  const onUseAsCellText = vi.fn()
  const onOpenRecording = vi.fn()
  const onCommitted = vi.fn()
  render(
    <CellTakeBlock
      project={project}
      owner={cueOwner()}
      cellText="the translated line"
      editable
      username="u"
      session={null}
      onOpenRecording={onOpenRecording}
      onUseAsCellText={onUseAsCellText}
      onCommitted={onCommitted}
      {...over}
    />,
  )
  return { onUseAsCellText, onOpenRecording, onCommitted }
}

beforeEach(() => {
  audioCalls.length = 0
  transcribeCalls.length = 0
  trimCalls.length = 0
  trimEmits.length = 0
  localStorage.clear()
})

describe("whose recording it plays", () => {
  it("plays the row's player when one is handed in, so the cell highlight follows", () => {
    const play = vi.fn()
    draw({
      controller: {
        state: "ready", error: null, isPlaying: false, currentTime: 0.4, duration: 3,
        peaks: null, peaksState: "idle",
        play, pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
        setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
      },
    })
    expect(audioCalls).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Play audio" }))
    expect(play).toHaveBeenCalledOnce()
  })

  it("fetches from the OWNER's file, not from whatever row it sits in", () => {
    draw()
    expect(audioCalls).toHaveLength(1)
    expect(audioCalls[0].fileId).toBe("cue-sibling")
    expect(audioCalls[0].selectedAudioId).toBe("audio-cue-1-1700000000-take.webm")
  })

  it("plays a named attachment when one is given, not the owner's default", () => {
    // The generated-voice block passes its own id this way.
    const owner = cueOwner()
    owner.attachments!["gen-1"] = { type: "audio", url: "frontier-audio://gen" } as never
    draw({ owner, audioId: "gen-1" })
    expect(audioCalls[0].selectedAudioId).toBe("gen-1")
  })
})

// AQU-1217: the tab used to play the WHOLE file — an untrimmed take, and on an
// imported source-audio section the entire source reading.
describe("which part of the recording it plays", () => {
  it("plays a take through its stored trim", () => {
    const owner = cueOwner()
    const id = owner.selectedAudioId!
    owner.attachments![id] = { ...owner.attachments![id], trimStartMs: 300, trimEndMs: 2700 } as never
    draw({ owner })
    expect(trimCalls.at(-1)).toEqual([0.3, 2.7])
  })

  it("plays an untrimmed take whole", () => {
    draw()
    expect(trimCalls.at(-1)).toEqual([null, null])
  })

  it("plays only its section of a shared source-audio clip, not the whole reading", () => {
    // The imported clip is seeded with the FILE id, so it is not this cell's
    // take; its window is the section's own timing, not its transcription trim.
    const source = "audio-mark-reading-1700000000-src.wav"
    const owner = {
      ...cueOwner(),
      startTime: 17.6,
      endTime: 23.1,
      selectedAudioId: source,
      attachments: { [source]: { type: "audio", url: "frontier-audio://src", trimStartMs: 17_900, trimEndMs: 22_800 } },
    } as unknown as CellData
    draw({ owner })
    expect(trimCalls.at(-1)).toEqual([17.6, 23.1])
  })
})

// Sam, 2026-09-28: validation lives in the row's audio column, which sits right
// above the expanded cell — the waveform only shows the audio.
describe("validation", () => {
  it("draws no validation tick on the waveform, even for a validated take", () => {
    const owner = cueOwner()
    const id = owner.selectedAudioId!
    const validated = { ...owner, attachments: { [id]: { ...owner.attachments![id], validatorCount: 3, validators: ["u", "a", "b"] } } } as unknown as CellData
    draw({ owner: validated })
    expect(screen.getByTestId("cell-take-waveform")).toBeInTheDocument()
    expect(screen.queryByTestId("cell-take-waveform-validated")).toBeNull()
  })
})

// Sam, 2026-09-26: off the timeline a take wears its TRACK'S colour, the one
// stored with its file — not grey.
describe("its colour", () => {
  const hue = () => screen.getByTestId("cell-take-waveform").style.getPropertyValue("--tl-track-hue")
  const withFiles = (trackOverrides: Record<string, unknown>) =>
    ({ ...project, files: [{ id: "cue-sibling", trackOverrides }] }) as unknown as ProjectRecord

  it("is the file's dub-track colour for its main recording", () => {
    draw({ project: withFiles({ "target-audio": { color: "violet" } }) })
    expect(hue()).toBe("#865deb")
  })

  it("is the media view's default green where nobody picked one", () => {
    draw()
    expect(hue()).toBe("#40c06e")
  })

  it("is an added track's own colour for a take made on it", () => {
    const owner = cueOwner()
    const id = owner.selectedAudioId!
    const onTrack = { ...owner, attachments: { [id]: { ...owner.attachments![id], slot: "trk-es" } } } as unknown as CellData
    draw({
      owner: onTrack,
      project: withFiles({ "target-audio": { color: "violet" }, "trk-es": { kind: "audio", name: "Spanish", order: 4, color: "amber" } }),
    })
    expect(hue()).toBe("#eba720")
  })

  it("is the source row's lighter blue for a source-audio section", () => {
    const source = "audio-mark-reading-1700000000-src.wav"
    const owner = {
      ...cueOwner(), startTime: 17.6, endTime: 23.1, selectedAudioId: source,
      attachments: { [source]: { type: "audio", url: "frontier-audio://src" } },
    } as unknown as CellData
    draw({ owner, project: withFiles({ "target-audio": { color: "violet" } }) })
    expect(hue()).toBe("#0e9bd6")
    expect(screen.getByTestId("cell-take-waveform").className).toContain("bg-[color:var(--tl-track-gen)]")
  })
})

// Sam, 2026-09-25: trim right where you see it. The Crop popover is retired.
describe("trimming in place", () => {
  function sized() {
    const root = screen.getByTestId("cell-take-waveform")
    root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 56, width: 400, height: 56, x: 0, y: 0, toJSON: () => ({}) })
  }

  it("drags the start line and saves the trim on the cell that holds the take", () => {
    draw()
    sized()
    const line = screen.getByRole("slider", { name: /start of the kept audio/i })
    // Taken where it is (the clip's start) and dragged 40px in.
    fireEvent.pointerDown(line, { clientX: 0, buttons: 1 })
    fireEvent.pointerMove(line, { clientX: 40, buttons: 1 })
    fireEvent.pointerUp(line, { clientX: 40 })
    expect(trimEmits).toHaveLength(1)
    expect(trimEmits[0]).toMatchObject({
      fileId: "cue-sibling", cellId: "cue-1", audioId: "audio-cue-1-1700000000-take.webm",
      trimStartMs: 300, trimEndMs: null,
    })
  })

  it("saves nothing when a line is clicked but not moved", () => {
    draw()
    sized()
    const line = screen.getByRole("slider", { name: /start of the kept audio/i })
    fireEvent.pointerDown(line, { clientX: 4, buttons: 1 })
    fireEvent.pointerUp(line, { clientX: 4 })
    expect(trimEmits).toHaveLength(0)
  })

  it("nudges a focused line with the arrow keys", () => {
    draw()
    const line = screen.getByRole("slider", { name: /end of the kept audio/i })
    fireEvent.keyDown(line, { key: "ArrowLeft", shiftKey: true })
    expect(trimEmits.at(-1)).toMatchObject({ trimStartMs: null, trimEndMs: 2900 })
  })

  it("shows the trim but offers no dragging to someone who cannot edit", () => {
    const owner = cueOwner()
    const id = owner.selectedAudioId!
    owner.attachments![id] = { ...owner.attachments![id], trimStartMs: 300 } as never
    draw({ owner, editable: false })
    expect(screen.getByRole("slider", { name: /start of the kept audio/i })).toHaveAttribute("aria-readonly", "true")
  })

  it("never offers trim lines on a source-audio section — its window is the section", () => {
    const source = "audio-mark-reading-1700000000-src.wav"
    const owner = {
      ...cueOwner(), startTime: 1, endTime: 2, selectedAudioId: source,
      attachments: { [source]: { type: "audio", url: "frontier-audio://src" } },
    } as unknown as CellData
    draw({ owner })
    expect(screen.queryByRole("slider", { name: /kept audio/i })).toBeNull()
  })
})

describe("whose recording it acts on", () => {
  it("transcribes the OWNER's cell, in the target language", async () => {
    draw()
    fireEvent.click(screen.getByRole("button", { name: /transcribe/i }))
    await waitFor(() => expect(transcribeCalls).toHaveLength(1))
    expect(transcribeCalls[0]).toMatchObject({ cellId: "cue-1", fileId: "cue-sibling", askAgain: true })
    // A take voices the TARGET text; only an imported source clip is source speech.
    expect(transcribeCalls[0].language).toBe("hy")
  })

  it("re-records the OWNER's cell", () => {
    const { onOpenRecording } = draw()
    fireEvent.click(screen.getByRole("button", { name: /re-record/i }))
    expect(onOpenRecording).toHaveBeenCalledWith("cue-1")
  })

  it("flushes against the OWNER after a transcribe", async () => {
    const { onCommitted } = draw()
    fireEvent.click(screen.getByRole("button", { name: /transcribe/i }))
    await waitFor(() => expect(onCommitted).toHaveBeenCalledWith("cue-1"))
  })
})

describe("what it offers", () => {
  it("renders whatever header it is given — which heard line this is", () => {
    draw({ header: <span>Heard line · 1:03.4–1:05.9</span> })
    expect(screen.getByText("Heard line · 1:03.4–1:05.9")).toBeInTheDocument()
  })

  it("offers no transcribing on a synthesized voice — nobody performed it", () => {
    draw({ readOnlyTranscript: true, recordLabel: "Record over" })
    expect(screen.getByRole("button", { name: /record over/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /transcribe/i })).not.toBeInTheDocument()
  })

  it("keeps its controls out of reach on a read-only surface", () => {
    draw({ editable: false })
    expect(screen.getByRole("button", { name: /re-record/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /transcribe/i })).toBeDisabled()
  })
})

// AQU-463: a correction here is not just a fix to this one transcript — it is
// the only moment the app ever learns how ASR mishears this project's words.
describe("what a correction teaches the project", () => {
  const timings: WordTiming[] = ["the", "killy", "elders", "met"].map((word, i) => ({
    word,
    start: i * 5,
    end: i * 5 + word.length,
    t0: i,
    t1: i + 1,
  }))

  function correctTranscript(to: string) {
    draw({ timings, cellText: "the kilisusu elders met" })
    fireEvent.click(screen.getByRole("button", { name: /correct the transcript/i }))
    fireEvent.change(screen.getByRole("textbox"), { target: { value: to } })
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }))
  }

  it("remembers the word the human fixed, against this project", async () => {
    correctTranscript("the kilisusu elders met")
    await waitFor(() =>
      expect(loadTranscriptCorrections("p1")).toMatchObject([{ heard: "killy", corrected: "kilisusu" }]),
    )
  })

  it("learns nothing when the human rewrote the line instead of fixing a word", async () => {
    correctTranscript("alpha bravo charlie met")
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument())
    expect(loadTranscriptCorrections("p1")).toEqual([])
  })
})
