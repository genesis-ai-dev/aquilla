// AQU-1767 (Sam, 2026-10-14): a take's right-click menu.
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
vi.mock("@/lib/audio/transport-pause", () => ({ pauseAllTransports: vi.fn() }))

import { TargetAudioLane, type ChangeVoiceMenuState, type TakeMenuActions } from "./TargetAudioLane"
import type { CellData } from "@/hooks/useCells"
import { renderWithTooltips } from "@/test-utils/tooltip"

const SOURCE_ID = "audio-f1-1690000000-shared.mp3"
const TAKE = "audio-c1-1700000000-take.wav"
const PIECE = "audio-c1-1700000500-piece.wav"

function cell(attachments: Record<string, object>): CellData {
  return {
    id: "c1", fileId: "f1", original: "", translated: "",
    medium: "media", startTime: 10, endTime: 20,
    selectedAudioId: TAKE,
    attachments: {
      ...attachments,
      [SOURCE_ID]: { type: "audio", url: "frontier-audio://src", slot: "recording", role: "source" },
    },
  } as unknown as CellData
}

const oneTake = () =>
  cell({ [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, label: "Take 1" } })

const base = {
  validationRequirementAudio: 1,
  pxPerSec: 40,
  viewStartSec: 0,
  viewEndSec: 100,
  selectedId: null,
  editable: true,
  snapEnabled: false,
  onSelect: () => {},
}

/** AQU-2026: a Change voice state with nothing in the way, overridable. */
function changeVoiceState(over: Partial<ChangeVoiceMenuState> = {}): ChangeVoiceMenuState {
  return {
    voiceName: "Narrator",
    blocker: null,
    ...over,
  }
}

function menuActions(over: Partial<TakeMenuActions> = {}): Required<TakeMenuActions> {
  return {
    reRecord: vi.fn(),
    regenerate: vi.fn(),
    changeVoice: vi.fn(),
    changeVoiceState: vi.fn(() => changeVoiceState()),
    rename: vi.fn(),
    remove: vi.fn(),
    vote: vi.fn(),
    voteState: vi.fn(() => ({ canVote: true, voted: false })),
    ...over,
  } as Required<TakeMenuActions>
}

/** Right-click the chip at `clientX` (happy-dom lays it at x = 0, so x is the offset in). */
function rightClick(testId: string, clientX: number) {
  const chip = screen.getByTestId(testId)
  fireEvent.pointerDown(chip, { button: 2, clientX, pointerId: 1 })
  fireEvent.contextMenu(chip, { button: 2, clientX })
}

