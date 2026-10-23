// The Transcribe lens. What matters: human work wins — "clean up all" never
// touches a validated take or a transcript a person corrected — and a hand edit
// saves as a correction (no AI mark), while the sparkle runs the two-step
// cleanup on that one row.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "ready", error: null, isPlaying: false, currentTime: 0, duration: 3,
    peaks: null, peaksState: "idle",
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
  }),
}))

const runCalls: string[] = []
/** The clip each run was handed, by cell: the sparkle must transcribe the
 *  row's own take, not whatever the recording slot holds. */
const runAudio: Record<string, string> = {}
vi.mock("@/lib/transcript-cleanup/run", () => ({
  transcribeAndCleanUp: vi.fn(async ({ row }: { row: { cell: { id: string }; audioId: string } }) => {
    runCalls.push(row.cell.id)
    runAudio[row.cell.id] = row.audioId
    return { kind: "cleaned", changes: 1 }
  }),
}))

const saves: Array<{ cellId: string; text: string; ai: unknown }> = []
vi.mock("@/lib/transcript-cleanup/save", () => ({
  saveTranscript: vi.fn(async (args: { owner: { id: string }; text: string; ai?: unknown }) => {
    saves.push({ cellId: args.owner.id, text: args.text, ai: args.ai })
    return true
  }),
}))

import { TranscribeEditor } from "./TranscribeEditor"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

const project = { id: "p1", lanes: [] } as unknown as ProjectRecord
const session = { jwt: "j", username: "u" } as never

function take(id: string, opts: { heard?: string; transcript?: string; validated?: boolean } = {}): CellData {
  const audioId = `audio-${id}-1700000000-take.webm`
  return {
    id,
    fileId: "f1",
    cellLabel: id,
    selectedAudioId: audioId,
    attachments: {
      [audioId]: {
        url: `frontier-audio://${audioId}`, type: "audio", isDeleted: false, createdAt: 0, updatedAt: 0,
        slot: "recording",
        ...(opts.heard ? { asrText: opts.heard } : {}),
        ...(opts.validated ? { validatorCount: 1 } : {}),
      },
    },
    audioTimings: opts.transcript
      ? { [audioId]: opts.transcript.split(" ").map((word, i) => ({ word, t0: i, t1: i + 1, start: 0, end: 0 })) }
      : {},
  } as unknown as CellData
}

/** A line voiced only by TTS (AQU-2146): the recording slot is empty and the
 *  generated voice is selected in its own slot. */
function voice(id: string): CellData {
  const audioId = `audio-${id}-1700000000-tts.webm`
  return {
    id,
    fileId: "f1",
    cellLabel: id,
    selectedGeneratedVoiceAudioId: audioId,
    attachments: {
      [audioId]: {
        url: `frontier-audio://${audioId}`, type: "audio", isDeleted: false, createdAt: 0, updatedAt: 0,
        slot: "generatedVoice", voiceId: "v1",
      },
    },
    audioTimings: {},
  } as unknown as CellData
}

beforeEach(() => {
  runCalls.length = 0
  saves.length = 0
  window.localStorage.clear()
})

describe("TranscribeEditor", () => {
  it("cleans up only rows nobody has signed off on or corrected by hand", async () => {
    const cells = [
      take("fresh"),
      take("validated", { heard: "a b", transcript: "a b", validated: true }),
      take("corrected", { heard: "eema akasema", transcript: "Yesu akasema" }),
      take("untouched", { heard: "x y", transcript: "x y" }),
    ]
    render(<TranscribeEditor project={project} cells={cells} session={session} concepts={[]} editable />)
    fireEvent.click(screen.getByTestId("transcribe-run-all"))
    // The button comes back when the run has finished every row it chose.
    await waitFor(() => expect(screen.queryByTestId("transcribe-progress")).toBeNull())
    expect(runCalls).toEqual(["fresh", "untouched"])
  })

  it("saves a hand edit as a correction, without the AI mark", async () => {
    render(<TranscribeEditor project={project} cells={[take("c1", { heard: "eema", transcript: "eema" })]} session={session} concepts={[]} editable />)
    const field = screen.getByTestId("transcribe-transcript")
    fireEvent.change(field, { target: { value: "Yesu" } })
    fireEvent.blur(field)
    await waitFor(() => expect(saves).toEqual([{ cellId: "c1", text: "Yesu", ai: undefined }]))
  })

  it("shows what ASR heard beside the transcript", () => {
    render(<TranscribeEditor project={project} cells={[take("c1", { heard: "eema akasema", transcript: "Yesu akasema" })]} session={session} concepts={[]} editable />)
    expect(screen.getByTestId("transcribe-heard").textContent).toBe("eema akasema")
    expect((screen.getByTestId("transcribe-transcript") as HTMLTextAreaElement).value).toBe("Yesu akasema")
  })

  it("lists a line voiced only by a generated voice instead of calling the file silent (AQU-2146)", () => {
    render(<TranscribeEditor project={project} cells={[voice("tts")]} session={session} concepts={[]} editable />)
    expect(screen.queryByTestId("transcribe-empty")).toBeNull()
    expect(screen.getByTestId("transcribe-row").getAttribute("data-cell-id")).toBe("tts")
  })

  it("runs the sparkle against the generated take itself", async () => {
    render(<TranscribeEditor project={project} cells={[voice("tts")]} session={session} concepts={[]} editable />)
    fireEvent.click(screen.getByTestId("transcribe-run"))
    await waitFor(() => expect(runCalls).toEqual(["tts"]))
    expect(runAudio.tts).toBe("audio-tts-1700000000-tts.webm")
  })

  it("withholds the empty state until the file's audio has been read", () => {
    const { rerender } = render(<TranscribeEditor project={project} cells={[]} session={session} concepts={[]} editable audioLoaded={false} />)
    expect(screen.queryByTestId("transcribe-empty")).toBeNull()
    rerender(<TranscribeEditor project={project} cells={[]} session={session} concepts={[]} editable audioLoaded />)
    expect(screen.getByTestId("transcribe-empty")).toBeTruthy()
  })
})
