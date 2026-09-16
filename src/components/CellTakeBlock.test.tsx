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
const transcribeCalls: Array<{ cellId: string; fileId: string; language?: string }> = []

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
      setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
    }
  },
}))

vi.mock("@/lib/audio/transcribe", () => ({
  transcribeCell: vi.fn(async ({ cell, language }: { cell: { id: string; fileId: string }; language?: string }) => {
    transcribeCalls.push({ cellId: cell.id, fileId: cell.fileId, language })
    return 1
  }),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "j", username: "u" } }),
}))

// A corrected transcript rides a cell.audio.attach into the outbox — not what
// these tests are about.
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async () => "evt-1"),
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
  localStorage.clear()
})

describe("whose recording it plays", () => {
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

describe("whose recording it acts on", () => {
  it("transcribes the OWNER's cell, in the target language", async () => {
    draw()
    fireEvent.click(screen.getByRole("button", { name: /transcribe/i }))
    await waitFor(() => expect(transcribeCalls).toHaveLength(1))
    expect(transcribeCalls[0]).toMatchObject({ cellId: "cue-1", fileId: "cue-sibling" })
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