describe("TargetAudioLane — a take's right-click menu (AQU-1767)", () => {
  it("offers split, re-record, regenerate, approve, rename and delete", async () => {
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        onCutTarget={vi.fn()}
        takeMenu={menuActions()}
      />,
    )
    rightClick("tl-target-c1", 80)
    for (const id of ["split", "rerecord", "regenerate", "vote", "rename", "delete"]) {
      expect(await screen.findByTestId(`tl-take-menu-${id}`), id).toBeInTheDocument()
    }
    expect(screen.getByTestId("tl-take-menu-split").textContent).toBe("Split here")
    expect(screen.getByTestId("tl-take-menu-vote").textContent).toContain("Approve this take")
    expect(screen.getByTestId("tl-take-menu-delete").textContent).toContain("Delete take")
  })

  it("splits where it was right-clicked, in the take's own ms", async () => {
    const onCutTarget = vi.fn()
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        onCutTarget={onCutTarget}
        takeMenu={menuActions()}
      />,
    )
    // 80px at 40px/s = 2s into a take that starts at 10s.
    rightClick("tl-target-c1", 80)
    fireEvent.click(await screen.findByTestId("tl-take-menu-split"))
    expect(onCutTarget).toHaveBeenCalledTimes(1)
    const [cellId, audioId, atMs] = onCutTarget.mock.calls[0]
    expect([cellId, audioId]).toEqual(["c1", TAKE])
    expect(atMs).toBeCloseTo(2000)
  })

  it("cannot split right at the edge", async () => {
    const onCutTarget = vi.fn()
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        onCutTarget={onCutTarget}
        takeMenu={menuActions()}
      />,
    )
    rightClick("tl-target-c1", 2)
    const split = await screen.findByTestId("tl-take-menu-split")
    expect(split.getAttribute("aria-disabled") === "true" || split.hasAttribute("data-disabled")).toBe(true)
    fireEvent.click(split)
    expect(onCutTarget).not.toHaveBeenCalled()
  })

  it("hands each action this take", async () => {
    const actions = menuActions()
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        onCutTarget={vi.fn()}
        takeMenu={actions}
      />,
    )
    const pick = async (id: string) => {
      rightClick("tl-target-c1", 80)
      fireEvent.click(await screen.findByTestId(`tl-take-menu-${id}`))
    }
    await pick("rerecord")
    expect(actions.reRecord).toHaveBeenCalledWith("c1")
    await pick("regenerate")
    expect(actions.regenerate).toHaveBeenCalledWith("c1")
    await pick("vote")
    expect(actions.vote).toHaveBeenCalledWith("c1", TAKE, true)
    await pick("rename")
    expect(actions.rename).toHaveBeenCalledWith("c1", TAKE, "Take 1")
    await pick("delete")
    expect(actions.remove).toHaveBeenCalledWith("c1", TAKE)
  })

  it("offers to withdraw your approval once you have given it, and nothing to someone who may not vote", async () => {
    const voted = menuActions({ voteState: vi.fn(() => ({ canVote: true, voted: true })) })
    const { unmount } = render(
      <TargetAudioLane {...base} items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]} onCutTarget={vi.fn()} takeMenu={voted} />,
    )
    rightClick("tl-target-c1", 80)
    const item = await screen.findByTestId("tl-take-menu-vote")
    expect(item.textContent).toContain("Remove my approval")
    fireEvent.click(item)
    expect(voted.vote).toHaveBeenCalledWith("c1", TAKE, false)
    unmount()

    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        onCutTarget={vi.fn()}
        takeMenu={menuActions({ voteState: vi.fn(() => ({ canVote: false, voted: false })) })}
      />,
    )
    rightClick("tl-target-c1", 80)
    await screen.findByTestId("tl-take-menu-rename")
    expect(screen.queryByTestId("tl-take-menu-vote")).toBeNull()
  })

  it("names a cut take's part a piece", async () => {
    const c = cell({
      [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, trimEndMs: 2000, label: "Take 1 · 1" },
      [PIECE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, trimStartMs: 2000, pieceOf: TAKE, label: "Take 1 · 4" },
    })
    const actions = menuActions()
    render(
      <TargetAudioLane
        {...base}
        items={[
          { cell: c, kind: "take", audioId: TAKE, pieceIndex: 0, pieceCount: 2 },
          { cell: c, kind: "take", audioId: PIECE, pieceIndex: 1, pieceCount: 2 },
        ]}
        onCutTarget={vi.fn()}
        takeMenu={actions}
      />,
    )
    rightClick("tl-target-c1-p2", 20)
    expect((await screen.findByTestId("tl-take-menu-delete")).textContent).toContain("Delete this piece")
    // Sam, 2026-10-15: a piece is approved and renamed with its whole take.
    expect(screen.getByTestId("tl-take-menu-vote").textContent).toContain("Approve this take")
    fireEvent.click(screen.getByTestId("tl-take-menu-rename"))
    expect(actions.rename).toHaveBeenCalledWith("c1", PIECE, "Take 1")
  })

  it("opens nothing on a timeline you cannot edit", () => {
    render(
      <TargetAudioLane
        {...base}
        editable={false}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        onCutTarget={vi.fn()}
        takeMenu={menuActions()}
      />,
    )
    rightClick("tl-target-c1", 80)
    expect(screen.queryByTestId("tl-take-menu-split")).toBeNull()
  })
})

