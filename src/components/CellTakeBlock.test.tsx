// One recording's controls, and WHOSE recording they act on.
//
// The whole reason this component exists is that a subtitle line's take may
// live on another cell in another file (the heard line that performs it). So
// the thing worth pinning is not what it draws but where its effects land: a
// block pointed at a cue must read and write the CUE, never the row it is
// rendered inside. Get that wrong and a transcript silently lands on the wrong
// file — which is worse than the empty tab this fixes.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { expectClickNote } from "@/test-utils/tooltip"
import { fmtShortCalendarDate } from "@/lib/format-date"

const audioCalls: Array<{ fileId: string; selectedAudioId: unknown; attachments: unknown }> = []
const transcribeCalls: Array<{ cellId: string; fileId: string; language?: string; selectedAudioId?: string; slot?: string; targetLang?: string; askAgain?: boolean }> = []
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
  transcribeCell: vi.fn(async ({ cell, language, slot, targetLang, askAgain }: { cell: { id: string; fileId: string; selectedAudioId?: string }; language?: string; slot?: string; targetLang?: string; askAgain?: boolean }) => {
    transcribeCalls.push({ cellId: cell.id, fileId: cell.fileId, language, selectedAudioId: cell.selectedAudioId, slot, targetLang, askAgain })
    return 1
  }),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "j", username: "u" } }),
}))

// A corrected transcript rides a cell.audio.attach into the outbox — not what
// these tests are about.
const trimEmits: Array<Record<string, unknown>> = []
const removeEmits: Array<Record<string, unknown>> = []
const renameEmits: Array<Record<string, unknown>> = []
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioRename: vi.fn(async (input: Record<string, unknown>) => { renameEmits.push(input); return "evt-rn" }),
  emitCellAudioRemove: vi.fn(async (input: Record<string, unknown>) => { removeEmits.push(input); return "evt-rm" }),
  emitCellAudioAttach: vi.fn(async () => "evt-1"),
  emitCellAudioTrim: vi.fn(async (input: Record<string, unknown>) => { trimEmits.push(input); return "evt-trim" }),
}))

const joinCalls: Array<Record<string, unknown>> = []
vi.mock("@/lib/audio/join-pieces", () => ({
  joinTakePieces: vi.fn(async (args: Record<string, unknown>) => { joinCalls.push(args); return "audio-c1-9-joined.wav" }),
}))

import { CellTakeBlock } from "./CellTakeBlock"
import { loadTranscriptCorrections } from "@/lib/store/transcript-corrections-store"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { WordTiming } from "@/lib/codex-editor/types"

const project = {
  id: "p1",
  sourceLanguage: "en",
  targetLanguage: "en",
  audioMediaStrategy: "lazy",
  // A take voices the lane's language. Settings keys are not consulted.
  lanes: [
    { id: "lanehy01", role: "target", language: "hy", name: null, langCode: null, legacyTag: "" },
  ],
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
    { wrapper: ({ children }) => <TooltipProvider delay={0}>{children}</TooltipProvider> },
  )
  return { onUseAsCellText, onOpenRecording, onCommitted }
}

