// Decision 7 (Sam, 2026-10-22): in the recorder's takes list each piece of a
// cut take is a row of its own, under its take, with its own vote and its own
// name — as on the timeline and in the Recording tab. The take's own row keeps
// choosing, cleaning and deleting it whole, and takes no vote: it says how
// many of its pieces are approved.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expectDisabledNote } from "@/test-utils/tooltip"
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
// Each take's "recorded when, by whom". Empty unless a test gives one.
const drift = vi.hoisted(() => ({ map: new Map<string, unknown>() }))
vi.mock("@/hooks/useRecordingTextDrift", () => ({ useRecordingTextDrift: () => drift.map }))

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
  drift.map = new Map()
})

describe("TakesStrip — the recorder lists each piece of a cut take on its own row", () => {
  it("lists the take, then each piece under it by its own name", () => {
    draw(cutTake({ [P3]: { label: "Chorus" } }), P1)
    // The rows, not the waveform each row carries since AQU-2235.
    const rows = screen.getAllByTestId(/^take-row-(?!wave-)/)
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      `take-row-${P1}`, `take-row-piece-${P1}`, `take-row-piece-${P2}`, `take-row-piece-${P3}`,
    ])
    expect(screen.getByTestId(`take-label-${P1}`)).toHaveTextContent(/^Take 2$/)
    // Slice 3A (Oct 29): its pieces count says how many pieces; no "split in 3".
    expect(screen.queryByTestId(`take-split-${P1}`)).toBeNull()
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

  // Slice 3A (Sam, Oct 29, second round). In the recorder's list, at its real
  // width (about 310 to 410 px: narrowest with the film beside it in a short
  // window), a cut take's row holds its name, its length, its date and how
  // many of its pieces are approved. Measured in Chromium and WebKit with the
  // app's own CSS. The rules, which happy-dom (no layout) can only pin:
  //   · "· split in 3" is not on a row that says "N of 3 pieces approved":
  //     the count says the same;
  //   · the name keeps its room for "Take 12" (Oct 25), and the length never
  //     shrinks;
  //   · the count is what shortens first — it measures the room the text
  //     beside it can spare (PiecesApproved.test.tsx) — and the date gives
  //     way before it;
  //   · the text clips at its own edge and keeps room for the name and the
  //     length, so nothing in it is ever drawn over the buttons or the count.
  it("puts no \"split in\" beside the pieces count, keeps the name and the length whole, and lets the count shorten first", () => {
    drift.map = new Map([[P1, { audioId: P1, recordedAt: Date.UTC(2026, 9, 24, 12), recordedBy: "ana", drifted: false, textAtRecording: null }]])
    draw(cutTake(), P1)
    const row = screen.getByTestId(`take-row-${P1}`)
    const label = within(row).getByTestId(`take-label-${P1}`)
    const length = within(row).getByTestId(`take-length-${P1}`)
    const recorded = within(row).getByTestId(`take-recorded-${P1}`)
    const count = within(row).getByTestId(`take-pieces-approved-${P1}`)

    expect(within(row).queryByTestId(`take-split-${P1}`)).toBeNull()
    expect(row).not.toHaveTextContent(/split in/)
    expect(count).toHaveTextContent("1 of 3 pieces approved")

    // The name: room for "Take 12" (Oct 25); the length: never shrinks.
    expect(label).toHaveTextContent(/^Take 2$/)
    expect(label.className).toMatch(/\bmin-w-\[7ch\]/)
    expect(length.className).toMatch(/\bshrink-0\b/)
    expect(length).toHaveTextContent("3.0s")

    // The count fits itself beside the text; the date gives way.
    expect(count).toHaveAttribute("data-fit", "beside-text")
    expect(row).toHaveAttribute("data-fit-row")
    const text = label.parentElement!
    expect(text).toHaveAttribute("data-fit-text")
    // The date gives way first, whole or not at all: it sits alone in a
    // one-line box that wraps, so a date with no room drops out of sight.
    const dateBox = within(row).getByTestId(`take-recorded-fit-${P1}`)
    expect(dateBox).toContainElement(recorded)
    expect(dateBox).toHaveAttribute("data-fit", "give")
    // It grows into spare room only (from nothing, up to the date's width),
    // so it never takes a sliver from the name.
    expect(dateBox.className).toMatch(/\bbasis-0\b/)
    expect(dateBox.className).toMatch(/\bflex-1\b/)
    expect(dateBox.className).toMatch(/\bmax-w-max\b/)
    expect(dateBox.className).toMatch(/\bflex-wrap\b/)
    expect(dateBox.className).toMatch(/\boverflow-hidden\b/)
    expect(dateBox.className).toMatch(/\bh-4\b/)
    expect(recorded.className).toMatch(/\bshrink-0\b/)
    // Its first item: no width, but a line tall, so the second line is hidden.
    const lead = dateBox.firstElementChild as HTMLElement
    expect(lead).not.toBe(recorded)
    expect(lead.className).toMatch(/\bw-0\b/)
    expect(lead.className).toMatch(/\bh-4\b/)

    // The text clips at its edge and keeps room for the name and the length.
    expect(text).toContainElement(length)
    expect(text).not.toContainElement(count)
    expect(text.className).toMatch(/\boverflow-hidden\b/)
    expect(text.className).toMatch(/\bmin-w-\[calc\(11ch\+0\.25rem\)\]/)
  })

  it("leaves a take that was never cut as it was: its name keeps room for \"Take 12\"", () => {
    draw([take({ audioId: B, label: "Take 12" })], B)
    expect(screen.queryByTestId(`take-name-${B}`)).toBeNull()
    expect(screen.getByTestId(`take-label-${B}`)).toHaveTextContent(/^Take 12$/)
    expect(screen.getByTestId(`take-label-${B}`).className).toMatch(/\bmin-w-\[7ch\]/)
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
      // A piece nobody has voted on says it in a note a click on its check
      // opens (AQU-2260: never a hover); one with votes, at the foot of the
      // "validated by" list the same click opens.
      if (id === P2) {
        await userEvent.click(vote)
        expect(await screen.findByTestId("audio-validation-blocked-note")).toHaveTextContent(why)
      } else {
        await expectDisabledNote(vote, why)
      }
      await userEvent.keyboard("{Escape}")
      await waitFor(() => expect(document.querySelector('[data-slot="disabled-reason-note"], [role="dialog"]')).toBeNull())
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
    expect(screen.getAllByTestId(/^take-row-(?!wave-)/)).toHaveLength(1)
    expect(screen.queryByTestId(`take-pieces-approved-${B}`)).toBeNull()
    await userEvent.click(voteOn(screen.getByTestId(`take-row-${B}`)))
    expect(emitValidate.mock.calls.map(([i]) => (i as { audioId: string }).audioId)).toEqual([B])
  })
})