/**
 * AQU-2026: Change voice for one line, from the take menu. The Audio tab's
 * voice card is the only other home for it and a time-ordered (Media) file
 * draws no voice cards, so these are the rules the Media surface has.
 */
describe("TargetAudioLane — per-line Change voice (AQU-2026)", () => {
  const lane = (actions: Required<TakeMenuActions>) => (
    <TargetAudioLane
      {...base}
      items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
      onCutTarget={vi.fn()}
      takeMenu={actions}
    />
  )

  it("converts this line in one click — no quality submenu (AQU-2291)", async () => {
    const actions = menuActions()
    render(lane(actions))
    rightClick("tl-target-c1", 80)
    const item = await screen.findByTestId("tl-take-menu-change-voice")
    expect(item.textContent).toContain("Change voice")
    fireEvent.click(item)
    expect(actions.changeVoice).toHaveBeenCalledWith("c1")
    expect(actions.changeVoiceState).toHaveBeenCalledWith("c1")
  })

  it("says nothing on a line whose only sound is the film's own audio", async () => {
    render(lane(menuActions({ changeVoiceState: vi.fn(() => null) })))
    rightClick("tl-target-c1", 80)
    // The rest of the menu is there; Change voice simply is not.
    await screen.findByTestId("tl-take-menu-regenerate")
    expect(screen.queryByTestId("tl-take-menu-change-voice")).toBeNull()
  })

  it.each([
    ["not-trained" as const, "Narrator has no trained voice model yet — Change voice works with character, trained and ElevenLabs voices."],
    ["up-to-date" as const, "This take is already in Narrator's voice"],
    ["busy" as const, "Change voice"],
  ])("greys the item and gives the reason when it cannot run (%s)", async (blocker, reason) => {
    const actions = menuActions({ changeVoiceState: vi.fn(() => changeVoiceState({ blocker })) })
    render(lane(actions))
    rightClick("tl-target-c1", 80)
    const item = await screen.findByTestId("tl-take-menu-change-voice")
    expect(item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled")).toBe(true)
    expect(item.textContent).toContain(reason)
    fireEvent.click(item)
    expect(actions.changeVoice).not.toHaveBeenCalled()
  })

  it("offers nothing on a timeline you cannot edit", () => {
    render(
      <TargetAudioLane
        {...base}
        editable={false}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        onCutTarget={vi.fn()}
        takeMenu={menuActions()}
      />,
    )
    rightClick("tl-target-c1", 80)
    expect(screen.queryByTestId("tl-take-menu-change-voice")).toBeNull()
  })
})

// Sam's decision: a hidden line is not recorded onto from its take.
describe("TargetAudioLane — a hidden line's take menu", () => {
  it("offers no re-record", async () => {
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: { ...oneTake(), hidden: true } as CellData, kind: "take", audioId: TAKE }]}
        takeMenu={menuActions()}
      />,
    )
    rightClick("tl-target-c1", 80)
    expect(await screen.findByTestId("tl-take-menu-rename")).toBeInTheDocument()
    expect(screen.queryByTestId("tl-take-menu-rerecord")).toBeNull()
  })
})

// AQU-1758: the Audio view's voice card turned a take into a character, and
// named a take's voice when it was not the line's. The timeline does both now.
const GEN = "audio-c1-1700000900-gen.wav"
const generatedTake = () =>
  cell({ [GEN]: { type: "audio", url: "frontier-audio://gen", slot: "generatedVoice", durationMs: 4000, voiceId: "v-narrator" } })

