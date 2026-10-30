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
