// AQU-490: the audio validation control.
//
// Its job is one sentence — "how validated is this line's recording, and what
// can I do about it?" — and almost every test here is about the multi-track
// case, because that is where audio stops behaving like text. A line's takes
// all sound at once, so the line is only as validated as its weakest track.
import { describe, it, expect, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import {
  AudioValidationControl,
  type AudioValidationTake,
} from "./AudioValidationControl"
import { lineState, takeState } from "./audio-validation-state"

const take = (over: Partial<AudioValidationTake> & { audioId: string }): AudioValidationTake => ({
  label: null,
  slot: "recording",
  validatorCount: 0,
  validators: [],
  isGenerated: false,
  canValidate: true,
  ...over,
})

function draw(
  takes: AudioValidationTake[],
  over: Partial<React.ComponentProps<typeof AudioValidationControl>> = {},
) {
  const onValidationChange = vi.fn().mockResolvedValue(undefined)
  render(
    <I18nProvider>
      <AudioValidationControl
        cellRef="GEN 1:1"
        takes={takes}
        currentUsername="ana"
        validationRequirement={1}
        canValidate
        onValidationChange={onValidationChange}
        {...over}
      />
    </I18nProvider>,
  )
  return { onValidationChange }
}

const button = () => screen.queryByTestId("audio-validation-button")
const fraction = () => screen.queryByTestId("audio-validation-fraction")

// ── The arithmetic, on its own ────────────────────────────────────────────

describe("takeState / lineState", () => {
  it("reads one take the way the text control reads a cell", () => {
    expect(takeState(take({ audioId: "a" }), "ana", 1)).toBe("none")
    expect(takeState(take({ audioId: "a", validatorCount: 1, validators: ["bo"] }), "ana", 2)).toBe("others")
    expect(takeState(take({ audioId: "a", validatorCount: 1, validators: ["ana"] }), "ana", 2)).toBe("self")
    expect(takeState(take({ audioId: "a", validatorCount: 2, validators: ["ana", "bo"] }), "ana", 2)).toBe("full")
  })

  // THE RULE. Not the maximum — a line whose second track nobody has heard is
  // not a validated line, however thoroughly the first was signed off.
  it("takes the WEAKEST track, not the strongest", () => {
    const strong = take({ audioId: "a", validatorCount: 5, validators: ["ana", "bo"] })
    const weak = take({ audioId: "b", slot: "track-2", validatorCount: 0, validators: [] })
    expect(lineState([strong, weak], "ana", 1)).toBe("none")
    expect(lineState([strong], "ana", 1)).toBe("full")
  })

  it("calls a line with no takes empty, which is not the same as unvalidated", () => {
    expect(lineState([], "ana", 1)).toBe("empty")
  })

  // A blank viewer — signed out, or not yet resolved — must not match the
  // empty string a legacy validator row could carry.
  it("never treats a blank username as a validator", () => {
    expect(takeState(take({ audioId: "a", validatorCount: 1, validators: [""] }), "", 2)).toBe("others")
  })
})

// ── What the line draws ───────────────────────────────────────────────────

describe("the readout", () => {
  // Same rule as text: a cell with nothing to validate has no control. (A
  // placeholder mic was tried on 2026-09-21 and rejected.)
  it("draws nothing at all on a line with no recording", () => {
    draw([])
    expect(button()).toBeNull()
    expect(screen.queryByTestId("audio-validation-empty")).toBeNull()
    // The gutter slot survives so the column keeps its width.
    expect(screen.getByTestId("audio-validation-gutter")).toBeEmptyDOMElement()
  })

  it("draws nothing inline for a line with no recording", () => {
    draw([], { variant: "inline" })
    expect(button()).toBeNull()
    expect(screen.queryByTestId("audio-validation-gutter")).toBeNull()
  })

  it("shows no fraction on an ordinary one-take line", () => {
    draw([take({ audioId: "a", validatorCount: 1, validators: ["ana"] })])
    expect(button()).not.toBeNull()
    expect(fraction()).toBeNull()
  })

  // Sam's ruling: the fraction counts TAKES, appears only when there is more
  // than one, and collapses again at full — where the double check already
  // says everything a "2/2" would.
  it("shows a take fraction only while a multi-track line is unfinished", () => {
    draw([
      take({ audioId: "a", validatorCount: 1, validators: ["ana"] }),
      take({ audioId: "b", slot: "track-2" }),
    ])
    expect(fraction()).toHaveTextContent("1/2")
  })

  it("drops the fraction once every track is validated", () => {
    draw([
      take({ audioId: "a", validatorCount: 1, validators: ["ana"] }),
      take({ audioId: "b", slot: "track-2", validatorCount: 1, validators: ["ana"] }),
    ])
    expect(fraction()).toBeNull()
  })

  // Found in the browser at a threshold of two: the button announced
  // "Recording validated" on a line whose icon was still a single check. The
  // label and the picture have to agree.
  it("says how many more are needed when the viewer has validated but the line has not", () => {
    draw([take({ audioId: "a", validatorCount: 1, validators: ["ana"] })], { validationRequirement: 3 })
    expect(button()).toHaveAccessibleName(/you have validated.*GEN 1:1.*2 more validators needed/i)
  })

  it("says plainly validated once the threshold is met", () => {
    draw([take({ audioId: "a", validatorCount: 2, validators: ["ana", "bo"] })], { validationRequirement: 2 })
    expect(button()).toHaveAccessibleName(/^Recording validated/i)
  })

  it("names its state for a screen reader, with the line's reference", () => {
    draw([
      take({ audioId: "a", validatorCount: 1, validators: ["ana"] }),
      take({ audioId: "b", slot: "track-2" }),
    ])
    expect(button()).toHaveAccessibleName(/1 of 2 takes validated.*GEN 1:1/i)
  })
})

// ── Voting ────────────────────────────────────────────────────────────────

describe("casting a vote", () => {
  it("validates the take on a plain one-take line", async () => {
    const { onValidationChange } = draw([take({ audioId: "a" })])
    await userEvent.click(button()!)
    expect(onValidationChange).toHaveBeenCalledExactlyOnceWith("a", true)
  })

  // One gesture for the line, because every take on it belongs to this line
  // alone. (A DUBBING row, where heard lines are shared between cells, does
  // not get this — that surface passes canValidate false and sends the user
  // to the Recording tab instead.)
  it("gives every track still missing my vote, in one click", async () => {
    const { onValidationChange } = draw([
      take({ audioId: "a", validatorCount: 1, validators: ["ana"] }),
      take({ audioId: "b", slot: "track-2" }),
      take({ audioId: "c", slot: "track-3" }),
    ])
    await userEvent.click(button()!)
    expect(onValidationChange).toHaveBeenCalledTimes(2)
    expect(onValidationChange).toHaveBeenCalledWith("b", true)
    expect(onValidationChange).toHaveBeenCalledWith("c", true)
    expect(onValidationChange).not.toHaveBeenCalledWith("a", true)
  })

  it("skips a take the viewer may not vote on", async () => {
    const { onValidationChange } = draw([
      take({ audioId: "a" }),
      take({ audioId: "b", slot: "track-2", canValidate: false, blockedReason: "You recorded this" }),
    ])
    await userEvent.click(button()!)
    expect(onValidationChange).toHaveBeenCalledExactlyOnceWith("a", true)
  })

  // The optimistic vote shows immediately and is NOT rolled back while the
  // server is still catching up — the whole point of carrying the
  // authoritative value from the moment we asked.
  it("shows my vote before the server has confirmed it", async () => {
    draw([take({ audioId: "a" })])
    await userEvent.click(button()!)
    expect(button()).toHaveAccessibleName(/Recording validated/i)
  })

  it("rolls the vote back when the write is refused", async () => {
    const onValidationChange = vi.fn().mockResolvedValue(false)
    render(
      <I18nProvider>
        <AudioValidationControl
          cellRef="GEN 1:1"
          takes={[take({ audioId: "a" })]}
          currentUsername="ana"
          validationRequirement={1}
          canValidate
          onValidationChange={onValidationChange}
        />
      </I18nProvider>,
    )
    await userEvent.click(button()!)
    expect(button()).toHaveAccessibleName(/not validated/i)
  })
})

// ── The popover ───────────────────────────────────────────────────────────

describe("the validator list", () => {
  it("lists each track with its own validators once there is nothing left to give", async () => {
    draw([
      take({ audioId: "a", label: "Take 2", validatorCount: 1, validators: ["ana"] }),
      take({ audioId: "b", slot: "track-2", label: "Narration", validatorCount: 1, validators: ["bo"] }),
    ], { currentUsername: "ana", validationRequirement: 1 })
    // ana has validated 'a'; 'b' already meets the threshold via bo, but ana
    // has not voted on it, so a click would still give it — open by hover.
    await userEvent.hover(button()!)
    const list = await screen.findByRole("dialog")
    expect(within(list).getByText("Take 2")).toBeInTheDocument()
    expect(within(list).getByText("Narration")).toBeInTheDocument()
    expect(within(list).getByText(/bo/)).toBeInTheDocument()
  })

  it("lets me withdraw my own vote from the list", async () => {
    const { onValidationChange } = draw([
      take({ audioId: "a", validatorCount: 1, validators: ["ana"] }),
    ])
    await userEvent.click(button()!)
    // Scoped to the popover: AppTooltip mirrors the control's own label into a
    // portal, so an unscoped query matches two buttons.
    const list = await screen.findByRole("dialog")
    await userEvent.click(within(list).getByRole("button", { name: /remove your validation/i }))
    expect(onValidationChange).toHaveBeenCalledExactlyOnceWith("a", false)
  })

  it("says plainly when nobody has validated a take", async () => {
    draw([take({ audioId: "a", canValidate: false, blockedReason: "You recorded this" })])
    await userEvent.hover(button()!)
    expect(await screen.findByText(/nobody has validated this take/i)).toBeInTheDocument()
  })
})
