// The character check drawer. (AQU-646, 2026-08-18)
//
// The assertions that carry the weight are about the SHAPE of a decision: two
// buttons whose labels are the answers themselves, always in the same two
// positions, and a row that never disappears when you press one.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

import { CharacterCheckDrawer } from "./CharacterCheckDrawer"
import type { CharacterAgreement } from "@/lib/timeline/character-agreement"

const agreement = (over: Partial<CharacterAgreement> = {}): CharacterAgreement => ({
  open: [],
  resolved: [],
  sharedRows: 0,
  ...over,
})

const nameRow = {
  cueCellId: "q1",
  textCellId: "s1",
  heard: "I'm on official business.",
  name: { kind: "character" as const, subtitle: "NICODEMUS.", audio: "QUINTUS" },
}

/** The two sheets agree who speaks and differ about the shot. */
const cameraRow = {
  cueCellId: "q2",
  textCellId: "s2",
  heard: "Go!",
  camera: { subtitle: "off" as const, audio: "on" as const },
}

function draw(a: CharacterAgreement, over: Record<string, unknown> = {}) {
  const onResolve = vi.fn()
  const onNavigate = vi.fn()
  const onResetAll = vi.fn()
  render(
    <CharacterCheckDrawer
      agreement={a}
      bothSheetsImported
      onClose={() => {}}
      onNavigate={onNavigate}
      onResolve={onResolve}
      onResetAll={onResetAll}
      strictCamera={{ mixed: false, group: false }}
      onStrictCameraChange={() => {}}
      {...over}
    />,
  )
  return { onResolve, onNavigate, onResetAll }
}

describe("the two buttons are the two answers", () => {
  it("labels them with the values themselves, not with the sheets", () => {
    draw(agreement({ open: [nameRow] }))
    expect(screen.getByTestId("character-check-name-subtitle")).toHaveTextContent("NICODEMUS.")
    expect(screen.getByTestId("character-check-name-audio")).toHaveTextContent("QUINTUS")
  })

  it("puts the subtitle sheet LEFT and the heard-line sheet RIGHT, always", () => {
    // The positions must not shuffle under the cursor as you work down a list
    // of eighty.
    draw(agreement({ open: [nameRow] }))
    const buttons = screen.getAllByRole("button").filter((b) => b.dataset.testid?.includes("-name-"))
    expect(buttons.map((b) => b.dataset.testid)).toEqual([
      "character-check-name-subtitle",
      "character-check-name-audio",
    ])
  })

  it("passes the VALUE ON THE BUTTON, and the one it set aside", () => {
    // The write must never diverge from the label. The first cut re-derived
    // both values from the live cells at click time, which destroyed the
    // rejected answer the moment a pair had already been resolved — the
    // QUINTUS bug.
    const { onResolve } = draw(agreement({ open: [nameRow] }))
    fireEvent.click(screen.getByTestId("character-check-name-subtitle"))
    expect(onResolve).toHaveBeenCalledWith([
      {
        cueCellId: "q1",
        textCellId: "s1",
        axis: "name",
        side: "subtitle",
        value: "NICODEMUS.",
        rejected: "QUINTUS",
      },
    ])
  })

  it("passes raw camera states, not the words on the buttons", () => {
    const { onResolve } = draw(
      agreement({
        open: [{ cueCellId: "q1", textCellId: "s1", heard: "Go!", camera: { subtitle: "off", audio: "on" } }],
      }),
    )
    fireEvent.click(screen.getByTestId("character-check-camera-audio"))
    expect(onResolve).toHaveBeenCalledWith([
      expect.objectContaining({ axis: "camera", side: "audio", value: "on", rejected: "off" }),
    ])
  })

  it("puts BOTH axes on one row when a line disagrees about both", () => {
    // Settling the name and then watching a second row appear for the shot
    // reads like the fix did not take.
    draw(
      agreement({
        open: [{ ...nameRow, camera: { subtitle: "off" as const, audio: "on" as const } }],
      }),
    )
    // Exactly one row: filed under the speaker disagreement, carrying its
    // camera buttons with it.
    expect(screen.getAllByTestId("character-check-row")).toHaveLength(1)
    expect(screen.getByTestId("character-check-name-subtitle")).toBeInTheDocument()
    expect(screen.getByTestId("character-check-camera-audio")).toHaveTextContent("on camera")
  })

  it("says so when only half a row is settled, rather than looking untouched", () => {
    draw(
      agreement({
        open: [
          {
            cueCellId: "q1",
            textCellId: "s1",
            heard: "Good.",
            camera: { subtitle: "off", audio: "on" },
            settled: { name: { chose: "audio", rejected: "ANDREW." }, at: 1 },
          },
        ],
      }),
    )
    expect(screen.getByTestId("character-check-row")).toHaveTextContent("ANDREW. was set aside")
  })

  it("takes you to the line, because a disagreement is judged in place", () => {
    const { onNavigate } = draw(agreement({ open: [nameRow] }))
    // The heard line renders quoted, so match on the row and click it whole —
    // the entire card is the navigation target, like the pairing drawer's.
    fireEvent.click(screen.getByTestId("character-check-row"))
    expect(onNavigate).toHaveBeenCalledWith("q1", ["s1"])
  })
})