beforeEach(() => {
  audioCalls.length = 0
  transcribeCalls.length = 0
  trimCalls.length = 0
  trimEmits.length = 0
  removeEmits.length = 0
  renameEmits.length = 0
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

  it("transcribes in the lane it is drawn in (AQU-1978)", async () => {
    // The timings re-attach deselects within the lane it names. Naming none
    // meant the `''` lane, whichever language the take was recorded in.
    draw({ targetLang: "fr" })
    fireEvent.click(screen.getByRole("button", { name: /transcribe/i }))
    await waitFor(() => expect(transcribeCalls).toHaveLength(1))
    expect(transcribeCalls[0].targetLang).toBe("fr")
  })

  it("opens the recorder on the OWNER's cell from New take", () => {
    const { onOpenRecording } = draw()
    fireEvent.click(screen.getByRole("button", { name: /new take/i }))
    expect(onOpenRecording).toHaveBeenCalledWith("cue-1", "recording")
  })

  // Sam, 2026-09-30: New take beside a take on an added track recorded onto
  // the main track — the recorder was opened without saying which.
  it("records New take onto the track of the take it sits beside", () => {
    const owner = {
      id: "c1", fileId: "f1", original: "", translated: "",
      selectedAudioId: "audio-c1-main.webm",
      attachments: {
        "audio-c1-main.webm": { type: "audio", url: "frontier-audio://main", slot: "recording" },
        "audio-c1-t2.webm": { type: "audio", url: "frontier-audio://t2", slot: "trk-2" },
      },
    } as unknown as CellData
    const { onOpenRecording } = draw({ owner, audioId: "audio-c1-t2.webm" })
    fireEvent.click(screen.getByRole("button", { name: /new take/i }))
    expect(onOpenRecording).toHaveBeenCalledWith("c1", "trk-2")
  })

  // A take on an added track: the transcriber reads the cell's SELECTED
  // recording, which is the default track's — this block used to transcribe
  // that one instead of its own take.
  it("transcribes THIS take, on its own track", async () => {
    const owner = {
      id: "c1", fileId: "f1", original: "", translated: "",
      selectedAudioId: "audio-c1-main.webm",
      attachments: {
        "audio-c1-main.webm": { type: "audio", url: "frontier-audio://main", slot: "recording" },
        "audio-c1-t2.webm": { type: "audio", url: "frontier-audio://t2", slot: "trk-2" },
      },
    } as unknown as CellData
    draw({ owner, audioId: "audio-c1-t2.webm" })
    fireEvent.click(screen.getByRole("button", { name: /transcribe/i }))
    await waitFor(() => expect(transcribeCalls).toHaveLength(1))
    expect(transcribeCalls[0]).toMatchObject({ cellId: "c1", selectedAudioId: "audio-c1-t2.webm", slot: "trk-2" })
  })

  it("flushes against the OWNER after a transcribe", async () => {
    const { onCommitted } = draw()
    fireEvent.click(screen.getByRole("button", { name: /transcribe/i }))
    await waitFor(() => expect(onCommitted).toHaveBeenCalledWith("cue-1"))
  })
})

describe("what its line says (Sam, 2026-09-30)", () => {
  it("names the track before the take when it is given one", () => {
    draw({ trackName: "Track" })
    expect(screen.getByTestId("cell-take-track")).toHaveTextContent("Track·")
    expect(screen.getByTestId("cell-take-label")).toHaveTextContent("Take")
  })

  it("names no track when it is not given one", () => {
    draw()
    expect(screen.queryByTestId("cell-take-track")).toBeNull()
  })

  // AQU-1217: a trimmed take shows its trimmed length. The line said the whole
  // file's 2.6s while the timer under it counted the kept 2.1s.
  it("gives the length that plays, trims taken off", () => {
    const owner = cueOwner()
    const id = owner.selectedAudioId!
    Object.assign((owner.attachments as unknown as Record<string, Record<string, unknown>>)[id], {
      durationMs: 2560, trimStartMs: 256, trimEndMs: 2320,
    })
    draw({ owner })
    // 2.064s kept, in tenths rounded down as the recorder says it (AQU-1767).
    expect(screen.getByTestId("cell-take-length")).toHaveTextContent("2.0s")
  })

  it("says a transcribed take cannot be checked when nothing says what it should say", () => {
    draw({ cellText: null, timings: [{ word: "some", start: 0, end: 4, t0: 0, t1: 0.4 }] })
    expect(screen.getByTestId("cell-take-verdict")).toHaveTextContent("Transcribed")
  })

  it("says there is no text to compare, rather than that every word differs", () => {
    draw({ cellText: "", timings: [{ word: "some", start: 0, end: 4, t0: 0, t1: 0.4 }] })
    expect(screen.getByTestId("cell-take-verdict")).toHaveTextContent("No text to compare")
  })
})