describe("TargetAudioLane — train a voice from a take (AQU-1758, AQU-2291)", () => {
  it("offers it on a person's take, and hands over the take's line and audio", async () => {
    const trainFromTake = vi.fn()
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        takeMenu={menuActions({ trainFromTake })}
      />,
    )
    rightClick("tl-target-c1", 80)
    const item = await screen.findByTestId("tl-take-menu-train-voice")
    expect(item.textContent).toBe("Train a voice from this recording")
    fireEvent.click(item)
    expect(trainFromTake).toHaveBeenCalledWith("c1", TAKE)
  })

  it("leaves it out on a generated take, and for someone who may not make voices", async () => {
    const { unmount } = render(
      <TargetAudioLane
        {...base}
        items={[{ cell: generatedTake(), kind: "generated", audioId: GEN }]}
        takeMenu={menuActions({ trainFromTake: vi.fn() })}
      />,
    )
    rightClick("tl-target-c1", 80)
    await screen.findByTestId("tl-take-menu-regenerate")
    expect(screen.queryByTestId("tl-take-menu-train-voice")).toBeNull()
    unmount()
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        takeMenu={menuActions()}
      />,
    )
    rightClick("tl-target-c1", 80)
    await screen.findByTestId("tl-take-menu-rerecord")
    expect(screen.queryByTestId("tl-take-menu-train-voice")).toBeNull()
  })
})

describe("TargetAudioLane — a take's voice on its clip (AQU-1758)", () => {
  it("names the take's voice when it is not the line's, with the reason in its right-click details (AQU-2260)", async () => {
    renderWithTooltips(
      <TargetAudioLane
        {...base}
        items={[{ cell: generatedTake(), kind: "generated", audioId: GEN }]}
        takeVoiceFor={() => ({ takeVoiceName: "Narrator", lineVoiceName: "Naomi" })}
      />,
    )
    expect(screen.getByTestId("tl-target-c1-take-voice")).toHaveTextContent("Narrator")
    // AQU-2260: hovering the clip shows nothing; the sentence is at the top
    // of its right-click menu, among the take's details.
    await userEvent.setup().hover(screen.getByTestId("tl-target-c1"))
    expect(screen.queryByRole("tooltip")).toBeNull()
    fireEvent.contextMenu(screen.getByTestId("tl-target-c1"), { button: 2 })
    expect((await screen.findByTestId("tl-take-details-c1")).textContent)
      .toContain("This take was voiced by Narrator. The line’s voice is now Naomi.")
  })

  it("says the voice was removed when it is no longer in the project", () => {
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: generatedTake(), kind: "generated", audioId: GEN }]}
        takeVoiceFor={() => ({ takeVoiceName: null, lineVoiceName: "Naomi" })}
      />,
    )
    expect(screen.getByTestId("tl-target-c1-take-voice")).toHaveTextContent("Removed voice")
  })

  it("names nothing when the take's voice is the line's", () => {
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: generatedTake(), kind: "generated", audioId: GEN }]}
        takeVoiceFor={() => null}
      />,
    )
    expect(screen.queryByTestId("tl-target-c1-take-voice")).toBeNull()
  })
})

