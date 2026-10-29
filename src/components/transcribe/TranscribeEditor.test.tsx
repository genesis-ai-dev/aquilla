// The Transcribe lens. What matters: "Transcribe all" is speech recognition
// only, on rows with nothing transcribed; the AI cleanup runs only on rows a
// person picks (the sparkle, or the ticked rows), and never on a validated
// take. A hand edit saves as a correction (no AI mark); emptying it goes back
// to what ASR heard without teaching a word fix; clearing on the left removes
// both.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { createRef } from "react"
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
const asrCalls: string[] = []
/** The clip each run was handed, by cell: the sparkle must transcribe the
 *  row's own take, not whatever the recording slot holds. */
const runAudio: Record<string, string> = {}
vi.mock("@/lib/transcript-cleanup/run", () => ({
  rowLanguage: () => undefined,
  transcribeAndCleanUp: vi.fn(async ({ row }: { row: { cell: { id: string }; audioId: string } }) => {
    runCalls.push(row.cell.id)
    runAudio[row.cell.id] = row.audioId
    return { kind: "cleaned", changes: 1 }
  }),
  transcribeRow: vi.fn(async ({ row }: { row: { cell: { id: string } } }) => {
    asrCalls.push(row.cell.id)
    return { kind: "transcribed" }
  }),
}))

const saves: Array<{ cellId: string; text: string; ai: unknown; learn?: boolean }> = []
const clears: string[] = []
vi.mock("@/lib/transcript-cleanup/save", () => ({
  saveTranscript: vi.fn(async (args: { owner: { id: string }; text: string; ai?: unknown; learn?: boolean }) => {
    saves.push({ cellId: args.owner.id, text: args.text, ai: args.ai, ...(args.learn === false ? { learn: false } : {}) })
    return true
  }),
  clearTranscript: vi.fn(async (args: { owner: { id: string } }) => {
    clears.push(args.owner.id)
    return true
  }),
}))

import { TranscribeEditor, type TranscribeEditorHandle } from "./TranscribeEditor"
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
  asrCalls.length = 0
  saves.length = 0
  clears.length = 0
  window.localStorage.clear()
  window.confirm = vi.fn(() => true)
})

