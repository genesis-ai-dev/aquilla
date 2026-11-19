// AQU-2260 (Sam, Oct 29): nothing explains itself on hover. A failed row's
// status says what went wrong in words; the detail behind it opens on a click.

import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { expectClickNote } from "@/test-utils/tooltip"

/** How often each row's component function ran, by the clip it plays: every
 *  render of a row calls its audio hook once. */
const rowRenders = vi.hoisted(() => ({ count: {} as Record<string, number> }))
vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: (_project: unknown, cell: { metadata: { selectedAudioId: string } }) => {
    const clip = cell.metadata.selectedAudioId
    rowRenders.count[clip] = (rowRenders.count[clip] ?? 0) + 1
    return { isPlaying: false, play: vi.fn(), pause: vi.fn(), setTrim: vi.fn() }
  },
}))

import { TranscribeRow } from "./TranscribeRow"
import { createRowLiveStore, type RowStatus } from "./row-live-store"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { TranscriptRow } from "@/lib/transcript-cleanup/rows"

const project = { id: "p1", name: "P" } as unknown as ProjectRecord
const row = {
  cell: { id: "c1", fileId: "f1", attachments: { a1: { url: "frontier-audio://a1", type: "audio" } } },
  audioId: "a1", isSourceSegment: false, heard: "bonjour", transcript: "bonjour", aiCleaned: false, validated: false,
} as unknown as TranscriptRow

/** A row store that already holds this row's status (the row reads its own
 *  entry from it — AQU-2654). */
function storeWith(status: RowStatus) {
  const store = createRowLiveStore()
  store.setStatus("c1", status)
  return store
}

function draw(status: RowStatus) {
  return render(
    <TranscribeRow
      project={project} row={row} label="GEN 1:1" editable canRun store={storeWith(status)} selected={false}
      onToggleSelect={vi.fn()} onRun={vi.fn()} onSave={vi.fn()} onRevert={vi.fn()} onClear={vi.fn()}
    />,
  )
}

describe("TranscribeRow — a running row says what it is doing", () => {
  // "It just spins for a long time, so it feels kind of broken": a row waiting
  // on a cold model must say that it is the model waking, not just spin.
  it("says the speech model is waking up while it waits on a cold model", () => {
    render(
      <TranscribeRow
        project={project} row={{ ...row, heard: null, transcript: "" }} label="GEN 1:1" editable canRun
        store={storeWith({ kind: "working", progress: { stage: "listening" } })} modelWaking selected={false}
        onToggleSelect={vi.fn()} onRun={vi.fn()} onSave={vi.fn()} onRevert={vi.fn()} onClear={vi.fn()}
      />,
    )
    expect(screen.getByTestId("transcribe-stage").textContent).toBe("Waking up the speech model…")
  })

  // What was heard is typed out as it arrives. The row's own data has the
  // words at the same moment now (AQU-2654), which must not skip the typing —
  // and a row that simply has its text is not replayed.
  it("types out what a run just heard, even when the row's data already has it", () => {
    const heardRow = { ...row, heard: "eema akasema", transcript: "eema akasema" }
    const store = createRowLiveStore()
    const view = render(
      <TranscribeRow
        project={project} row={heardRow} label="GEN 1:1" editable canRun store={store} selected={false}
        onToggleSelect={vi.fn()} onRun={vi.fn()} onSave={vi.fn()} onRevert={vi.fn()} onClear={vi.fn()}
      />,
    )
    expect(screen.queryByTestId("transcribe-typed")).toBeNull()
    act(() => store.setStatus("c1", { kind: "working", progress: { stage: "heard", heard: "eema akasema", transcript: "eema akasema" } }))
    expect(screen.getByTestId("transcribe-typed")).toBeTruthy()
    // The run ends; the words are still being typed, not swapped out mid-word.
    act(() => store.setStatus("c1", { kind: "idle" }))
    expect(screen.getByTestId("transcribe-typed")).toBeTruthy()
    view.unmount()
  })

  // The first token of a cleanup must not strike the whole line out: only the
  // words the reply has reached are compared, the rest wait unmarked.
  it("marks only the part of the heard text a streaming cleanup has reached", () => {
    render(
      <TranscribeRow
        project={project} row={{ ...row, heard: "eema akasema amina amina", transcript: "eema akasema amina amina" }}
        label="GEN 1:1" editable canRun selected={false}
        store={storeWith({ kind: "working", progress: { stage: "cleaning", heard: "eema akasema amina amina", text: "Yesu ak" } })}
        onToggleSelect={vi.fn()} onRun={vi.fn()} onSave={vi.fn()} onRevert={vi.fn()} onClear={vi.fn()}
      />,
    )
    const heard = screen.getByTestId("transcribe-heard")
    expect([...heard.querySelectorAll("del")].map((el) => el.textContent)).toEqual(["eema"])
    expect(heard.querySelector('[data-diff="pending"]')?.textContent).toBe("akasema amina amina")
    // The half-written word is on the right, where the reply is being typed.
    expect(screen.getByTestId("transcribe-writing").textContent).toBe("Yesu ak")
  })
})

