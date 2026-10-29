// AQU-2260 (Sam, Oct 29): the row's shortfall link is labelled ("4 takes to
// record"), so it says nothing on hover. Where it goes is still in its
// accessible name, and the click itself goes there.
import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderWithTooltips } from "@/test-utils/tooltip"
import type { PlanUnit } from "@/lib/plan/plan-status"
import { PlanBoard } from "./PlanBoard"

const NOW = Date.parse("2026-09-02T09:00:00Z")

function unit(over: Partial<PlanUnit> = {}): PlanUnit {
  return {
    fileId: "f1", fileName: "Mark", sectionKey: "",
    totalCount: 100, filledCount: 100, validatedCount: 100,
    audioCount: 96, audioValidatedCount: 96, lastEditAt: null,
    targetDate: null, doneAt: null, doneBy: null,
    ...over,
  } as PlanUnit
}

describe("PlanRow shortfall link", () => {
  it("shows nothing on hover, and keeps its destination in its name", async () => {
    renderWithTooltips(
      <PlanBoard units={[unit()]} now={NOW} projectId="p1" selectedId={null} onSelect={vi.fn()} onOpenShortfall={vi.fn()} />,
    )
    const link = screen.getByTestId("plan-shortfall-f1-")
    expect(link).toHaveAttribute("aria-label", "4 takes to record · Go to first unrecorded")
    await userEvent.setup().hover(link)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole("tooltip")).toBeNull()
  })
})
