import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { PlanInspector } from "./PlanInspector"
import type { PlanUnit } from "@/lib/plan/plan-status"

// Every test below used to pass getToken={null}, which short-circuits
// usePlanUnitSections before it fetches — so the whole AQU-1098 breakdown (the
// hook, the chapter labels, the chapters-vs-sections heading, the per-chapter
// bars) rendered in no test at all. Mocking the progress read exercises it.
vi.mock("@/lib/progress/file-progress-resource", () => ({
  getFileProgress: vi.fn(),
}))
const { getFileProgress } = await import("@/lib/progress/file-progress-resource")

const NOW = Date.parse("2026-09-02T09:00:00Z")

const section = (key: string, over: Record<string, number> = {}) => ({
  key, totalCount: 40, filledCount: 40, validatedCount: 10,
  validationLevels: [10], audioCount: 0, audioValidatedCount: 0, ...over,
})

beforeEach(() => {
  vi.mocked(getFileProgress).mockReset()
})

function unit(over: Partial<PlanUnit> = {}): PlanUnit {
  return {
    fileId: "f1", fileName: "Mark", sectionKey: "",
    totalCount: 100, filledCount: 72, validatedCount: 31,
    audioCount: 0, audioValidatedCount: 0, lastEditAt: null,
    targetDate: null, doneAt: null, doneBy: null,
    ...over,
  } as PlanUnit
}

function renderInspector(u: PlanUnit, canPlan = true, showAudio = false, getToken: (() => Promise<string | null>) | null = null) {
  const onPatch = vi.fn().mockResolvedValue(true)
  const onClose = vi.fn()
  const onStep = vi.fn()
  render(
    <PlanInspector unit={u} now={NOW} canPlan={canPlan} showAudio={showAudio}
      projectId="p1" getToken={getToken} lane="" languageLabel="Tok Pisin"
      onPatch={onPatch} onClose={onClose} onStep={onStep} />,
  )
  return { onPatch, onClose, onStep }
}

const withSections = (sections: ReturnType<typeof section>[]) => {
  vi.mocked(getFileProgress).mockResolvedValue({
    fileId: "f1", revision: 1, validationCount: 1,
    file: section(""), sections,
  } as never)
  return async () => "tok"
}

describe("access adapts the content", () => {
  it("gives a maintainer the date control and the Done button", () => {
    renderInspector(unit())
    expect(screen.getByTestId("plan-mark-done")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-target-readonly")).toBeNull()
  })

  it("gives a contributor the values but no controls", () => {
    // Absent, not disabled — the same rule the cell-editing floor settled on.
    renderInspector(unit({ targetDate: "2026-11-01" }), false)
    expect(screen.queryByTestId("plan-mark-done")).toBeNull()
    expect(screen.queryByTestId("plan-target-clear")).toBeNull()
    expect(screen.getByTestId("plan-target-readonly")).toHaveTextContent("November 1")
    expect(screen.getByText(/Only maintainers can set target dates/)).toBeInTheDocument()
  })

  it("still shows a contributor who marked a unit done, and when", () => {
    renderInspector(unit({ doneAt: new Date(2026, 7, 20, 12).getTime(), doneBy: "randall" }), false)
    expect(screen.getByTestId("plan-done-provenance")).toHaveTextContent("Marked done August 20 by randall")
    expect(screen.queryByTestId("plan-unmark-done")).toBeNull()
  })
})

describe("marking done", () => {
  it("acknowledges rather than blocks when validated is under 100", async () => {
    // Done is a judgment the percentages cannot make, so the nudge informs and
    // gets out of the way.
    const { onPatch } = renderInspector(unit({ validatedCount: 31 }))
    fireEvent.click(screen.getByTestId("plan-mark-done"))
    expect(screen.getByTestId("plan-done-nudge")).toHaveTextContent("31%")
    expect(onPatch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("plan-mark-done-anyway"))
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith({ fileId: "f1", sectionKey: "", done: true }),
    )
  })

  it("marks a fully validated unit done without a detour", async () => {
    const { onPatch } = renderInspector(unit({ validatedCount: 100 }))
    fireEvent.click(screen.getByTestId("plan-mark-done"))
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ fileId: "f1", sectionKey: "", done: true }))
    expect(screen.queryByTestId("plan-done-nudge")).toBeNull()
  })

  it("lets the nudge be cancelled", () => {
    const { onPatch } = renderInspector(unit())
    fireEvent.click(screen.getByTestId("plan-mark-done"))
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(screen.queryByTestId("plan-done-nudge")).toBeNull()
    expect(onPatch).not.toHaveBeenCalled()
  })

  it("reverses a mark", async () => {
    const { onPatch } = renderInspector(unit({ doneAt: NOW, doneBy: "randall" }))
    fireEvent.click(screen.getByTestId("plan-unmark-done"))
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ fileId: "f1", sectionKey: "", done: false }))
  })

  it("shows a Done unit's bars beside the mark, mismatch and all", () => {
    // The point of an explicit mark: Done at 31% validated is visible, not
    // hidden, so a reader can judge it.
    renderInspector(unit({ doneAt: NOW, doneBy: "randall", validatedCount: 31 }))
    expect(screen.getByTestId("plan-done-provenance")).toBeInTheDocument()
    expect(screen.getByTestId("plan-inspector-bars").querySelector('[aria-label^="Text"]'))
      .toHaveAttribute("aria-label", "Text 72% translated, 31% validated")
  })
})

