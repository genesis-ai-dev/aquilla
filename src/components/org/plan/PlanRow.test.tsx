// AQU-2260 (Oct 29, third pass): the row's shortfall link says where it goes
// on hover ("Go to first unrecorded") — the hover NAMES what the click does,
// which a hover may do (Sam asked for it, 2026-09-17).
import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"
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
  it("names where it goes on hover, and in its accessible name", async () => {
    renderWithTooltips(
      <PlanBoard units={[unit()]} now={NOW} projectId="p1" selectedId={null} onSelect={vi.fn()} onOpenShortfall={vi.fn()} />,
    )
    const link = screen.getByTestId("plan-shortfall-f1-")
    expect(link).toHaveAttribute("aria-label", "4 takes to record · Go to first unrecorded")
    await expectTooltip(link, "Go to first unrecorded")
  })
})
