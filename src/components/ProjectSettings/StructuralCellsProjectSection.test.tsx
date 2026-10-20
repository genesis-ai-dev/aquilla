// AQU-1912 (Sam, 2026-10-19): a locked "Count headings" (and its sibling,
// "copy translations to repeated rows") has ONE hover — why it is locked,
// with the organization's answer under it — not two stacked tooltips.
import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { renderWithTooltips } from "@/test-utils/tooltip"
import { StructuralCellsProjectSection } from "./StructuralCellsProjectSection"
import { RepetitionPropagationProjectSection } from "./RepetitionPropagationProjectSection"

const onPatch = vi.fn(async () => ({ kind: "ok" }))
const LOCK = "Only Project leads can modify"

async function hoverTooltips(trigger: Element): Promise<string[]> {
  await userEvent.setup().hover(trigger)
  await waitFor(() => expect(screen.getAllByRole("tooltip").length).toBeGreaterThan(0))
  return screen.getAllByRole("tooltip").map((el) => el.textContent ?? "")
}

describe("StructuralCellsProjectSection", () => {
  it("locked: one hover saying why, with the organization's answer under it", async () => {
    renderWithTooltips(
      <StructuralCellsProjectSection value={undefined} orgDefault disabled disabledTooltip={LOCK} onPatch={onPatch} />,
    )
    const tips = await hoverTooltips(document.getElementById("count-structural-cells")!.parentElement!)
    expect(tips).toHaveLength(1)
    expect(tips[0]).toContain(LOCK)
    expect(tips[0]).toContain("The organization currently counts them")
  })

  it("unlocked: the hover is the organization's answer alone", async () => {
    renderWithTooltips(
      <StructuralCellsProjectSection value={undefined} orgDefault={false} onPatch={onPatch} />,
    )
    const tips = await hoverTooltips(document.getElementById("count-structural-cells")!.parentElement!)
    expect(tips).toEqual([expect.stringContaining("The organization currently leaves them out")])
    expect(tips[0]).not.toContain(LOCK)
  })
})

describe("RepetitionPropagationProjectSection", () => {
  it("locked: one hover saying why, with the organization's answer under it", async () => {
    renderWithTooltips(
      <RepetitionPropagationProjectSection value={undefined} orgDefault={false} disabled disabledTooltip={LOCK} onPatch={onPatch} />,
    )
    const tips = await hoverTooltips(document.getElementById("auto-propagate-repetitions")!.parentElement!)
    expect(tips).toHaveLength(1)
    expect(tips[0]).toContain(LOCK)
  })
})
