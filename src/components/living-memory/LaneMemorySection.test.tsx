// src/components/living-memory/LaneMemorySection.test.tsx
//
// The Living Memory page's lane chrome (AQU-2348) — criteria #1, #2, #3 and #11
// at the level AGENTS.md puts single-surface UI: RTL, not a Playwright smoke.
//
// What is worth guarding here is the thing a reader cannot see from the markup:
// that the control tells the truth about WHOSE value is in force. A lane that
// inherits must not offer Revert (there is nothing to revert), a lane that owns
// a copy must say only that lane uses it, and below the edit floor neither
// action may be reachable while the lock still names the role.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import {
  LaneListNote,
  LaneOverrideControl,
  LivingMemoryLanePicker,
  type MemoryLaneOption,
} from "./LaneMemorySection"

const TWO_LANES: MemoryLaneOption[] = [
  { tag: "", label: "French" },
  { tag: "es", label: "Spanish" },
]

describe("LivingMemoryLanePicker", () => {
  it("renders nothing on a single-lane project", () => {
    // Criterion #1: the page must look exactly as it did. A picker with one
    // option is a control that cannot do anything.
    const { container } = render(
      <LivingMemoryLanePicker options={[{ tag: "", label: "French" }]} value="" onValueChange={() => {}} />,
    )
    expect(container.querySelector('[data-testid="living-memory-lane-scope"]')).toBeNull()
  })

  it("renders nothing when the project has no lanes at all", () => {
    const { container } = render(
      <LivingMemoryLanePicker options={[]} value="" onValueChange={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("shows the viewed lane and offers the others once there are two", () => {
    render(<LivingMemoryLanePicker options={TWO_LANES} value="es" onValueChange={() => {}} />)
    expect(screen.getByTestId("living-memory-lane-scope")).toBeTruthy()
    // The trigger names the lane in force, so the label is never ambiguous.
    expect(screen.getByLabelText(/Change language lane, currently Spanish/i)).toBeTruthy()
  })

  it("says the choice is shared with the editor only when it actually is", () => {
    // Promising a shared lane the workspace is not wiring would send a
    // maintainer back to the editor expecting a lane that did not change.
    const { unmount } = render(
      <LivingMemoryLanePicker options={TWO_LANES} value="" onValueChange={() => {}} sharedWithEditor />,
    )
    expect(screen.getByText(/Switching here switches the editor too/i)).toBeTruthy()
    unmount()

    render(<LivingMemoryLanePicker options={TWO_LANES} value="" onValueChange={() => {}} />)
    expect(screen.queryByText(/Switching here switches the editor too/i)).toBeNull()
  })
})

describe("LaneOverrideControl", () => {
  const base = {
    laneLabel: "Spanish",
    canEdit: true,
    reasonCannotEdit: null,
    onCustomize: () => {},
    onRevert: () => {},
  } as const

  it("reads as inherited, and offers only Customize, until the lane owns a copy", () => {
    render(<LaneOverrideControl {...base} customized={false} />)
    expect(screen.getByText("Inherited from project")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Customize for this language lane" })).toBeTruthy()
    // Nothing to revert — offering it would promise to restore a value that
    // was never replaced.
    expect(screen.queryByRole("button", { name: "Revert to project" })).toBeNull()
    expect(screen.getByTestId("lane-override-control").dataset.laneState).toBe("inherited")
  })

  it("names the owning lane, and offers only Revert, once customized", () => {
    render(<LaneOverrideControl {...base} customized />)
    expect(screen.getByText("Customized for Spanish")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Revert to project" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Customize for this language lane" })).toBeNull()
    expect(screen.getByTestId("lane-override-control").dataset.laneState).toBe("customized")
  })

  it("promises, while customized, that editing leaves the project and other lanes alone", () => {
    // Criterion #3 is the reassurance the control has to carry: without it a
    // maintainer cannot tell whether they are about to edit two audiences at once.
    render(<LaneOverrideControl {...base} customized />)
    expect(screen.getByText(/leaves the project and every other language lane unchanged/i)).toBeTruthy()
  })

  it("customizes on click", () => {
    const onCustomize = vi.fn()
    render(<LaneOverrideControl {...base} customized={false} onCustomize={onCustomize} />)
    fireEvent.click(screen.getByRole("button", { name: "Customize for this language lane" }))
    expect(onCustomize).toHaveBeenCalledTimes(1)
  })

  it("confirms before reverting, and discards nothing when the confirm is cancelled", () => {
    // Revert destroys the lane's copy. A single mis-click must not do that.
    const onRevert = vi.fn()
    render(<LaneOverrideControl {...base} customized onRevert={onRevert} />)

    fireEvent.click(screen.getByRole("button", { name: "Revert to project" }))
    expect(onRevert).not.toHaveBeenCalled()
    expect(screen.getByText(/Revert to the project's value\?/i)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(onRevert).not.toHaveBeenCalled()
  })

  it("reverts once confirmed", () => {
    const onRevert = vi.fn()
    render(<LaneOverrideControl {...base} customized onRevert={onRevert} />)
    fireEvent.click(screen.getByRole("button", { name: "Revert to project" }))
    // The dialog's own confirm, not the row's trigger.
    const confirms = screen.getAllByRole("button", { name: "Revert to project" })
    fireEvent.click(confirms[confirms.length - 1]!)
    expect(onRevert).toHaveBeenCalledTimes(1)
  })

  it("below the edit floor exposes NEITHER action and still shows the state", () => {
    // Criterion #11. A contributor may read which lane a section belongs to —
    // that is the point of the badge — but may not move it.
    render(<LaneOverrideControl {...base} canEdit={false} reasonCannotEdit="role" customized={false} />)
    expect(screen.getByText("Inherited from project")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Customize for this language lane" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Revert to project" })).toBeNull()
  })

  it("hides the actions while offline too, without claiming a role problem", () => {
    render(<LaneOverrideControl {...base} canEdit={false} reasonCannotEdit="offline" customized />)
    expect(screen.queryByRole("button", { name: "Revert to project" })).toBeNull()
  })
})

describe("LaneListNote", () => {
  it("says the project's items still apply here and new ones belong to this lane", () => {
    // Lists UNION rather than override, so the note must not borrow the
    // inherit/customize vocabulary: there is no copy and nothing to revert.
    render(<LaneListNote laneLabel="Spanish" />)
    const text = screen.getByTestId("lane-list-note").textContent ?? ""
    expect(text).toMatch(/apply in Spanish too/i)
    expect(text).toMatch(/belongs to Spanish alone/i)
    expect(text).not.toMatch(/inherited from project/i)
  })
})