describe("nothing ever drops out", () => {
  const resolved = agreement({
    resolved: [
      {
        cueCellId: "q1",
        textCellId: "s1",
        heard: "I'm on official business.",
        name: { chose: "subtitle", current: "NICODEMUS.", rejected: "QUINTUS" },
        at: 5,
      },
    ],
  })

  it("keeps a settled row, showing what was set aside", () => {
    draw(resolved)
    fireEvent.click(screen.getByTestId("character-check-resolved-toggle"))
    const row = screen.getByTestId("character-check-resolved-row")
    expect(row).toHaveTextContent("NICODEMUS.")
    // The rejected answer survives nowhere else once both cells agree.
    expect(row).toHaveTextContent("QUINTUS")
  })

  it("marks which one was chosen and still lets you change it", () => {
    const { onResolve } = draw(resolved)
    fireEvent.click(screen.getByTestId("character-check-resolved-toggle"))
    expect(screen.getByTestId("character-check-resolved-name-subtitle")).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    fireEvent.click(screen.getByTestId("character-check-resolved-name-audio"))
    // A flip: the value comes from the RECORD, since both cells hold the
    // winner now and know nothing about what lost.
    expect(onResolve).toHaveBeenCalledWith([
      expect.objectContaining({ axis: "name", side: "audio", value: "QUINTUS", rejected: "NICODEMUS." }),
    ])
  })

  it("treats re-clicking the side already chosen as a NO-OP", () => {
    // This exact gesture is what destroyed QUINTUS: the re-click was treated
    // as news and re-recorded the winner as its own rejected answer.
    const { onResolve } = draw(resolved)
    fireEvent.click(screen.getByTestId("character-check-resolved-toggle"))
    fireEvent.click(screen.getByTestId("character-check-resolved-name-subtitle"))
    expect(onResolve).not.toHaveBeenCalled()
  })

  it("keeps the resolved list folded away until asked for", () => {
    draw(resolved)
    expect(screen.queryByTestId("character-check-resolved-row")).not.toBeInTheDocument()
  })

  it("offers the way ALL the way back, behind an are-you-sure", () => {
    // The mirror of the bulk button: a sweep taken in error is one click and
    // one confirm from undone.
    const { onResetAll } = draw(resolved)
    fireEvent.click(screen.getByTestId("character-check-reset"))
    expect(onResetAll).not.toHaveBeenCalled()
    expect(screen.getByTestId("character-check-reset-confirm")).toHaveTextContent("Un-resolve all 1")
    fireEvent.click(screen.getByTestId("character-check-reset-go"))
    expect(onResetAll).toHaveBeenCalled()
  })

  it("lets the reset be thought better of", () => {
    const { onResetAll } = draw(resolved)
    fireEvent.click(screen.getByTestId("character-check-reset"))
    fireEvent.click(screen.getByText("Cancel"))
    expect(onResetAll).not.toHaveBeenCalled()
    expect(screen.getByTestId("character-check-reset")).toBeInTheDocument()
  })

  it("does not offer a reset when nothing has been resolved", () => {
    draw(agreement({ open: [nameRow] }))
    expect(screen.queryByTestId("character-check-reset")).not.toBeInTheDocument()
  })
})