// AQU-1758 (Sam, decision 4): a ⋯ in the take's top-right corner, on hover,
// opens the same menu as a right-click.
describe("TargetAudioLane — a take's ⋯ (AQU-1758)", () => {
  it("opens the take's menu, the same items as a right-click", async () => {
    const trainFromTake = vi.fn()
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        onCutTarget={vi.fn()}
        onOpenRecording={vi.fn()}
        takeMenu={menuActions({ trainFromTake })}
      />,
    )
    const more = screen.getByTestId("tl-target-c1-more")
    expect(more).toHaveAttribute("aria-label", "More actions")
    // To the right of the record button: the mic makes room for it.
    expect(screen.getByTestId("tl-target-c1-record").className).toContain("right-[1.625rem]")
    fireEvent.click(more)
    for (const id of ["split", "rerecord", "regenerate", "train-voice", "vote", "rename", "delete"]) {
      expect(await screen.findByTestId(`tl-take-menu-${id}`), id).toBeInTheDocument()
    }
    fireEvent.click(screen.getByTestId("tl-take-menu-train-voice"))
    expect(trainFromTake).toHaveBeenCalledWith("c1", TAKE)
  })

  it("splits at the playhead from there, when the playhead is on the take", async () => {
    const onCutTarget = vi.fn()
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        onCutTarget={onCutTarget}
        takeMenu={menuActions()}
        getPlayheadSec={() => 11.5}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-target-c1-more"))
    const split = await screen.findByTestId("tl-take-menu-split")
    expect(split.textContent).toBe("Split at the playhead")
    fireEvent.click(split)
    const [cellId, audioId, atMs] = onCutTarget.mock.calls[0]
    expect([cellId, audioId]).toEqual(["c1", TAKE])
    expect(atMs).toBeCloseTo(1500)
  })

  it("cannot split from there when the playhead is off the take", async () => {
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        onCutTarget={vi.fn()}
        takeMenu={menuActions()}
        getPlayheadSec={() => 40}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-target-c1-more"))
    expect(await screen.findByTestId("tl-take-menu-split")).toHaveAttribute("data-disabled")
  })

  it("gives a narrow take the same button", () => {
    const narrow = cell({ [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 300 } })
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: narrow, kind: "take", audioId: TAKE }]}
        onOpenRecording={vi.fn()}
        takeMenu={menuActions()}
      />,
    )
    // 0.3 s at 40 px/s is 12 px: no room for the mic, the ⋯ is still there.
    expect(screen.queryByTestId("tl-target-c1-record")).toBeNull()
    expect(screen.getByTestId("tl-target-c1-more").className).toContain("h-4 w-4")
  })

  it("is not there for someone who cannot change the take", () => {
    render(
      <TargetAudioLane
        {...base}
        editable={false}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        takeMenu={menuActions()}
      />,
    )
    expect(screen.queryByTestId("tl-target-c1-more")).toBeNull()
  })
})

// AQU-1758 (Sam's decision 3): following the recordings, a gap someone
// dragged open between two pieces of a take is deliberate silence. It is
// drawn as nothing at all — plain timeline (Sam, Oct 28) — but it still
// counts in the line's length and plays as silence.
describe("TargetAudioLane — the silence inside a split take (AQU-1758)", () => {
  it("draws nothing in the gap between two pieces, and the line keeps it", async () => {
    const SPLIT_TAKE = "audio-c1-1700000000-take.wav"
    const SPLIT_PIECE = "audio-c1-1700000500-piece.wav"
    const c = {
      id: "c1", fileId: "f1", original: "", translated: "", medium: "text",
      selectedAudioId: SPLIT_TAKE,
      attachments: {
        [SPLIT_TAKE]: { type: "audio", url: "frontier-audio://t", slot: "recording", durationMs: 4000, trimStartMs: 200, trimEndMs: 1500 },
        [SPLIT_PIECE]: { type: "audio", url: "frontier-audio://t", slot: "recording", pieceOf: SPLIT_TAKE, durationMs: 4000, trimStartMs: 2500, trimEndMs: 3700,
          // Moved 0.7 s along from the end of the first piece.
          targetOffsetMs: 700 },
      },
    } as unknown as CellData
    const { buildTimelineLayout } = await import("@/lib/timeline/layout")
    const layout = buildTimelineLayout("audioFirst", [c], [c], null, { standInLenSec: () => 2 })
    renderWithTooltips(
      <TargetAudioLane
        {...base}
        layout={layout}
        items={[
          { cell: c, kind: "take", audioId: SPLIT_TAKE, pieceIndex: 0, pieceCount: 2 },
          { cell: c, kind: "take", audioId: SPLIT_PIECE, pieceIndex: 1, pieceCount: 2 },
        ]}
      />,
    )
    // No band, no words.
    expect(screen.queryByTestId(`tl-target-gap-${SPLIT_PIECE}`)).toBeNull()
    expect(screen.queryByRole("img", { name: /pause/i })).toBeNull()
    // The silence is still the line's: 1.3 s, then 0.7 s of nothing, then the
    // 1.2 s piece — 3.2 s in all, the second piece starting at 2.0 s (80 px).
    expect(layout.programme?.byCellId.get("c1")?.slotLenSec).toBeCloseTo(3.2, 5)
    expect(screen.getByTestId("tl-target-c1-p2").style.left).toBe("80px")
  })
})
