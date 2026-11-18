// AQU-2260 (Sam, Oct 29): nothing explains itself on hover. A failed row's
// status says what went wrong in words; the detail behind it opens on a click.

import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { expectClickNote } from "@/test-utils/tooltip"

vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({ isPlaying: false, play: vi.fn(), pause: vi.fn(), setTrim: vi.fn() }),
}))

import { TranscribeRow } from "./TranscribeRow"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { TranscriptRow } from "@/lib/transcript-cleanup/rows"

const project = { id: "p1", name: "P" } as unknown as ProjectRecord
const row = {
  cell: { id: "c1", fileId: "f1", attachments: { a1: { url: "frontier-audio://a1", type: "audio" } } },
  audioId: "a1", isSourceSegment: false, heard: "bonjour", transcript: "bonjour", aiCleaned: false, validated: false,
} as unknown as TranscriptRow

function draw(status: Parameters<typeof TranscribeRow>[0]["status"]) {
  return render(
    <TranscribeRow
      project={project} row={row} label="GEN 1:1" editable canRun status={status} selected={false}
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
        status={{ kind: "working", progress: { stage: "listening" } }} modelWaking selected={false}
        onToggleSelect={vi.fn()} onRun={vi.fn()} onSave={vi.fn()} onRevert={vi.fn()} onClear={vi.fn()}
      />,
    )
    expect(screen.getByTestId("transcribe-stage").textContent).toBe("Waking up the speech model…")
  })

  // The first token of a cleanup must not strike the whole line out: only the
  // words the reply has reached are compared, the rest wait unmarked.
  it("marks only the part of the heard text a streaming cleanup has reached", () => {
    render(
      <TranscribeRow
        project={project} row={{ ...row, heard: "eema akasema amina amina", transcript: "eema akasema amina amina" }}
        label="GEN 1:1" editable canRun selected={false}
        status={{ kind: "working", progress: { stage: "cleaning", heard: "eema akasema amina amina", text: "Yesu ak" } }}
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