describe("what it offers", () => {
  it("renders whatever header it is given — which heard line this is", () => {
    draw({ header: <span>Heard line · 1:03.4–1:05.9</span> })
    expect(screen.getByText("Heard line · 1:03.4–1:05.9")).toBeInTheDocument()
  })

  it("offers no transcribing on a synthesized voice — nobody performed it", () => {
    draw({ readOnlyTranscript: true })
    expect(screen.getByRole("button", { name: /new take/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /transcribe/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId("cell-take-verdict")).toBeNull()
  })

  it("keeps its controls out of reach on a read-only surface", () => {
    draw({ editable: false })
    expect(screen.getByRole("button", { name: /new take/i })).toBeDisabled()
    // Says it is not transcribed, but offers nothing to do about it.
    expect(screen.getByTestId("cell-take-verdict")).toHaveTextContent("Not transcribed")
    expect(screen.queryByRole("button", { name: /transcribe/i })).not.toBeInTheDocument()
  })
})

// Sam, 2026-09-29: the take that plays, said plainly, with how it compares
// with the text — and the transcript only when there is something to read.
describe("the take that plays", () => {
  const words = (text: string) => {
    let at = 0
    return text.split(" ").map((word) => {
      const start = at
      at += word.length + 1
      return { word, start, end: start + word.length, t0: 0, t1: 0 } as unknown as WordTiming
    })
  }

  // No "plays for this line" label (Sam, 2026-09-29): being the big one on
  // top already says so.
  it("names the take, with its length", () => {
    const owner = cueOwner()
    const id = owner.selectedAudioId!
    ;(owner.attachments as unknown as Record<string, Record<string, unknown>>)[id] = {
      ...(owner.attachments as unknown as Record<string, Record<string, unknown>>)[id], label: "Take 2", durationMs: 3400,
    }
    draw({ owner })
    expect(screen.queryByText("Plays for this line")).toBeNull()
    expect(screen.getByTestId("cell-take-label")).toHaveTextContent("Take 2")
    expect(screen.getByText("3.4s")).toBeInTheDocument()
  })

  it("says it matches the text and keeps the transcript out of the way", () => {
    draw({ timings: words("the translated line") })
    expect(screen.getByTestId("cell-take-verdict")).toHaveTextContent("Matches the text")
    // The card would say "Your recording matches your text" — once is enough.
    expect(screen.queryByText(/matches your text/i)).toBeNull()
  })

  it("says how many words differ and shows what was heard", () => {
    draw({ timings: words("the translated lime") })
    expect(screen.getByTestId("cell-take-verdict")).toHaveTextContent("1 word differs")
    expect(screen.getByText(/sounds a little different/i)).toBeInTheDocument()
  })

  it("names who recorded it, and when the text has moved on since", () => {
    draw({
      provenance: {
        audioId: "x", recordedAt: Date.parse("2026-09-28T10:00:00Z"), recordedBy: "sam",
        textAtRecording: "old", textAtRecordingEventId: "e1", latestText: "new", latestTextEventId: "e2", drifted: true,
      },
    })
    const stamp = screen.getByTestId("cell-take-recorded")
    expect(stamp).toHaveTextContent("sam")
    expect(stamp).toHaveTextContent(fmtShortCalendarDate(Date.parse("2026-09-28T10:00:00Z")))
    expect(stamp.querySelector("[title]")).toBeNull()
    expect(screen.getByText("Text changed")).toBeInTheDocument()
  })

  // AQU-2260 (Sam, Oct 29): what the mark means opens on a click, never a hover.
  it("quotes the wording as recorded on a click of Text changed", async () => {
    draw({
      provenance: {
        audioId: "x", recordedAt: Date.parse("2026-09-28T10:00:00Z"), recordedBy: "sam",
        textAtRecording: "the old wording", textAtRecordingEventId: "e1", latestText: "new", latestTextEventId: "e2", drifted: true,
      },
    })
    const mark = screen.getByText("Text changed").closest("span")!
    expect(mark).not.toHaveAttribute("title")
    await expectClickNote(mark, "the old wording")
  })

  // Sam, 2026-09-29: the take's validation in its own line. Sam, 2026-09-30:
  // and it takes the vote — this is the take that plays, heard right here.
  it("takes the vote on the take that plays, in its line", () => {
    const owner = cueOwner()
    const id = owner.selectedAudioId!
    ;(owner.attachments as unknown as Record<string, Record<string, unknown>>)[id].validators = []
    draw({ owner })
    const head = screen.getByTestId("cell-take-head")
    const mark = head.querySelector('[data-testid="cell-take-validation"] [data-testid="audio-validation-button"]') as HTMLElement
    // One mark, in the take's line — and it is the vote.
    expect(screen.getAllByTestId("audio-validation-button")).toHaveLength(1)
    expect(mark.getAttribute("aria-label")).toMatch(/click to validate/i)
  })

  // Sam, 2026-09-29: deletable even when it is the line's only take.
  it("deletes itself from the cell that holds it, on its own slot", async () => {
    const onLastTakeRemoved = vi.fn()
    draw({ onLastTakeRemoved })
    fireEvent.click(screen.getByTestId("cell-take-delete"))
    await waitFor(() => expect(removeEmits).toHaveLength(1))
    expect(removeEmits[0]).toMatchObject({ fileId: "cue-sibling", cellId: "cue-1", audioId: "audio-cue-1-1700000000-take.webm" })
    // It was the cell's only recording: the workspace takes the line's credit back.
    await waitFor(() => expect(onLastTakeRemoved).toHaveBeenCalledWith("cue-1"))
  })

  it("does not report the last take while another recording remains", async () => {
    const onLastTakeRemoved = vi.fn()
    const owner = cueOwner()
    ;(owner.attachments as unknown as Record<string, Record<string, unknown>>)["audio-cue-1-1700000001-older.webm"] = { type: "audio", url: "frontier-audio://older" }
    draw({ owner, onLastTakeRemoved })
    fireEvent.click(screen.getByTestId("cell-take-delete"))
    await waitFor(() => expect(removeEmits).toHaveLength(1))
    expect(onLastTakeRemoved).not.toHaveBeenCalled()
  })

  it("cannot be deleted by someone who cannot edit", () => {
    draw({ editable: false })
    expect(screen.getByTestId("cell-take-delete")).toBeDisabled()
  })

  // Sam, 2026-09-29: renameable while it is the selected take, as every take
  // in the lists is.
  it("renames itself in place, on the cell that holds it", async () => {
    const owner = cueOwner()
    const id = owner.selectedAudioId!
    ;(owner.attachments as unknown as Record<string, Record<string, unknown>>)[id].label = "Take 4"
    draw({ owner })
    fireEvent.click(screen.getByTestId("cell-take-rename-button"))
    const input = screen.getByTestId("cell-take-rename") as HTMLInputElement
    expect(input.value).toBe("Take 4")
    fireEvent.change(input, { target: { value: "Keeper" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(renameEmits).toHaveLength(1))
    expect(renameEmits[0]).toMatchObject({ fileId: "cue-sibling", cellId: "cue-1", audioId: id, label: "Keeper" })
    // The new name shows at once, before the read catches up.
    expect(screen.getByTestId("cell-take-label")).toHaveTextContent("Keeper")
  })

  it("keeps its name when the rename is cancelled or left unchanged", () => {
    draw()
    fireEvent.click(screen.getByTestId("cell-take-rename-button"))
    const input = screen.getByTestId("cell-take-rename")
    fireEvent.change(input, { target: { value: "Something else" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.queryByTestId("cell-take-rename")).toBeNull()
    fireEvent.click(screen.getByTestId("cell-take-rename-button"))
    fireEvent.keyDown(screen.getByTestId("cell-take-rename"), { key: "Enter" })
    expect(renameEmits).toHaveLength(0)
  })

  // Sam, 2026-09-29: the running time in the waveform's bottom-left corner,
  // as the Audio view card has it.
  it("shows the running time over the part that plays", () => {
    draw()
    expect(screen.getByTestId("cell-take-time")).toHaveTextContent("0:00 / 0:03")
  })

  it("cannot be renamed by someone who cannot edit", () => {
    draw({ editable: false })
    expect(screen.getByTestId("cell-take-rename-button")).toBeDisabled()
  })

  it("has no mic on the waveform — New take is the way into the recorder", () => {
    draw()
    // The waveform's corner mic was named "Record audio".
    expect(screen.queryAllByRole("button", { name: /record/i })).toHaveLength(0)
    expect(screen.getByRole("button", { name: /new take/i })).toBeInTheDocument()
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

// AQU-981: a take in pieces — cut, or uploaded in parts — offers "Join into
// one recording", which makes one new take of the pieces in order.
describe("Join into one recording", () => {
  const url = "frontier-audio://audio-c1-1700000000-a.wav"
  const piece = (audioId: string, trimStartMs: number | null, trimEndMs: number | null, pieceOf?: string) => ({
    audioId, url, slot: "recording", mimeType: "audio/wav", voiceId: null, referenceAudioId: null,
    durationMs: 1200, trimStartMs, trimEndMs, label: null, ...(pieceOf ? { pieceOf } : {}),
  })
  const pieces = [piece("audio-c1-1-a.wav", null, 400), piece("audio-c1-2-b.wav", 400, null, "audio-c1-1-a.wav")]
  const owner = {
    id: "c1", fileId: "f1", original: "", translated: "",
    selectedAudioId: "audio-c1-1-a.wav",
    attachments: {
      "audio-c1-1-a.wav": { type: "audio", url, trimEndMs: 400, durationMs: 1200, slot: "recording" },
      "audio-c1-2-b.wav": { type: "audio", url, trimStartMs: 400, durationMs: 1200, slot: "recording", pieceOf: "audio-c1-1-a.wav" },
    },
  } as unknown as CellData

  it("is offered on a split take, and not on a whole one", () => {
    draw({ owner, audioId: "audio-c1-1-a.wav", pieces: pieces as never })
    expect(screen.getByTestId("cell-take-join").textContent).toContain("Join into one recording")
  })

  it("is not offered on a take of one piece", () => {
    draw()
    expect(screen.queryByTestId("cell-take-join")).toBeNull()
  })

  // Sam, Oct 29 (question 7): the joined take is named "Take N", numbered the
  // way the recorder numbers a new take (nextTakeLabel): one past the highest
  // take on this track, a take in pieces counting once, the source clip and
  // other tracks' takes left out.
  it("names the joined take as the recorder would name the next take", async () => {
    joinCalls.length = 0
    const attachments = owner.attachments as unknown as Record<string, Record<string, unknown>>
    const withOthers = {
      ...owner,
      attachments: {
        // The take in pieces, its pieces named one by one ("Take 2", "Take 3"),
        // as the take list used to: the list shows it as "Take 2 · split in 2".
        "audio-c1-1-a.wav": { ...attachments["audio-c1-1-a.wav"], label: "Take 2" },
        "audio-c1-2-b.wav": { ...attachments["audio-c1-2-b.wav"], label: "Take 3" },
        // A named take on this track beside it: Take 3 is next.
        "audio-c1-0-old.wav": { type: "audio", url: "frontier-audio://audio-c1-0-old.wav", slot: "recording", label: "Take 1" },
        // Not this track's, not a take, and gone: none of them counts.
        "audio-c1-5-other.wav": { type: "audio", url: "frontier-audio://audio-c1-5-other.wav", slot: "track-2", label: "Take 9" },
        "audio-f1-7-source.wav": { type: "audio", url: "frontier-audio://audio-f1-7-source.wav", slot: "recording" },
        "audio-c1-8-gone.wav": { type: "audio", url: "frontier-audio://audio-c1-8-gone.wav", slot: "recording", label: "Take 8", isDeleted: true },
      },
    } as unknown as CellData
    draw({ owner: withOthers, audioId: "audio-c1-1-a.wav", pieces: pieces as never })
    fireEvent.click(screen.getByTestId("cell-take-join"))
    await waitFor(() => expect(joinCalls).toHaveLength(1))
    expect(joinCalls[0]).toMatchObject({ cellId: "c1", slot: "recording", label: "Take 3" })
  })
})

// AQU-2260 (Sam, Oct 29): a hover may only NAME an icon-only button. "New
// take" carries its own words.
describe("hover only names icon buttons", () => {
  it("New take has no hover", async () => {
    draw()
    await userEvent.setup().hover(screen.getByTestId("cell-take-new"))
    await act(() => new Promise((r) => setTimeout(r, 30)))
    expect(screen.queryByRole("tooltip")).toBeNull()
  })
})
