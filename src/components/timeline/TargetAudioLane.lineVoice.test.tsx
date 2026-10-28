// AQU-1758 / AQU-2212: what the Audio view's voice card did for a take, on
// its clip and its menu on the timeline.
import { afterEach, describe, it, expect, vi } from "vitest"
import { act, render, screen, fireEvent, within } from "@testing-library/react"
vi.mock("@/lib/audio/transport-pause", () => ({ pauseAllTransports: vi.fn() }))

import { TargetAudioLane, type TakeMenuActions } from "./TargetAudioLane"
import type { CellData } from "@/hooks/useCells"
import { __resetVoicingAsForTests, setVoicingAs } from "@/lib/audio/voicing-as"

const TAKE = "audio-c1-1700000000-take.wav"

const oneTake = () =>
  ({
    id: "c1", fileId: "f1", original: "", translated: "Hello",
    medium: "media", startTime: 10, endTime: 20,
    selectedAudioId: TAKE,
    attachments: {
      [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, label: "Take 1" },
    },
  }) as unknown as CellData

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

function menu(over: Partial<TakeMenuActions> = {}): TakeMenuActions {
  return { reRecord: vi.fn(), regenerate: vi.fn(), ...over }
}

function rightClick(testId: string) {
  const chip = screen.getByTestId(testId)
  fireEvent.pointerDown(chip, { button: 2, clientX: 80, pointerId: 1 })
  fireEvent.contextMenu(chip, { button: 2, clientX: 80 })
}

afterEach(() => __resetVoicingAsForTests())

describe("TargetAudioLane — the line's voice and its take (AQU-2212)", () => {
  it("puts Change to … first in the take's menu when they disagree, and runs it", async () => {
    const applyLineVoice = vi.fn()
    const lineVoice = vi.fn(() => ({ action: "change" as const, voiceName: "Hearth" }))
    render(<TargetAudioLane {...base} items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]} takeMenu={menu({ lineVoice, applyLineVoice })} />)
    rightClick("tl-target-c1")
    const content = await screen.findByTestId("tl-take-menu-c1")
    const first = within(content).getAllByRole("menuitem")[0]
    expect(first).toHaveAttribute("data-testid", "tl-take-menu-apply-voice")
    expect(first).toHaveTextContent("Change to Hearth")
    expect(lineVoice).toHaveBeenCalledWith("c1")
    fireEvent.click(first)
    expect(applyLineVoice).toHaveBeenCalledWith("c1")
  })

  it("says Generate · … when the voice can only read the text", async () => {
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        takeMenu={menu({ lineVoice: () => ({ action: "generate", voiceName: "John" }), applyLineVoice: vi.fn() })}
      />,
    )
    rightClick("tl-target-c1")
    expect(await screen.findByTestId("tl-take-menu-apply-voice")).toHaveTextContent("Generate · John")
  })

  it("offers nothing extra when the take is already in the line's voice", async () => {
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        takeMenu={menu({ lineVoice: () => null, applyLineVoice: vi.fn() })}
      />,
    )
    rightClick("tl-target-c1")
    await screen.findByTestId("tl-take-menu-rerecord")
    expect(screen.queryByTestId("tl-take-menu-apply-voice")).toBeNull()
  })

  it("says Voicing as … on the clip while the line is voiced, and nothing after", () => {
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        takeVoiceFor={() => ({ takeVoiceName: "Narrator", lineVoiceName: "Hearth" })}
      />,
    )
    expect(screen.queryByTestId("tl-target-c1-working")).toBeNull()
    act(() => setVoicingAs("c1", "Hearth"))
    expect(screen.getByTestId("tl-target-c1-working")).toHaveTextContent("Voicing as Hearth…")
    // It speaks in the take-voice label's place.
    expect(screen.queryByTestId("tl-target-c1-take-voice")).toBeNull()
    act(() => setVoicingAs("c1", null))
    expect(screen.queryByTestId("tl-target-c1-working")).toBeNull()
  })
})

describe("TargetAudioLane — make a character from this voice, in one step (AQU-1758, AQU-2212)", () => {
  it("clones this take at the clip: name it, Add to cast", async () => {
    const cloneTake = vi.fn(async () => {})
    const makeCharacter = vi.fn()
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        takeMenu={menu({ makeCharacter, cloneTake, cloneName: () => "ana" })}
      />,
    )
    rightClick("tl-target-c1")
    fireEvent.click(await screen.findByTestId("tl-take-menu-make-character"))
    const popover = await screen.findByTestId("voice-card-clone-popover")
    const name = within(popover).getByTestId("voice-card-clone-name") as HTMLInputElement
    expect(name.value).toBe("ana")
    fireEvent.change(name, { target: { value: "Ana" } })
    await act(async () => { fireEvent.click(within(popover).getByTestId("voice-card-clone-submit")) })
    expect(cloneTake).toHaveBeenCalledWith("c1", TAKE, "Ana")
    expect(makeCharacter).not.toHaveBeenCalled()
  })

  it("still offers the full dialog under More options", async () => {
    const makeCharacter = vi.fn()
    render(
      <TargetAudioLane
        {...base}
        items={[{ cell: oneTake(), kind: "take", audioId: TAKE }]}
        takeMenu={menu({ makeCharacter, cloneTake: vi.fn(async () => {}) })}
      />,
    )
    rightClick("tl-target-c1")
    fireEvent.click(await screen.findByTestId("tl-take-menu-make-character"))
    const popover = await screen.findByTestId("voice-card-clone-popover")
    fireEvent.click(within(popover).getByRole("button", { name: "More options" }))
    expect(makeCharacter).toHaveBeenCalledWith("c1")
  })
})