describe("TranscribeEditor", () => {
  it("transcribes all without cleaning up, and only rows with nothing transcribed", async () => {
    const cells = [
      take("fresh"),
      take("fresh2"),
      take("validated", { heard: "a b", transcript: "a b", validated: true }),
      take("untouched", { heard: "x y", transcript: "x y" }),
    ]
    render(<TranscribeEditor project={project} cells={cells} session={session} concepts={[]} editable />)
    fireEvent.click(screen.getByTestId("transcribe-run-all"))
    // The button comes back when the run has finished every row it chose.
    await waitFor(() => expect(screen.queryByTestId("transcribe-progress")).toBeNull())
    expect(asrCalls.sort()).toEqual(["fresh", "fresh2"])
    expect(runCalls).toEqual([])
  })

  it("cleans up the ticked rows — Shift-click ticks a range — and never a validated take", async () => {
    const cells = [
      take("a", { heard: "x", transcript: "x" }),
      take("b", { heard: "x", transcript: "x", validated: true }),
      take("c", { heard: "x", transcript: "x" }),
      take("d", { heard: "x", transcript: "x" }),
    ]
    render(<TranscribeEditor project={project} cells={cells} session={session} concepts={[]} editable />)
    const boxes = screen.getAllByTestId("transcribe-select")
    fireEvent.click(boxes[0])
    fireEvent.click(boxes[2], { shiftKey: true })
    fireEvent.click(screen.getByTestId("transcribe-clean-selected"))
    await waitFor(() => expect(screen.queryByTestId("transcribe-progress")).toBeNull())
    expect(runCalls.sort()).toEqual(["a", "c"])
    // The selection is used up by the run.
    expect(screen.queryByTestId("transcribe-clean-selected")).toBeNull()
  })

  it("goes back to what ASR heard when the transcript is emptied, without learning from it", async () => {
    render(<TranscribeEditor project={project} cells={[take("c1", { heard: "eema", transcript: "Yesu" })]} session={session} concepts={[]} editable />)
    const field = screen.getByTestId("transcribe-transcript")
    fireEvent.change(field, { target: { value: "" } })
    fireEvent.blur(field)
    await waitFor(() => expect(saves).toEqual([{ cellId: "c1", text: "eema", ai: undefined, learn: false }]))
  })

  it("clears what ASR heard and the transcript from the left side", async () => {
    render(<TranscribeEditor project={project} cells={[take("c1", { heard: "eema", transcript: "Yesu" })]} session={session} concepts={[]} editable />)
    fireEvent.click(screen.getByTestId("transcribe-clear"))
    await waitFor(() => expect(clears).toEqual(["c1"]))
    expect(saves).toEqual([])
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

  // ── AQU-2153: the list resumes the line you left it at ──────────────────
  // happy-dom lays nothing out, so these two stub the geometry the measure and
  // the restore read: a 400px list under a 40px sticky toolbar, with 100px
  // rows. The point is the ARITHMETIC against the toolbar's bottom edge (the
  // real top of the visible content) and the anchoring by cell rather than by
  // pixel offset — not the browser's layout.
  const ROW_H = 100
  const TOOLBAR_H = 40
  const asRect = (top: number, height: number) => ({
    top, bottom: top + height, height, y: top, left: 0, right: 0, width: 0, x: 0, toJSON() {},
  }) as DOMRect

  function stubGeometry(list: HTMLElement) {
    // Re-read the rows per call: a take arriving adds one, and a stub that
    // captured the old set would place the new row nowhere.
    return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this === list) return asRect(0, 400)
      // Sticky: the toolbar stays pinned to the list's top edge.
      if (this === list.firstElementChild) return asRect(0, TOOLBAR_H)
      const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-cell-id]"))
      const index = rows.indexOf(this as HTMLElement)
      return index < 0 ? asRect(0, 0) : asRect(TOOLBAR_H + index * ROW_H - list.scrollTop, ROW_H)
    })
  }

  const fiveLines = () => ["r0", "r1", "r2", "r3", "r4"].map((id) => take(id, { heard: "a", transcript: "a" }))

  it("reports the line at the top of the visible content, not the first line rendered (AQU-2153)", () => {
    const ref = createRef<TranscribeEditorHandle>()
    render(<TranscribeEditor ref={ref} project={project} cells={fiveLines()} session={session} concepts={[]} editable />)
    const list = screen.getByTestId("transcribe-editor")
    const rects = stubGeometry(list)
    try {
      expect(ref.current?.getTopVisibleCellId()).toBe("r0")
      // Scrolled past r0 and r1, and r2's lower half is under the toolbar.
      list.scrollTop = 250
      expect(ref.current?.getTopVisibleCellId()).toBe("r2")
    } finally {
      rects.mockRestore()
    }
  })

  it("reopens at the remembered line, anchored by cell rather than pixel offset (AQU-2153)", () => {
    const cells = fiveLines()
    const { rerender } = render(
      <TranscribeEditor project={project} cells={cells} session={session} concepts={[]} editable initialTopCellId={null} />,
    )
    const list = screen.getByTestId("transcribe-editor")
    const rects = stubGeometry(list)
    try {
      rerender(
        <TranscribeEditor project={project} cells={cells} session={session} concepts={[]} editable initialTopCellId="r3" />,
      )
      // r3 starts 300px below the toolbar's bottom edge; that is the scroll.
      expect(list.scrollTop).toBe(300)
    } finally {
      rects.mockRestore()
    }
  })

  it("leaves the list alone for a remembered line the file no longer has (AQU-2153)", () => {
    const cells = fiveLines()
    const { rerender } = render(
      <TranscribeEditor project={project} cells={cells} session={session} concepts={[]} editable initialTopCellId={null} />,
    )
    const list = screen.getByTestId("transcribe-editor")
    const rects = stubGeometry(list)
    try {
      list.scrollTop = 250
      rerender(
        <TranscribeEditor project={project} cells={cells} session={session} concepts={[]} editable initialTopCellId="deleted-since" />,
      )
      // A line deleted or re-imported since is never going to turn up: the
      // list must not scroll to some other row, or hunt it on every commit.
      expect(list.scrollTop).toBe(250)
    } finally {
      rects.mockRestore()
    }
  })

  it("waits for a remembered line whose take has not arrived yet (AQU-2153)", () => {
    const { rerender } = render(
      <TranscribeEditor project={project} cells={fiveLines()} session={session} concepts={[]} editable initialTopCellId={null} />,
    )
    const list = screen.getByTestId("transcribe-editor")
    const rects = stubGeometry(list)
    try {
      rerender(
        <TranscribeEditor project={project} cells={fiveLines()} session={session} concepts={[]} editable initialTopCellId="r5" />,
      )
      expect(list.scrollTop).toBe(0)
      const withR5 = [...fiveLines(), take("r5", { heard: "a", transcript: "a" })]
      rerender(
        <TranscribeEditor project={project} cells={withR5} session={session} concepts={[]} editable initialTopCellId="r5" />,
      )
      expect(list.scrollTop).toBe(500)
    } finally {
      rects.mockRestore()
    }
  })

  it("withholds the empty state until the file's audio has been read", () => {
    const { rerender } = render(<TranscribeEditor project={project} cells={[]} session={session} concepts={[]} editable audioLoaded={false} />)
    expect(screen.queryByTestId("transcribe-empty")).toBeNull()
    rerender(<TranscribeEditor project={project} cells={[]} session={session} concepts={[]} editable audioLoaded />)
    expect(screen.getByTestId("transcribe-empty")).toBeTruthy()
  })
})