describe("bulk, and the things that are not work", () => {
  const many = agreement({
    open: Array.from({ length: 6 }, (_, i) => ({
      cueCellId: `q${i}`,
      textCellId: `s${i}`,
      heard: `line ${i}`,
      camera: { subtitle: "off" as const, audio: "on" as const },
    })),
  })

  it("asks ARE YOU SURE before a whole-group decision, then does it", () => {
    // A call made HAVING LOOKED, not a policy applied at import — and a sweep
    // of eighty judgements deserves a second look before it lands, even
    // though every one stays flippable afterwards.
    const { onResolve } = draw(many)
    fireEvent.click(screen.getByTestId("character-check-bulk-audio"))
    expect(onResolve).not.toHaveBeenCalled()
    expect(screen.getByTestId("character-check-bulk-confirm")).toHaveTextContent("all 6 lines")
    fireEvent.click(screen.getByTestId("character-check-bulk-go"))
    const [choices] = onResolve.mock.calls[0]
    expect(choices).toHaveLength(6)
    expect(choices[0]).toMatchObject({ axis: "camera", side: "audio", value: "on", rejected: "off" })
  })

  it("lets the second look say no", () => {
    const { onResolve } = draw(many)
    fireEvent.click(screen.getByTestId("character-check-bulk-subtitle"))
    fireEvent.click(screen.getByText("Cancel"))
    expect(onResolve).not.toHaveBeenCalled()
    expect(screen.getByTestId("character-check-bulk-subtitle")).toBeInTheDocument()
  })

  it("names the columns once, stickily, in the import buttons' own words", () => {
    draw(many)
    const cols = screen.getByTestId("character-check-columns")
    expect(cols).toHaveTextContent("Subtitle")
    expect(cols).toHaveTextContent("Audio")
  })

  it("does not offer bulk for a handful", () => {
    draw(agreement({ open: [{ ...nameRow, camera: { subtitle: "off", audio: "on" } }] }))
    expect(screen.queryByTestId("character-check-bulk-audio")).not.toBeInTheDocument()
  })

  it("gives names no bulk button — each one is a real decision", () => {
    draw(
      agreement({
        open: Array.from({ length: 6 }, (_, i) => ({ ...nameRow, cueCellId: `q${i}`, textCellId: `s${i}` })),
      }),
    )
    expect(screen.queryByTestId("character-check-bulk-subtitle")).not.toBeInTheDocument()
  })

  it("COUNTS shared rows rather than offering them as work", () => {
    // One subtitle row covering several heard lines cannot have one right
    // answer, and the per-line display is already correct.
    draw(agreement({ sharedRows: 12 }))
    expect(screen.getByTestId("character-check-shared")).toHaveTextContent("12 pairings")
    expect(screen.queryByTestId("character-check-row")).not.toBeInTheDocument()
  })

  it("says the sheets agree when there is nothing open", () => {
    draw(agreement())
    expect(screen.getByTestId("character-check-clear")).toBeInTheDocument()
  })
})

describe("the card carries what the sheets agree on", () => {
  it("shows the agreed camera angle on a speaker dispute", () => {
    // Click the card, look at the film, see who the camera is on — a shortcut
    // for judging which name is right.
    draw(
      agreement({
        open: [{ ...nameRow, context: { camera: "on" as const } }],
      }),
    )
    expect(screen.getByTestId("character-check-context")).toHaveTextContent("on camera")
  })

  it("shows the agreed name on a camera dispute", () => {
    draw(
      agreement({
        open: [
          {
            cueCellId: "q1",
            textCellId: "s1",
            heard: "Go!",
            camera: { subtitle: "off" as const, audio: "on" as const },
            context: { name: "NICODEMUS" },
          },
        ],
      }),
    )
    expect(screen.getByTestId("character-check-context")).toHaveTextContent("NICODEMUS")
  })

  it("shows nothing when there is nothing agreed to show", () => {
    draw(agreement({ open: [nameRow] }))
    expect(screen.queryByTestId("character-check-context")).not.toBeInTheDocument()
  })
})

// ── Asking to see the vague camera answers (Sam, 2026-08-20) ────────────────
//
// `mixed` and `group` contradict nothing by default, which is what keeps six
// real findings on episode 101 from being buried under 189. Whoever knows the
// sheets can decide otherwise — so the switches have to be FINDABLE, including
// on a drawer that currently shows no camera work at all, since that is
// exactly the person who suspects something is being hidden.

describe("also flagging the vague camera answers", () => {
  it("says what ticking does, rather than what the values mean", () => {
    // Sam read the first wording ("Count as an answer", over two sentences of
    // justification) twice without learning what the checkbox would do.
    draw(agreement({ open: [cameraRow] }))
    expect(screen.getByText("Also flag")).toBeInTheDocument()
    expect(screen.getByText("Mixed against on or off")).toBeInTheDocument()
    expect(screen.getByText("Group against on or off")).toBeInTheDocument()
  })

  it("offers both switches, off", () => {
    draw(agreement({ open: [cameraRow] }))
    expect(screen.getByTestId("character-check-strict-mixed")).not.toBeChecked()
    expect(screen.getByTestId("character-check-strict-group")).not.toBeChecked()
  })

  it("is reachable even when nothing disagrees about the camera", () => {
    draw(agreement({ open: [nameRow] }))
    expect(screen.getByTestId("character-check-strictness")).toBeInTheDocument()
    expect(screen.getByTestId("character-check-cameras-clear")).toBeInTheDocument()
  })

  it("is reachable on a drawer with no open work at all", () => {
    draw(agreement())
    expect(screen.getByTestId("character-check-strict-group")).toBeInTheDocument()
  })

  it("reports a switch flipping without touching the other one", () => {
    const onStrictCameraChange = vi.fn()
    draw(agreement({ open: [cameraRow] }), { onStrictCameraChange })
    fireEvent.click(screen.getByTestId("character-check-strict-group"))
    expect(onStrictCameraChange).toHaveBeenCalledWith({ mixed: false, group: true })
  })

  it("shows a switch already on as on", () => {
    draw(agreement({ open: [cameraRow] }), { strictCamera: { mixed: true, group: false } })
    expect(screen.getByTestId("character-check-strict-mixed")).toBeChecked()
    expect(screen.getByTestId("character-check-strict-group")).not.toBeChecked()
  })

  it("goes inert with the rest of the drawer while a write is in flight", () => {
    // Same reason every other control freezes: the list is frozen upstream, so
    // changing what counts mid-write would reshuffle rows under the cursor.
    const onStrictCameraChange = vi.fn()
    draw(agreement({ open: [cameraRow] }), {
      onStrictCameraChange,
      pending: { done: 3, total: 150, phase: "writing" },
    })
    const box = screen.getByTestId("character-check-strict-mixed")
    expect(box).toHaveAttribute("data-disabled")
    fireEvent.click(box)
    expect(onStrictCameraChange).not.toHaveBeenCalled()
  })
})

