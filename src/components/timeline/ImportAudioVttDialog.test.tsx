// Re-importing an audio VTT: replace, or just re-time? (AQU-646 stage 4)
//
// The branch matters more than either outcome. Replacing mints a new sibling
// file with new cell ids, which strands every take recorded against the old
// cues; re-timing edits the cells already there, so ids survive and takes and
// pairings come through untouched. The likeliest reason to re-import at all is
// that the timings were wrong — we ship a frame-rate detector for exactly that
// — so the retime is the common case and must be what the dialog offers.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { ImportAudioVttDialog } from "./ImportAudioVttDialog"
import type { ReconcilableCue } from "@/lib/import/cue-reconcile"

/** Two cues, at 24fps-ish timings. */
const VTT = (aStart: string, bStart: string) =>
  `WEBVTT

1
00:00:${aStart} --> 00:00:12.000
Abba?

2
00:00:${bStart} --> 00:00:22.000
You should be sleeping.
`

const existing: ReconcilableCue[] = [
  { id: "cell-a", startTime: 10, endTime: 12, original: "Abba?", sourceEventId: "evt-a" },
  {
    id: "cell-b", startTime: 20, endTime: 22,
    original: "You should be sleeping.", sourceEventId: "evt-b",
  },
]

async function pick(
  content: string,
  props: Partial<React.ComponentProps<typeof ImportAudioVttDialog>> = {},
) {
  const onConfirm = vi.fn()
  const onReconcile = vi.fn()
  render(
    <ImportAudioVttDialog
      open
      replacing
      textFileName="ep101.vtt"
      onConfirm={onConfirm}
      onReconcile={onReconcile}
      onCancel={() => {}}
      {...props}
    />,
  )
  const input = screen.getByTestId("import-audio-vtt-input")
  const file = new File([content], "audio.vtt", { type: "text/vtt" })
  fireEvent.change(input, { target: { files: [file] } })
  await waitFor(() => expect(screen.getByTestId("import-audio-vtt-confirm")).not.toBeDisabled())
  return { onConfirm, onReconcile }
}

describe("the same cues with different timings", () => {
  it("offers a RETIME rather than a replacement", async () => {
    const { onConfirm, onReconcile } = await pick(VTT("10.500", "20.500"), { existingCues: existing })
    expect(screen.getByTestId("import-audio-vtt-reconcile")).toBeInTheDocument()
    expect(screen.getByTestId("import-audio-vtt-confirm")).toHaveTextContent("Update 2 cues")

    fireEvent.click(screen.getByTestId("import-audio-vtt-confirm"))
    // The replacement path must not run: it is what would strand the takes.
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onReconcile).toHaveBeenCalledOnce()
    const [plan] = onReconcile.mock.calls[0]
    // Both cues keep their cell ids — which is what leaves their recordings
    // and their pairings attached with nothing copied.
    expect(plan.retimes).toEqual([
      { cellId: "cell-a", startMs: 10500, endMs: 12000 },
      { cellId: "cell-b", startMs: 20500, endMs: 22000 },
    ])
    expect(plan.creates).toEqual([])
    expect(plan.deletes).toEqual([])
  })

  // The re-pair action used to live here as a checkbox and now lives in the
  // pairing drawer — reaching it by re-picking a VTT you had already imported
  // was a button wearing an import dialog. This dialog only ever pairs the cues
  // a reconcile ADDS, which needs no choice from anybody.
  it("offers no re-pair choice — that moved to the pairing drawer", async () => {
    await pick(VTT("10.500", "20.500"), { existingCues: existing })
    expect(screen.queryByTestId("import-audio-vtt-relink-toggle")).not.toBeInTheDocument()
  })

  it("refuses to pretend when the file is identical", async () => {
    const onReconcile = vi.fn()
    render(
      <ImportAudioVttDialog
        open replacing textFileName="ep101.vtt" existingCues={existing}
        onConfirm={vi.fn()} onReconcile={onReconcile} onCancel={() => {}}
      />,
    )
    const file = new File([VTT("10.000", "20.000")], "audio.vtt", { type: "text/vtt" })
    fireEvent.change(screen.getByTestId("import-audio-vtt-input"), { target: { files: [file] } })
    await waitFor(() =>
      expect(screen.getByTestId("import-audio-vtt-confirm")).toHaveTextContent("Nothing to update"),
    )
    expect(screen.getByTestId("import-audio-vtt-confirm")).toBeDisabled()
  })

})

