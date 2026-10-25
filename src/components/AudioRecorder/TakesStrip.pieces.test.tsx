// Decision 7 (Sam, 2026-10-22): in the recorder's takes list each piece of a
// cut take is a row of its own, under its take, with its own vote and its own
// name — as on the timeline and in the Recording tab. The take's own row keeps
// choosing, cleaning and deleting it whole, and takes no vote: it says how
// many of its pieces are approved.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"

const sent = vi.hoisted(() => ({ removes: [] as string[] }))
const emitValidate = vi.fn(async (..._a: unknown[]) => "evt")
const emitRename = vi.fn(async (..._a: unknown[]) => "evt")
const emitSelect = vi.fn(async (..._a: unknown[]) => "evt")
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioValidate: (...a: unknown[]) => emitValidate(...a),
  emitCellAudioUnvalidate: vi.fn(async () => "evt"),
  emitCellAudioSelect: (...a: unknown[]) => emitSelect(...a),
  emitCellAudioDeselect: vi.fn(async () => "evt"),
  emitCellAudioRename: (...a: unknown[]) => emitRename(...a),
  emitCellAudioRemove: vi.fn(async (i: { audioId: string }) => { sent.removes.push(i.audioId); return "evt" }),
  enqueueEvents: vi.fn(async (inputs: Array<{ payload: { audioId: string } }>) => {
    sent.removes.push(...inputs.map((i) => i.payload.audioId))
    return inputs.map((_, i) => ({ event: {}, eventId: `ev-${i}` }))
  }),
}))
vi.mock("@/lib/history/history", () => ({ recordStep: vi.fn(), withGroup: async (_l: unknown, fn: () => Promise<unknown>) => fn() }))
vi.mock("@/hooks/useRecordingTextDrift", () => ({ useRecordingTextDrift: () => new Map() }))

const { TakesStrip } = await import("./TakesStrip")

const P1 = "audio-c1-1.webm", P2 = "audio-c1-2.webm", P3 = "audio-c1-3.webm", B = "audio-c1-4.webm"

const take = (over: Partial<AudioAttachmentOut> & { audioId: string }): AudioAttachmentOut => ({
  url: "frontier-audio://audio-c1-1.webm",
  slot: "recording",
  mimeType: "audio/webm",
  voiceId: null,
  referenceAudioId: null,
  durationMs: 3000,
  label: null,
  trimStartMs: null,
  trimEndMs: null,
  validatorCount: 0,
  validators: [],
  recordedBy: "ana",
  ...over,
})

/** "Take 2", cut twice by the Blade; Rita has approved its middle piece. */
const cutTake = (over: Record<string, Partial<AudioAttachmentOut>> = {}) => [
  take({ audioId: P1, label: "Take 2 · 1", trimEndMs: 1000, ...over[P1] }),
  take({ audioId: P2, label: "Take 2 · 2", trimStartMs: 1000, trimEndMs: 2000, pieceOf: P1, validatorCount: 1, validators: ["rita"], ...over[P2] }),
  take({ audioId: P3, label: "Take 2 · 3", trimStartMs: 2000, pieceOf: P1, ...over[P3] }),
]

const project = { id: "p1", name: "P", syncRole: { level: 600 } } as unknown as ProjectRecord

function draw(takes: AudioAttachmentOut[], selectedAudioId: string | null, opts: { author?: string; project?: ProjectRecord } = {}) {
  render(
    <I18nProvider>
      <TakesStrip
        projectId="p1"
        project={opts.project ?? project}
        fileId="f1"
        cellId="c1"
        takes={takes}
        selectedAudioId={selectedAudioId}
        author={opts.author ?? "lee"}
        session={null}
      />
    </I18nProvider>,
  )
}

const pieceRow = (id: string) => screen.getByTestId(`take-row-piece-${id}`)
const voteOn = (row: HTMLElement) => within(row).getByTestId("audio-validation-button")

beforeEach(() => {
  emitValidate.mockClear()
  emitRename.mockClear()
  emitSelect.mockClear()
  sent.removes = []
})

