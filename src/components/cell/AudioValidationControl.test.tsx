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
  // Sam, 2026-09-23: a line with nothing recorded draws a FADED mic that
  // does nothing, so the gutter column is full on every row. (Replaces the
  // empty slot of 2026-09-21.) Not a button: no tab stop, no click.
  it("draws a faded, unclickable mic on a line with no recording", () => {
    draw([])
    expect(button()).toBeNull()
    const faded = screen.getByTestId("audio-validation-unavailable")
    expect(faded.tagName).toBe("SPAN")
    expect(faded).toHaveAccessibleName(/no audio to validate/i)
    expect(faded.className).toContain("opacity-40")
    expect(faded.querySelector("svg")).not.toBeNull()
  })

  it("draws nothing inline for a line with no recording", () => {
    draw([], { variant: "inline" })
    expect(button()).toBeNull()
    expect(screen.queryByTestId("audio-validation-gutter")).toBeNull()
  })

  // Sam, 2026-09-21: on a second account, a line somebody else had already
  // validated looked exactly like one nobody had touched. The text control
  // fills its circle for that state; this one only stepped the grey, which is
  // invisible at 14px. The mic's capsule now fills the same way — and only the
  // capsule, because lucide's mic stand is an open path that fills as a blob.
  it("fills the mic's capsule when someone else has validated but I have not", () => {
    draw([take({ audioId: "a", validatorCount: 1, validators: ["bo"] })], { validationRequirement: 2 })
    const icon = button()!.querySelector("svg")!
    expect(icon.getAttribute("class")).toContain("[&_rect]:fill-current")
    // The stand must NOT be filled — that is the difference between a filled
    // mic and a solid blob.
    expect(icon.getAttribute("class")).not.toContain("fill-current path")
    expect(icon.querySelector("rect")).not.toBeNull()
  })

  it("leaves the mic hollow when nobody has validated", () => {
    draw([take({ audioId: "a" })], { validationRequirement: 2 })
    expect(button()!.querySelector("svg")!.getAttribute("class")).not.toContain("fill-current")
  })

  // Once the viewer has voted the icon is a CHECK, not a mic, so the fill
  // would have nothing to act on — and must not be asked to.
  it("does not fill once I have validated", () => {
    draw([take({ audioId: "a", validatorCount: 1, validators: ["ana"] })], { validationRequirement: 2 })
    expect(button()!.querySelector("svg")!.getAttribute("class")).not.toContain("fill-current")
  })

  it("shows no fraction on an ordinary one-take line", () => {
    draw([take({ audioId: "a", validatorCount: 1, validators: ["ana"] })])
    expect(button()).not.toBeNull()
    expect(fraction()).toBeNull()
  })

  // Sam, 2026-09-22: THE FRACTION IS YOUR PROGRESS ACROSS THE TRACKS. It used
  // to count takes that had reached the threshold, so at a threshold of two it
  // sat at "0/2" beside a single check on a line you had fully signed off. It
  // counts the takes carrying YOUR vote now, and shows only while a track
  // still needs you.
  it("counts the takes I have signed off while another still needs me", () => {
    draw([
      take({ audioId: "a", validatorCount: 1, validators: ["ana"] }),
      take({ audioId: "b", slot: "track-2" }),
    ])
    expect(fraction()).toHaveTextContent("1/2")
  })

  // The reported case: threshold two, both tracks carrying my vote, neither
  // finished. The icon (a single check) already says "yours, waiting on
  // others"; a "0/2" beside it read as if nothing had happened.
  it("drops the fraction once I have done every track, even below the threshold", () => {
    draw([
      take({ audioId: "a", validatorCount: 1, validators: ["ana"] }),
      take({ audioId: "b", slot: "track-2", validatorCount: 1, validators: ["ana"] }),
    ], { validationRequirement: 2 })
    expect(fraction()).toBeNull()
  })

  it("drops the fraction once every track is validated", () => {
    draw([
      take({ audioId: "a", validatorCount: 1, validators: ["ana"] }),
      take({ audioId: "b", slot: "track-2", validatorCount: 1, validators: ["ana"] }),
    ])
    expect(fraction()).toBeNull()
  })

  // Somebody else has done one track and nobody the other: I have done
  // neither, and the number says so honestly.
  it("reads 0/2 when the votes on the line are all somebody else's", () => {
    draw([
      take({ audioId: "a", validatorCount: 1, validators: ["bo"] }),
      take({ audioId: "b", slot: "track-2" }),
    ], { validationRequirement: 2 })
    expect(fraction()).toHaveTextContent("0/2")
  })

  // Found in the browser at a threshold of two: the button announced
  // "Audio validated" on a line whose icon was still a single check. The
  // label and the picture have to agree.
  it("says how many more are needed when the viewer has validated but the line has not", () => {
    draw([take({ audioId: "a", validatorCount: 1, validators: ["ana"] })], { validationRequirement: 3 })
    expect(button()).toHaveAccessibleName(/you have validated.*GEN 1:1.*2 more validators needed/i)
  })

  it("says plainly validated once the threshold is met", () => {
    draw([take({ audioId: "a", validatorCount: 2, validators: ["ana", "bo"] })], { validationRequirement: 2 })
    expect(button()).toHaveAccessibleName(/^Audio validated/i)
  })

  it("names its state for a screen reader, with the line's reference", () => {
    draw([
      take({ audioId: "a", validatorCount: 1, validators: ["ana"] }),
      take({ audioId: "b", slot: "track-2" }),
    ])
    expect(button()).toHaveAccessibleName(/you have validated 1 of 2 takes.*GEN 1:1/i)
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
    expect(button()).toHaveAccessibleName(/Audio validated/i)
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

// ---------------------------------------------------------------------------
// What an adversarial review found (2026-09-22)
// ---------------------------------------------------------------------------

describe("the picture and the words agree in every state", () => {
  // The icon answers "how validated is this LINE"; the label used to answer
  // "what have I done", a different question. So a line two other people had
  // finished drew a green double check and announced "not validated".
  it("a line others have fully validated reads as validated, not as untouched", () => {
    draw([take({ audioId: "a", validatorCount: 2, validators: ["bo", "cy"] })], { validationRequirement: 2 })
    expect(button()).toHaveAccessibleName(/^Audio validated/i)
  })

  it("a line one other person has validated says so, rather than nothing", () => {
    draw([take({ audioId: "a", validatorCount: 1, validators: ["bo"] })], { validationRequirement: 2 })
    expect(button()).toHaveAccessibleName(/someone else has validated/i)
  })

  // I have given every vote I am allowed to give; one take is blocked for me.
  // The old label fell through to "not validated — click to validate" and
  // pointed a screen reader at a button with nothing left to do.
  it("states the line is unvalidated but does not invite a click it cannot honour", () => {
    draw([
      take({ audioId: "a", validatorCount: 1, validators: ["ana"] }),
      take({ audioId: "b", slot: "track-2", canValidate: false, blockedReason: "You recorded this" }),
    ], { validationRequirement: 2 })
    // The line IS unvalidated — that much is true and worth saying. What must
    // not appear is "Click to validate" over a button with nothing to give.
    expect(button()).toHaveAccessibleName(/not validated/i)
    expect(button()).not.toHaveAccessibleName(/click to validate/i)
  })
})

describe("the optimistic vote retires when the server answers", () => {
  // THE BUG: the guess was never deleted, only ignored while the server
  // disagreed. Validate here, withdraw somewhere else, and the moment the
  // server came back to where it started the guess re-armed and painted the
  // vote back on — permanently, until the row recycled.
  it("does not resurrect a vote that was withdrawn from another surface", async () => {
    const onValidationChange = vi.fn().mockResolvedValue(undefined)
    const takes = [take({ audioId: "a" })]
    const { rerender } = render(
      <I18nProvider>
        <AudioValidationControl cellRef="GEN 1:1" takes={takes} currentUsername="ana"
          validationRequirement={1} canValidate onValidationChange={onValidationChange} />
      </I18nProvider>,
    )
    await userEvent.click(button()!)
    expect(button()).toHaveAccessibleName(/Audio validated/i)

    const withMine = [take({ audioId: "a", validatorCount: 1, validators: ["ana"] })]
    const draw2 = (list: AudioValidationTake[]) => rerender(
      <I18nProvider>
        <AudioValidationControl cellRef="GEN 1:1" takes={list} currentUsername="ana"
          validationRequirement={1} canValidate onValidationChange={onValidationChange} />
      </I18nProvider>,
    )
    // the server confirms my vote…
    draw2(withMine)
    expect(button()).toHaveAccessibleName(/Audio validated/i)
    // …then somewhere else I withdraw it, and the server says so.
    draw2([take({ audioId: "a" })])
    expect(button()).toHaveAccessibleName(/not validated/i)
  })
})