describe("a genuinely different cue set", () => {
  // REWRITTEN 2026-08-14: this used to assert that changed wording fell back to
  // a full replacement. Reconcile handles it in place instead — the reworded
  // cue is a delete plus a create, so the OTHER cues (and their recordings and
  // pairings) are untouched, which a replacement could never manage.
  it("handles changed wording as a delete plus a create, sparing the rest", async () => {
    const { onConfirm, onReconcile } = await pick(
      `WEBVTT

1
00:00:10.500 --> 00:00:12.000
Abba?

2
00:00:20.500 --> 00:00:22.000
I see him.
`,
      { existingCues: existing },
    )
    expect(screen.getByTestId("import-audio-vtt-reconcile")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("import-audio-vtt-confirm"))
    expect(onConfirm).not.toHaveBeenCalled()
    const [plan] = onReconcile.mock.calls[0]
    expect(plan.deletes.map((d: { cellId: string }) => d.cellId)).toEqual(["cell-b"])
    expect(plan.creates.map((c: { value: string }) => c.value)).toEqual(["I see him."])
    // The untouched cue keeps its id, which is the whole point.
    expect(plan.kept).toBe(1)
  })

  it("stays a replacement on a first import, with nothing to compare against", async () => {
    const { onConfirm } = await pick(VTT("10.500", "20.500"))
    expect(screen.queryByTestId("import-audio-vtt-reconcile")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("import-audio-vtt-confirm"))
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})

// Removing the audio-cue track outright (Sam, 2026-08-14). Destructive twice
// over — it takes a whole track away, and any recordings sitting on those cues
// go out of reach with it — so it asks twice and states the count.
describe("removing the cues", () => {
  const renderWithRemove = (over: Record<string, unknown> = {}) => {
    const onRemove = vi.fn()
    render(
      <ImportAudioVttDialog
        open replacing textFileName="ep101.vtt" existingCues={existing}
        onConfirm={vi.fn()} onReconcile={vi.fn()} onRemove={onRemove}
        onCancel={() => {}} {...over}
      />,
    )
    return { onRemove }
  }

  it("does not fire on the first click — it asks", () => {
    const { onRemove } = renderWithRemove()
    fireEvent.click(screen.getByTestId("import-audio-vtt-remove"))
    expect(onRemove).not.toHaveBeenCalled()
    expect(screen.getByTestId("import-audio-vtt-remove-confirm")).toBeInTheDocument()
    // And the one-click entry point is gone, so the confirm pair cannot be
    // reached for it by a stray second click landing in the same place.
    expect(screen.queryByTestId("import-audio-vtt-remove")).not.toBeInTheDocument()
  })

  it("fires once confirmed", () => {
    const { onRemove } = renderWithRemove()
    fireEvent.click(screen.getByTestId("import-audio-vtt-remove"))
    fireEvent.click(screen.getByTestId("import-audio-vtt-remove-go"))
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it("backs out cleanly", () => {
    const { onRemove } = renderWithRemove()
    fireEvent.click(screen.getByTestId("import-audio-vtt-remove"))
    fireEvent.click(screen.getByTestId("import-audio-vtt-remove-cancel"))
    expect(onRemove).not.toHaveBeenCalled()
    expect(screen.getByTestId("import-audio-vtt-remove")).toBeInTheDocument()
  })

  it("names the recordings that would go out of reach", () => {
    renderWithRemove({ takeCount: 7 })
    fireEvent.click(screen.getByTestId("import-audio-vtt-remove"))
    const panel = screen.getByTestId("import-audio-vtt-remove-confirm")
    expect(panel).toHaveTextContent("7 recordings")
    // "Kept but unreachable" is the honest wording — file.delete is a SOFT
    // delete, and "lost" would ask for more nerve than the act requires.
    expect(panel).toHaveTextContent(/audio itself is kept/)
  })

  it("says nothing about recordings when there are none", () => {
    renderWithRemove({ takeCount: 0 })
    fireEvent.click(screen.getByTestId("import-audio-vtt-remove"))
    expect(screen.getByTestId("import-audio-vtt-remove-confirm")).not.toHaveTextContent("recording")
  })

  it("is absent entirely when removal is not on offer", () => {
    // No cues yet, or no clearance: file.delete is PROJECT_LEAD, a step above
    // the floor the rest of this dialog sits on.
    render(
      <ImportAudioVttDialog
        open replacing={false} textFileName="ep101.vtt"
        onConfirm={vi.fn()} onCancel={() => {}}
      />,
    )
    expect(screen.queryByTestId("import-audio-vtt-remove")).not.toBeInTheDocument()
  })
})