describe("TranscribeRow — a failure's detail opens on a click", () => {
  it("keeps the detail off the hover and behind a click on the status", async () => {
    draw({ kind: "failed", step: "asr", detail: "Model download failed (503)" })
    const status = screen.getByTestId("transcribe-status")
    expect(status).not.toHaveAttribute("title")
    await expectClickNote(status, "Model download failed (503)")
  })

  it("a status with no detail is plain words", () => {
    draw({ kind: "unchanged" })
    const status = screen.getByTestId("transcribe-status")
    expect(status.closest('[data-slot="note-on-click"]')).toBeNull()
  })
})

// AQU-2654 (docs/decisions/0013): a row renders for its own changes. What it
// is doing comes from its own entry in the row store, so another row's step —
// or a token of another row's cleanup — is not a reason for it to render, and
// neither is the list rendering around it with the same props.
describe("TranscribeRow — renders for its own line only", () => {
  const other = {
    ...row, audioId: "a2",
    cell: { id: "c2", fileId: "f1", attachments: { a2: { url: "frontier-audio://a2", type: "audio" } } },
  } as unknown as TranscriptRow
  const handlers = { onToggleSelect: vi.fn(), onRun: vi.fn(), onSave: vi.fn(), onRevert: vi.fn(), onClear: vi.fn() }

  function drawTwo() {
    const store = createRowLiveStore()
    rowRenders.count = {}
    /** Live counts: `c1` plays clip a1, `c2` plays a2. */
    const renders = {
      get c1() { return rowRenders.count.a1 ?? 0 },
      get c2() { return rowRenders.count.a2 ?? 0 },
    }
    const list = () => (
      <>
        <TranscribeRow project={project} row={row} label="1" editable canRun store={store} selected={false} {...handlers} />
        <TranscribeRow project={project} row={other} label="2" editable canRun store={store} selected={false} {...handlers} />
      </>
    )
    const view = render(list())
    return { store, renders, rerender: () => view.rerender(list()) }
  }

  it("a step of one row, and each frame of its streaming cleanup, renders that row alone", () => {
    vi.useFakeTimers()
    try {
      const { store, renders } = drawTwo()
      const before = { ...renders }
      act(() => store.setStatus("c1", { kind: "working", progress: { stage: "cleaning", heard: "bonjour", text: "" } }))
      expect(renders.c1).toBe(before.c1 + 1)
      // Forty tokens inside one frame are one render of the row, with the
      // newest text; the row beside it has not rendered at all.
      act(() => {
        for (let i = 1; i <= 40; i++) {
          store.setStatus("c1", { kind: "working", progress: { stage: "cleaning", heard: "bonjour", text: "Bon".repeat(i) } })
        }
      })
      expect(renders.c1).toBe(before.c1 + 1)
      act(() => { vi.advanceTimersToNextFrame() })
      expect(renders.c1).toBe(before.c1 + 2)
      expect(screen.getByTestId("transcribe-writing").textContent).toBe("Bon".repeat(40))
      expect(renders.c2).toBe(before.c2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not render again when the list renders around it with the same props", () => {
    const { renders, rerender } = drawTwo()
    const before = { ...renders }
    expect(before).toEqual({ c1: 1, c2: 1 })
    rerender()
    expect({ ...renders }).toEqual(before)
  })

  it("tells the list which line an action is for", () => {
    drawTwo()
    fireEvent.click(screen.getAllByTestId("transcribe-clear")[1])
    expect(handlers.onClear).toHaveBeenCalledWith("c2")
    const field = screen.getAllByTestId("transcribe-transcript")[0]
    fireEvent.change(field, { target: { value: "Bonjour" } })
    fireEvent.blur(field)
    expect(handlers.onSave).toHaveBeenCalledWith("c1", "Bonjour")
  })
})