describe("target date", () => {
  it("offers to clear a date that is set", async () => {
    const { onPatch } = renderInspector(unit({ targetDate: "2026-11-01" }))
    fireEvent.click(screen.getByTestId("plan-target-clear"))
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith({ fileId: "f1", sectionKey: "", targetDate: null }),
    )
  })

  it("offers no clear button when there is nothing to clear", () => {
    renderInspector(unit())
    expect(screen.queryByTestId("plan-target-clear")).toBeNull()
  })
})

describe("progress and navigation", () => {
  it("hides audio bars on a text-only project", () => {
    renderInspector(unit(), true, false)
    const bars = screen.getByTestId("plan-inspector-bars")
    expect(bars.querySelector('[aria-label^="Audio"]')).toBeNull()
    expect(bars.querySelector('[aria-label^="Text"]')).toHaveAttribute(
      "aria-label", "Text 72% translated, 31% validated",
    )
  })

  it("shows audio bars where audio exists", () => {
    renderInspector(unit({ audioCount: 40, audioValidatedCount: 10 }), true, true)
    expect(screen.getByTestId("plan-inspector-bars").querySelector('[aria-label^="Audio"]'))
      .toHaveAttribute("aria-label", "Audio 40% recorded, 10% validated")
  })

  it("says plainly when a unit has never been touched", () => {
    renderInspector(unit({ lastEditAt: null }))
    expect(screen.getByTestId("plan-last-activity")).toHaveTextContent("No activity yet")
  })

  it("steps to the next and previous unit", () => {
    const { onStep } = renderInspector(unit())
    fireEvent.click(screen.getByTestId("plan-inspector-next"))
    expect(onStep).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByTestId("plan-inspector-prev"))
    expect(onStep).toHaveBeenCalledWith(-1)
  })

  it("closes", () => {
    const { onClose } = renderInspector(unit())
    fireEvent.click(screen.getByTestId("plan-inspector-close"))
    expect(onClose).toHaveBeenCalled()
  })
})

describe("the chapter breakdown (AQU-1098)", () => {
  it("lists a book's own chapters, numbered, and nothing from another book", async () => {
    const getToken = withSections([section("GEN 1"), section("GEN 2"), section("EXO 1")])
    renderInspector(unit({ sectionKey: "GEN", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-sections")).toBeInTheDocument())
    expect(screen.getByTestId("plan-section-GEN 1")).toHaveTextContent("1")
    expect(screen.getByTestId("plan-section-GEN 2")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-section-EXO 1")).toBeNull()
    expect(screen.getByText("Progress by chapter")).toBeInTheDocument()
  })

  it("keeps a one-chapter book, whose section key IS its book code", async () => {
    const getToken = withSections([section("TIT")])
    renderInspector(unit({ sectionKey: "TIT", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-section-TIT")).toBeInTheDocument())
  })

  it("calls them sections, not chapters, when the unit is not a book", async () => {
    const getToken = withSections([section("Scene 1"), section("Scene 2")])
    renderInspector(unit({ sectionKey: "", fileName: "Episode 1" }), true, false, getToken)
    await waitFor(() => expect(screen.getByText("Progress by section")).toBeInTheDocument())
    expect(screen.queryByText("Progress by chapter")).toBeNull()
  })

  it("refuses to list a media file's five-minute time buckets", async () => {
    const getToken = withSections([section("t:0"), section("t:1")])
    renderInspector(unit({ sectionKey: "", fileName: "Day 12.mp3" }), true, false, getToken)
    await waitFor(() => expect(getFileProgress).toHaveBeenCalled())
    expect(screen.queryByTestId("plan-sections")).toBeNull()
  })

  it("counts the chapters it found into the header meta line", async () => {
    const getToken = withSections([section("GEN 1"), section("GEN 2"), section("GEN 3")])
    renderInspector(unit({ sectionKey: "GEN", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() =>
      expect(screen.getByTestId("plan-inspector-meta")).toHaveTextContent("3 chapters"))
  })

  it("draws an audio bar per chapter only where the project records audio", async () => {
    const getToken = withSections([section("GEN 1", { audioCount: 20, audioValidatedCount: 5 })])
    renderInspector(unit({ sectionKey: "GEN", fileName: "Whole Bible" }), true, true, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-section-GEN 1")).toBeInTheDocument())
    const row = screen.getByTestId("plan-section-GEN 1")
    expect(row.querySelector('[aria-label^="Audio"]')).toHaveAttribute(
      "aria-label", "Audio 50% recorded, 13% validated",
    )
  })
})
