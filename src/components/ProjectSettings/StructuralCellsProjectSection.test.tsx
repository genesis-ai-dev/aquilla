// AQU-2260 (Sam, Oct 29): no hovers on these rows. The organization's answer
// is a short line under the menu, always there; locked, why sits beneath it as
// one more line — and says nothing when the card above already said it.
// (AQU-1912 had made it one hover instead of two stacked ones.)
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SettingsGroup } from "@/components/ui/page"
import { StructuralCellsProjectSection } from "./StructuralCellsProjectSection"
import { RepetitionPropagationProjectSection } from "./RepetitionPropagationProjectSection"

const onPatch = vi.fn(async () => ({ kind: "ok" as const }))
const LOCK = "Only Project leads can change this."

describe("StructuralCellsProjectSection", () => {
  it("locked: why, and the organization's answer, both on the page, with no hover", async () => {
    render(
      <StructuralCellsProjectSection value={undefined} orgDefault disabled disabledTooltip={LOCK} onPatch={onPatch} />,
    )
    expect(screen.getByText(LOCK)).toBeVisible()
    expect(screen.getByText("The organization currently counts them")).not.toHaveClass("sr-only")
    await userEvent.setup().hover(document.getElementById("count-structural-cells")!)
    expect(screen.queryByRole("tooltip")).toBeNull()
  })

  it("unlocked: the organization's answer under the menu, and no lock line", () => {
    render(<StructuralCellsProjectSection value={undefined} orgDefault={false} onPatch={onPatch} />)
    expect(screen.getByText("The organization currently leaves them out")).not.toHaveClass("sr-only")
    expect(screen.queryByText(LOCK)).toBeNull()
  })

  it("says nothing of its own inside a card whose heading already gives the same reason", () => {
    render(
      <SettingsGroup label="Text" locked={LOCK}>
        <StructuralCellsProjectSection value={undefined} orgDefault disabled disabledTooltip={LOCK} onPatch={onPatch} />
      </SettingsGroup>,
    )
    expect(screen.getAllByText(LOCK)).toHaveLength(1)
    expect(screen.getByTestId("settings-group-locked")).toHaveTextContent(LOCK)
  })
})

describe("RepetitionPropagationProjectSection", () => {
  it("locked: why, and the organization's answer, both on the page, with no hover", async () => {
    render(
      <RepetitionPropagationProjectSection value={undefined} orgDefault={false} disabled disabledTooltip={LOCK} onPatch={onPatch} />,
    )
    expect(screen.getByText(LOCK)).toBeVisible()
    expect(screen.getByText("The organization currently leaves them alone")).not.toHaveClass("sr-only")
    await userEvent.setup().hover(document.getElementById("auto-propagate-repetitions")!)
    expect(screen.queryByRole("tooltip")).toBeNull()
  })
})
