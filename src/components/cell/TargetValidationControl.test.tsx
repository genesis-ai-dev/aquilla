import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import userEvent from "@testing-library/user-event"

import { TargetValidationControl } from "./TargetValidationControl"
import { fmtShortCalendarDate } from "@/lib/format-date"
import { STALL_WATCHDOG_MS } from "@/test-utils/timeouts"
import { expectClickNote, expectDisabledNote } from "@/test-utils/tooltip"

function renderControl(activeValidators: string[], onValidationChange = vi.fn()) {
  return render(
    <TargetValidationControl
      cellRef="Mark 1:1"
      hasContent
      validationStatus={activeValidators.includes("alice") ? "full-self" : "none"}
      activeValidators={activeValidators}
      validationHistory={[]}
      currentUsername="alice"
      validationRequirement={1}
      canValidate
      canValidateThisCell
      onValidationChange={onValidationChange}
    />,
  )
}

describe("TargetValidationControl", () => {
  it("does not reactivate a completed optimistic unvalidation after a later validation", async () => {
    const onValidationChange = vi.fn()
    const { rerender } = renderControl(["alice"], onValidationChange)

    fireEvent.click(screen.getByRole("button", { name: /Validated/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Remove your validation" }))
    expect(screen.getByRole("button", { name: /Not validated/ })).toHaveAttribute("aria-pressed", "false")

    rerender(
      <TargetValidationControl
        cellRef="Mark 1:1"
        hasContent
        validationStatus="none"
        activeValidators={[]}
        validationHistory={[]}
        currentUsername="alice"
        validationRequirement={1}
        canValidate
        canValidateThisCell
        onValidationChange={onValidationChange}
      />,
    )
    rerender(
      <TargetValidationControl
        cellRef="Mark 1:1"
        hasContent
        validationStatus="full-self"
        activeValidators={["alice"]}
        validationHistory={[]}
        currentUsername="alice"
        validationRequirement={1}
        canValidate
        canValidateThisCell
        onValidationChange={onValidationChange}
      />,
    )

    expect(screen.getByRole("button", { name: /Validated/ })).toHaveAttribute("aria-pressed", "true")
  })

  // Sam, 2026-09-23: a line with no text draws a FADED circle that does
  // nothing, instead of an empty slot, so the gutter is full on every row.
  // AQU-2260 (Oct 29): why it is faded opens on a click, never a hover.
  it("draws a faded circle when there is no text, which says why on a click and casts nothing", async () => {
    const onValidationChange = vi.fn()
    render(
      <TargetValidationControl
        cellRef="Mark 1:1"
        hasContent={false}
        validationStatus="none"
        activeValidators={[]}
        validationHistory={[]}
        currentUsername="alice"
        validationRequirement={1}
        canValidate
        canValidateThisCell
        onValidationChange={onValidationChange}
      />,
    )
    expect(document.querySelector('[data-showcase="cell.validation"]')).toBeNull()
    const faded = screen.getByTestId("validation-unavailable")
    expect(faded).toHaveAccessibleName(/no text to validate/i)
    await expectClickNote(faded, "No text to validate")
    expect(onValidationChange).not.toHaveBeenCalled()
  })

  // Sam, 2026-09-23: the same hover rule as audio. The tooltip names which
  // half it is about, and a why-not survives somebody else voting first.
  it("names the text half in its tooltip", async () => {
    render(
      <TargetValidationControl
        cellRef="Mark 1:1" hasContent validationStatus="none" activeValidators={[]}
        validationHistory={[]} currentUsername="alice" validationRequirement={1}
        canValidate canValidateThisCell onValidationChange={vi.fn()}
      />,
    )
    fireEvent.mouseEnter(screen.getByRole("button"))
    fireEvent.pointerEnter(screen.getByRole("button"))
    fireEvent.focus(screen.getByRole("button"))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Text not validated — click to validate")
  })

  it("puts the why-not at the foot of the Validated by list", async () => {
    render(
      <TargetValidationControl
        cellRef="Mark 1:1" hasContent validationStatus="others" activeValidators={["bo"]}
        validationHistory={[]} currentUsername="alice" validationRequirement={2}
        canValidate canValidateThisCell={false} onValidationChange={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button"))
    expect(await screen.findByText("Text validated by")).toBeInTheDocument()
    expect(screen.getByTestId("validation-blocked-note")).toHaveTextContent("Outside your assigned files or language lanes")
  })

  // AQU-1571: the project's own text rules, mirrored so a vote the server is
  // about to refuse is never sent — and the reader is told why.
  describe("when the project's text rules refuse the vote", () => {
    it("says the reader made the latest change, and a click sends nothing", async () => {
      const onValidationChange = vi.fn()
      render(
        <TargetValidationControl
          cellRef="Mark 1:1" hasContent validationStatus="none" activeValidators={[]}
          validationHistory={[]} currentUsername="alice" validationRequirement={1}
          canValidate canValidateThisCell={false} blockedReason="self"
          onValidationChange={onValidationChange}
        />,
      )
      expect(screen.getByRole("button")).toHaveAttribute("aria-disabled", "true")
      // AQU-2260 (Oct 29): on a click, never a hover.
      await expectDisabledNote(
        screen.getByRole("button"),
        "You made the latest change to this text, so someone else must validate it",
      )
      expect(onValidationChange).not.toHaveBeenCalled()
    })

    it("puts the same sentence under somebody else's vote", async () => {
      const onValidationChange = vi.fn()
      render(
        <TargetValidationControl
          cellRef="Mark 1:1" hasContent validationStatus="others" activeValidators={["bo"]}
          validationHistory={[]} currentUsername="alice" validationRequirement={2}
          canValidate canValidateThisCell={false} blockedReason="self"
          onValidationChange={onValidationChange}
        />,
      )
      fireEvent.click(screen.getByRole("button"))
      expect(await screen.findByText("Text validated by")).toBeInTheDocument()
      expect(screen.getByTestId("validation-blocked-note")).toHaveTextContent(
        "You made the latest change to this text, so someone else must validate it",
      )
      expect(onValidationChange).not.toHaveBeenCalled()
    })

    // The named-validator list is deliberately not named, as audio does not.
    it("reads as unavailable when the minimum role or validator list excludes the reader", async () => {
      render(
        <TargetValidationControl
          cellRef="Mark 1:1" hasContent validationStatus="none" activeValidators={[]}
          validationHistory={[]} currentUsername="alice" validationRequirement={1}
          canValidate canValidateThisCell={false} blockedReason="policy" onValidationChange={vi.fn()}
        />,
      )
      await expectDisabledNote(screen.getByRole("button"), "Text validation unavailable")
    })

    // The server never gates taking your own vote back.
    it("still offers to remove a vote the reader cast before the rule applied", async () => {
      const onValidationChange = vi.fn()
      render(
        <TargetValidationControl
          cellRef="Mark 1:1" hasContent validationStatus="full-self" activeValidators={["alice"]}
          validationHistory={[]} currentUsername="alice" validationRequirement={1}
          canValidate canValidateThisCell={false} blockedReason="self"
          onValidationChange={onValidationChange}
        />,
      )
      fireEvent.click(screen.getByRole("button", { name: /Validated/ }))
      expect(screen.queryByTestId("validation-blocked-note")).not.toBeInTheDocument()
      fireEvent.click(await screen.findByRole("button", { name: "Remove your validation" }))
      expect(onValidationChange).toHaveBeenCalledWith(false)
    })
  })

  // PR 1 browser pass, 2026-10-02: after hover opened the "Text validated by"
  // list, a click on the check closed it. Base UI reads a click that comes
  // more than 500 ms after a hover open as "close". A click now pins it.
  describe("the Text validated by list", () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    // AQU-2260 (Oct 29, third pass): the list never opens on hover. Where a
    // press is the vote, an (i) beside the check opens it on click.
    it("never opens on hover; where a press validates, an (i) beside the check opens it", async () => {
      const onValidationChange = vi.fn()
      render(
        <TargetValidationControl
          cellRef="Mark 1:1" hasContent validationStatus="others" activeValidators={["bo"]}
          validationHistory={[]} currentUsername="alice" validationRequirement={2}
          canValidate canValidateThisCell onValidationChange={onValidationChange}
        />,
      )
      const check = screen.getAllByRole("button")[0]!
      fireEvent.pointerEnter(check, { pointerType: "mouse" })
      fireEvent.mouseEnter(check)
      fireEvent.mouseMove(check, { movementX: 5, movementY: 5 })
      await wait(600)
      expect(screen.queryByText("Text validated by")).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "About Text validated by" }))
      expect(await screen.findByText("Text validated by")).toBeInTheDocument()
      expect(screen.getByText("bo")).toBeInTheDocument()
      expect(onValidationChange).not.toHaveBeenCalled()
    })

    it("closes from a second click on its (i)", async () => {
      render(
        <TargetValidationControl
          cellRef="Mark 1:1" hasContent validationStatus="others" activeValidators={["bo"]}
          validationHistory={[]} currentUsername="alice" validationRequirement={2}
          canValidate canValidateThisCell onValidationChange={vi.fn()}
        />,
      )
      const info = screen.getByRole("button", { name: "About Text validated by" })
      await userEvent.click(info)
      expect(await screen.findByText("Text validated by")).toBeInTheDocument()
      await userEvent.click(info)
      await vi.waitFor(() => expect(screen.queryByText("Text validated by")).not.toBeInTheDocument(), { timeout: STALL_WATCHDOG_MS })
    })

    // Walk 10-02: the check still announced "Click to remove your validation"
    // after a press stopped removing anything. It names what a press does now.
    it("names your own validation for what a press does: open the list, not remove the vote", () => {
      const onValidationChange = vi.fn()
      const { rerender } = render(
        <TargetValidationControl
          cellRef="row 4" hasContent validationStatus="self" activeValidators={["alice"]}
          validationHistory={[]} currentUsername="alice" validationRequirement={2}
          canValidate canValidateThisCell onValidationChange={onValidationChange}
        />,
      )
      const button = screen.getByRole("button", {
        name: "Validated by you, row 4. Click to see the list, where you can remove your validation.",
      })
      fireEvent.click(button)
      expect(onValidationChange).not.toHaveBeenCalled()
      expect(screen.getByRole("button", { name: "Remove your validation" })).toBeInTheDocument()

      // Without the right to validate here, there is no Remove button to point at.
      rerender(
        <TargetValidationControl
          cellRef="row 4" hasContent validationStatus="self" activeValidators={["alice"]}
          validationHistory={[]} currentUsername="alice" validationRequirement={2}
          canValidate={false} canValidateThisCell={false} onValidationChange={onValidationChange}
        />,
      )
      expect(screen.getByRole("button", { name: "Validated by you, row 4." })).toBeInTheDocument()
    })

    it("stays open after a click opens it, and after the pointer leaves", async () => {
      render(
        <TargetValidationControl
          cellRef="Mark 1:1" hasContent validationStatus="full-self" activeValidators={["alice", "bo"]}
          validationHistory={[]} currentUsername="alice" validationRequirement={2}
          canValidate canValidateThisCell onValidationChange={vi.fn()}
        />,
      )
      const button = screen.getByRole("button", { name: /Validated/ })
      // AQU-2260: a click opens it (hover opens nothing).
      fireEvent.pointerDown(button, { pointerType: "mouse" })
      fireEvent.click(button)
      expect(await screen.findByText("Text validated by")).toBeInTheDocument()
      await wait(650)
      expect(screen.getByText("Text validated by")).toBeInTheDocument()

      fireEvent.mouseLeave(button, { relatedTarget: document.body })
      await wait(300)
      expect(screen.getByText("Text validated by")).toBeInTheDocument()

      // A click outside shuts it (Escape too, from inside the list).
      fireEvent.pointerDown(document.body, { pointerType: "mouse" })
      fireEvent.click(document.body)
      await vi.waitFor(() => expect(screen.queryByText("Text validated by")).not.toBeInTheDocument(), { timeout: STALL_WATCHDOG_MS })

      // Closed lists open again on the next click.
      fireEvent.pointerDown(button, { pointerType: "mouse" })
      fireEvent.click(button)
      expect(await screen.findByText("Text validated by")).toBeInTheDocument()
    })

    it("closes after Remove your validation", async () => {
      const onValidationChange = vi.fn()
      render(
        <TargetValidationControl
          cellRef="Mark 1:1" hasContent validationStatus="full-self" activeValidators={["alice", "bo"]}
          validationHistory={[]} currentUsername="alice" validationRequirement={2}
          canValidate canValidateThisCell onValidationChange={onValidationChange}
        />,
      )
      fireEvent.click(screen.getByRole("button", { name: /Validated/ }))
      fireEvent.click(await screen.findByRole("button", { name: "Remove your validation" }))
      expect(onValidationChange).toHaveBeenCalledWith(false)
      await vi.waitFor(() => expect(screen.queryByText("Text validated by")).not.toBeInTheDocument(), { timeout: STALL_WATCHDOG_MS })
    })

    // PR 1 area 5 step 6 (Sam, 2026-10-03): open the list with a click, remove
    // your vote, and the check never opened the list again (by hover, then). The
    // trash button closed the list behind Base UI's back, so Base UI still
    // remembered the CLICK that opened it, and it ignores hover while a list
    // it thinks a click opened is around. Closing through Base UI clears that.
    it("opens again from its (i) after Remove your validation closed a click-opened list", async () => {
      const onValidationChange = vi.fn()
      const props = {
        cellRef: "Mark 1:1", hasContent: true, validationHistory: [], currentUsername: "alice",
        validationRequirement: 2, canValidate: true, canValidateThisCell: true, onValidationChange,
      }
      const { rerender } = render(
        <TargetValidationControl {...props} validationStatus="full-self" activeValidators={["alice", "bo"]} />,
      )
      const button = screen.getByRole("button", { name: /Validated/ })
      fireEvent.pointerDown(button, { pointerType: "mouse" })
      fireEvent.click(button)
      fireEvent.click(await screen.findByRole("button", { name: "Remove your validation" }))
      expect(onValidationChange).toHaveBeenCalledWith(false)
      // The server agrees: only bo's vote is left, so there is still a list to show.
      rerender(<TargetValidationControl {...props} validationStatus="others" activeValidators={["bo"]} />)
      await vi.waitFor(() => expect(screen.queryByText("Text validated by")).not.toBeInTheDocument(), { timeout: STALL_WATCHDOG_MS })

      // AQU-2260: a press on the check now votes again, so the list is on
      // the (i) under it, on click — never on hover.
      const check = screen.getByRole("button", { name: /Validated by others/ })
      fireEvent.mouseLeave(check, { relatedTarget: document.body })
      await wait(150)
      fireEvent.click(screen.getByRole("button", { name: "About Text validated by" }))
      expect(await screen.findByText("Text validated by")).toBeInTheDocument()
      expect(screen.getByText("bo")).toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// AQU-2296: the date under each validator's name.
//
// The two lists sit side by side on the same line and are meant to be read
// together, so the date line is the SAME component in both (ValidatedOnLine)
// and the parity of their spacing is locked in AudioValidationControl.test.tsx.
// ---------------------------------------------------------------------------

describe("the date under each validator", () => {
  const drawDated = (
    activeValidators: string[],
    validatorDecidedTs: Record<string, number>,
    over: Partial<React.ComponentProps<typeof TargetValidationControl>> = {},
  ) => render(
    <TargetValidationControl
      cellRef="Mark 1:1"
      hasContent
      validationStatus={activeValidators.includes("alice") ? "full-self" : "others"}
      activeValidators={activeValidators}
      validatorDecidedTs={validatorDecidedTs}
      validationHistory={[]}
      currentUsername="alice"
      validationRequirement={1}
      canValidate
      canValidateThisCell
      onValidationChange={vi.fn()}
      {...over}
    />,
  )

  const rowFor = async (name: string) => {
    const list = await screen.findByRole("dialog")
    return within(list).getByText(new RegExp(`^${name}`)).closest("li")!
  }

  it("dates each name from that person's own vote, and leaves an unknown one bare", async () => {
    const bobVoted = Date.now() - 3 * 24 * 60 * 60 * 1000
    // A viewer who cannot vote HERE, so the press opens the list instead of
    // casting a vote.
    drawDated(["bob", "cy"], { bob: bobVoted }, { canValidateThisCell: false })
    fireEvent.click(screen.getByRole("button", { name: /Validated by others/ }))

    // Bob's own `decided_ts`, formatted the way every other date in the editor
    // is — NOT today, and not the cell's last-edit time.
    expect(await rowFor("bob")).toHaveTextContent(fmtShortCalendarDate(bobVoted))
    // Cy has no stamp (a pre-AQU-2296 worker, or a row the read left out): the
    // name stands alone rather than carrying a blank line or "Invalid Date".
    expect((await rowFor("cy")).textContent).toBe("cy")
  })

  it("dates my own row from the click, before the server has answered", async () => {
    // The acceptance criterion the optimistic path exists for: validating must
    // not leave your name sitting there undated until the read lands.
    drawDated(["bob"], { bob: Date.now() - 86_400_000 })
    // The first press is the VOTE (the list stays shut); the second opens it.
    fireEvent.click(screen.getByRole("button", { name: /Validated by others/ }))
    fireEvent.click(screen.getByRole("button", { name: /Validated by you/ }))
    const row = await rowFor("alice")
    expect(row).toHaveTextContent("(you)")
    expect(row).toHaveTextContent(fmtShortCalendarDate(Date.now()))
  })
})