describe("with only one sheet", () => {
  it("explains itself rather than being a disabled control", () => {
    draw(agreement(), { bothSheetsImported: false, agreement: null })
    expect(screen.getByTestId("character-check-one-sheet")).toHaveTextContent(
      "Both character sheets",
    )
    expect(screen.queryByTestId("character-check-row")).not.toBeInTheDocument()
  })
})

describe("the header", () => {
  it("counts what is left to check", () => {
    draw(agreement({ open: [nameRow] }))
    expect(screen.getByTestId("character-check-count")).toHaveTextContent("1 to check")
  })

  it("says so plainly when nothing is", () => {
    draw(agreement())
    expect(screen.getByTestId("character-check-count")).toHaveTextContent("nothing to check")
  })
})

// ── While a write is in flight ────────────────────────────────────────────
//
// A bulk resolve queues ~150 events one at a time. Clicking during it used to
// land on a different row than the one aimed at (the list reshuffles as rows
// migrate to Resolved) and, worse, a second handler could overwrite the
// first's decisions. The drawer going inert is the visible half of that fix.

describe("while a write is in flight", () => {
  const busy = { done: 42, total: 75, phase: "writing" as const }
  const drawBusy = (over: Record<string, unknown> = {}) =>
    draw(
      agreement({
        open: [{ ...nameRow, camera: { subtitle: "off" as const, audio: "on" as const } }],
        resolved: [
          {
            cueCellId: "q9",
            textCellId: "s9",
            heard: "Go!",
            name: { chose: "subtitle", current: "MARY", rejected: "EDEN" },
            at: 1,
          },
        ],
      }),
      { pending: busy, ...over },
    )

  it("counts up, so it does not read as hung", () => {
    drawBusy()
    expect(screen.getByTestId("character-check-pending")).toHaveTextContent("Saving… 42 of 75")
    // …and the idle count is out of the way while it runs.
    expect(screen.queryByTestId("character-check-count")).not.toBeInTheDocument()
  })

  it("names the network phase separately", () => {
    drawBusy({ pending: { done: 75, total: 75, phase: "syncing" as const } })
    expect(screen.getByTestId("character-check-pending")).toHaveTextContent("Syncing…")
  })

  it("disables every decision button", () => {
    drawBusy()
    for (const id of [
      "character-check-name-subtitle",
      "character-check-name-audio",
      "character-check-camera-subtitle",
      "character-check-camera-audio",
    ]) {
      expect(screen.getByTestId(id)).toBeDisabled()
    }
  })

  it("does not resolve when a disabled button is clicked", () => {
    const { onResolve } = drawBusy()
    fireEvent.click(screen.getByTestId("character-check-name-subtitle"))
    expect(onResolve).not.toHaveBeenCalled()
  })

  it("disables the reset too", () => {
    drawBusy()
    expect(screen.getByTestId("character-check-reset")).toBeDisabled()
  })

  it("stops a card from navigating — the list is frozen mid-write", () => {
    const { onNavigate } = drawBusy()
    fireEvent.click(screen.getByTestId("character-check-row"))
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it("still lets you close — nobody is trapped for ten seconds", () => {
    const onClose = vi.fn()
    draw(agreement({ open: [nameRow] }), { pending: busy, onClose })
    fireEvent.click(screen.getByLabelText("Close"))
    expect(onClose).toHaveBeenCalled()
  })

  it("behaves exactly as before when nothing is pending", () => {
    const { onResolve, onNavigate } = draw(agreement({ open: [nameRow] }))
    expect(screen.getByTestId("character-check-name-subtitle")).not.toBeDisabled()
    fireEvent.click(screen.getByTestId("character-check-name-subtitle"))
    expect(onResolve).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("character-check-row"))
    expect(onNavigate).toHaveBeenCalled()
  })
})