describe("TakesStrip — the recorder lists each piece of a cut take on its own row", () => {
  it("lists the take, then each piece under it by its own name", () => {
    draw(cutTake({ [P3]: { label: "Chorus" } }), P1)
    const rows = screen.getAllByTestId(/^take-row-/)
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      `take-row-${P1}`, `take-row-piece-${P1}`, `take-row-piece-${P2}`, `take-row-piece-${P3}`,
    ])
    expect(screen.getByTestId(`take-label-${P1}`)).toHaveTextContent(/^Take 2$/)
    expect(screen.getByTestId(`take-split-${P1}`)).toHaveTextContent("split in 3")
    expect(within(pieceRow(P1)).getByTestId(`take-label-piece-${P1}`)).toHaveTextContent(/^Take 2 · 1$/)
    expect(within(pieceRow(P2)).getByTestId(`take-label-piece-${P2}`)).toHaveTextContent(/^Take 2 · 2$/)
    expect(within(pieceRow(P3)).getByTestId(`take-label-piece-${P3}`)).toHaveTextContent(/^Chorus$/)
    // Each piece's own length: the part of the recording it plays.
    expect(within(pieceRow(P2)).getByTestId(`take-length-piece-${P2}`)).toHaveTextContent("1.0s")
    // A piece is not chosen or cleaned on its own: its take is.
    for (const id of [P1, P2, P3]) {
      expect(within(pieceRow(id)).queryByRole("button", { name: /use this take|active take/i })).toBeNull()
      expect(within(pieceRow(id)).queryByRole("button", { name: /remove noise/i })).toBeNull()
    }
  })

  it("takes no vote on the take's own row: it says how many of its pieces are approved", () => {
    draw(cutTake(), P1)
    const takeRow = screen.getByTestId(`take-row-${P1}`)
    expect(within(takeRow).queryByTestId("audio-validation-button")).toBeNull()
    expect(within(takeRow).getByTestId(`take-pieces-approved-${P1}`)).toHaveTextContent("1 of 3 pieces approved")
  })

  // Slice 3A evidence (Oct 25): at the recorder's width the cut take's name
  // was squeezed to "T." by the count beside it. jsdom has no layout, so this
  // pins the rule instead: the name keeps a minimum width, and the count and
  // "cut into" are the ones allowed to shrink (with the count's whole
  // sentence on hover).
  it("keeps the cut take's name readable in a narrow row", () => {
    draw(cutTake(), P1)
    expect(screen.getByTestId(`take-label-${P1}`).className).toMatch(/\bmin-w-\[7ch\]/)
    const count = screen.getByTestId(`take-pieces-approved-${P1}`)
    expect(count.className).toMatch(/\bmin-w-0\b/)
    expect(count.className).not.toMatch(/\bshrink-0\b/)
    expect(count).toHaveAttribute("title", "1 of 3 pieces approved")
    expect(screen.getByTestId(`take-split-${P1}`).className).not.toMatch(/\bshrink-0\b/)
  })

  it("gives each piece its own vote, showing only its own votes", () => {
    draw(cutTake(), P1)
    expect(voteOn(pieceRow(P2)).getAttribute("aria-label")).toMatch(/^Audio validated/)
    expect(voteOn(pieceRow(P1)).getAttribute("aria-label")).toMatch(/^Audio not validated/)
    expect(voteOn(pieceRow(P3)).getAttribute("aria-label")).toMatch(/^Audio not validated/)
  })

  it("approves one piece from its row, and only that piece", async () => {
    draw(cutTake(), P1)
    await userEvent.click(voteOn(pieceRow(P3)))
    expect(emitValidate).toHaveBeenCalledTimes(1)
    expect(emitValidate.mock.calls[0][0]).toMatchObject({ audioId: P3, surface: "recorder" })
  })

  // Sam, 2026-09-29 and -30: a vote is cast only on the take that plays. The
  // pieces of a take that is not the chosen one show theirs read-only.
  it("takes no vote on the pieces of a take that is not the chosen one", async () => {
    draw([...cutTake(), take({ audioId: B, label: "Take 3" })], B)
    for (const id of [P1, P2, P3]) await userEvent.click(voteOn(pieceRow(id)))
    expect(emitValidate).not.toHaveBeenCalled()
    expect(voteOn(pieceRow(P2)).hasAttribute("aria-pressed")).toBe(false)
  })

  it("tells the person who recorded the take, on each piece, that someone else must validate it", async () => {
    draw(cutTake(), P1, { author: "ana", project: { ...project, allowSelfValidationAudio: false } as ProjectRecord })
    const why = "You recorded this — someone else must validate it"
    for (const id of [P1, P2, P3]) {
      const vote = voteOn(pieceRow(id))
      expect(vote.getAttribute("aria-label")).not.toMatch(/click to validate/i)
      await userEvent.click(vote)
      await userEvent.hover(vote)
      // A piece nobody has voted on says it in its tooltip; one with votes,
      // at the foot of its "validated by" list.
      if (id === P2) expect(await screen.findByTestId("audio-validation-blocked-note")).toHaveTextContent(why)
      else expect(await screen.findByRole("tooltip")).toHaveTextContent(why)
      await userEvent.unhover(vote)
      await userEvent.keyboard("{Escape}")
    }
    expect(emitValidate).not.toHaveBeenCalled()
  })

  it("counts a piece approved only once it has the approvals the project requires", () => {
    draw(
      cutTake({
        [P1]: { validatorCount: 2, validators: ["rita", "ravi"] },
        [P2]: { validatorCount: 2, validators: ["rita", "ravi"] },
        [P3]: { validatorCount: 1, validators: ["rita"] },
      }),
      P1,
      { project: { ...project, validationCountAudio: 2 } as ProjectRecord },
    )
    const line = screen.getByTestId(`take-pieces-approved-${P1}`)
    expect(line).toHaveTextContent("2 of 3 pieces approved")
    expect(line).toHaveAttribute("data-all-approved", "false")
  })

  it("says so when every piece is approved", () => {
    draw(cutTake({ [P1]: { validatorCount: 1 }, [P3]: { validatorCount: 1 } }), P1)
    const line = screen.getByTestId(`take-pieces-approved-${P1}`)
    expect(line).toHaveTextContent("3 of 3 pieces approved")
    expect(line).toHaveAttribute("data-all-approved", "true")
  })

  it("renames one piece from its row, starting from its own name; its siblings and the take keep theirs", async () => {
    draw(cutTake(), P1)
    fireEvent.click(within(pieceRow(P2)).getByRole("button", { name: "Rename take" }))
    const box = screen.getByTestId(`take-rename-piece-${P2}`)
    expect(box).toHaveValue("Take 2 · 2")
    fireEvent.change(box, { target: { value: "Chorus" } })
    fireEvent.keyDown(box, { key: "Enter" })
    await vi.waitFor(() => expect(emitRename).toHaveBeenCalled())
    expect(emitRename.mock.calls.map(([i]) => [(i as { audioId: string }).audioId, (i as { label: string }).label]))
      .toEqual([[P2, "Chorus"]])
    expect(screen.getByTestId(`take-label-piece-${P2}`)).toHaveTextContent(/^Chorus$/)
    expect(screen.getByTestId(`take-label-piece-${P1}`)).toHaveTextContent(/^Take 2 · 1$/)
    expect(screen.getByTestId(`take-label-piece-${P3}`)).toHaveTextContent(/^Take 2 · 3$/)
    expect(screen.getByTestId(`take-label-${P1}`)).toHaveTextContent(/^Take 2$/)
  })

  it("never renames the take's own row: its pieces are renamed", () => {
    draw(cutTake(), P1)
    expect(within(screen.getByTestId(`take-row-${P1}`)).queryByRole("button", { name: "Rename take" })).toBeNull()
  })

  it("deletes one piece from its row, and the whole take from its own", async () => {
    draw(cutTake(), P1)
    fireEvent.click(within(pieceRow(P3)).getByRole("button", { name: "Delete take" }))
    await vi.waitFor(() => expect(sent.removes).toEqual([P3]))

    sent.removes = []
    fireEvent.click(within(screen.getByTestId(`take-row-${P1}`)).getByRole("button", { name: "Delete take" }))
    await vi.waitFor(() => expect(sent.removes).toEqual([P1, P2, P3]))
  })

  it("chooses the take whole from its own row", async () => {
    draw([...cutTake(), take({ audioId: B, label: "Take 3" })], B)
    fireEvent.click(within(screen.getByTestId(`take-row-${P1}`)).getByRole("button", { name: "Use this take" }))
    await vi.waitFor(() => expect(emitSelect).toHaveBeenCalled())
    expect(emitSelect.mock.calls[0][0]).toMatchObject({ audioId: P1 })
  })

  it("lists a take never cut as one row, voted on as before", async () => {
    draw([take({ audioId: B, label: "Take 3" })], B)
    expect(screen.getAllByTestId(/^take-row-/)).toHaveLength(1)
    expect(screen.queryByTestId(`take-pieces-approved-${B}`)).toBeNull()
    await userEvent.click(voteOn(screen.getByTestId(`take-row-${B}`)))
    expect(emitValidate.mock.calls.map(([i]) => (i as { audioId: string }).audioId)).toEqual([B])
  })
})
