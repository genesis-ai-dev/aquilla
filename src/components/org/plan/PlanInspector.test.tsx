import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
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

/** A chapter with nothing outstanding in either medium — a quiet tile. */
const doneSection = (key: string) =>
  section(key, { filledCount: 40, validatedCount: 40, audioCount: 40, audioValidatedCount: 40 })

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

/**
 * AQU-1278: a unit inside the nearly-complete threshold — max(6% of 100, 7) is
 * seven cells, and this one is five short of fully validated. `filledCount` is
 * full, so the outstanding work is validation and the link says so.
 */
const nearlyDone = (over: Partial<PlanUnit> = {}): PlanUnit =>
  unit({ totalCount: 100, filledCount: 100, validatedCount: 95, ...over })

type InspectorExtras = {
  onGoToFirstOpen?: (kind: "untranslated" | "unvalidated") => void
  laneCount?: number
  assignments?: ReactNode
}

function renderInspector(
  u: PlanUnit,
  canPlan = true,
  showAudio = false,
  getToken: (() => Promise<string | null>) | null = null,
  extras: InspectorExtras = {},
) {
  const onPatch = vi.fn().mockResolvedValue(true)
  const onClose = vi.fn()
  const onStep = vi.fn()
  render(
    <PlanInspector unit={u} now={NOW} canPlan={canPlan} showAudio={showAudio}
      projectId="p1" getToken={getToken} lane="" languageLabel="Tok Pisin"
      onPatch={onPatch} onClose={onClose} onStep={onStep} {...extras} />,
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

  it("says the work itself is finished, above the button that records it", () => {
    // AQU-1278: nothing outstanding and nobody has said so. The nudge is the
    // reason to press the button, so it sits above it rather than beside it.
    renderInspector(unit({ totalCount: 100, filledCount: 100, validatedCount: 100 }))
    expect(screen.getByTestId("plan-nothing-left")).toHaveTextContent("Nothing left")
  })

  it("keeps that nudge off a unit with work left in it", () => {
    renderInspector(unit({ validatedCount: 31 }))
    expect(screen.queryByTestId("plan-nothing-left")).toBeNull()
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

  it("warns a multi-language project that its audio bar is the same on every tab", () => {
    // AQU-1278: recordings hang off the file, so a manager comparing two lanes
    // is seeing the truth rather than a stuck filter.
    renderInspector(unit({ audioCount: 40 }), true, true, null, { laneCount: 3 })
    expect(screen.getByTestId("plan-audio-shared-note"))
      .toHaveTextContent("audio is shared by every language")
  })

  it("says nothing of the kind on a single-language project", () => {
    renderInspector(unit({ audioCount: 40 }), true, true, null, { laneCount: 1 })
    expect(screen.queryByTestId("plan-audio-shared-note")).toBeNull()
  })

  it("renders whatever the assignment block is given as", () => {
    // A SLOT: the inspector leaves the hole and the component above fills it.
    renderInspector(unit(), true, false, null, {
      assignments: <div data-testid="stand-in-assignments" />,
    })
    expect(screen.getByTestId("stand-in-assignments")).toBeInTheDocument()
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

describe("the chapter grid (AQU-1278)", () => {
  it("places every tile at its own chapter number and leaves the gap empty", async () => {
    // THE WHOLE POINT OF THE GRID'S PARSER. A section row exists only where
    // cells exist — AQU-1083's structural subtraction can empty one out of the
    // response — so chapter 2 is simply absent here. Laid out by array index,
    // chapter 3 would sit in chapter 2's square and every later tile would be
    // off by one, plausibly and silently.
    const getToken = withSections([section("GEN 1"), section("GEN 3"), section("EXO 1")])
    renderInspector(unit({ sectionKey: "GEN", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-chapter-grid")).toBeInTheDocument())

    const grid = screen.getByTestId("plan-chapter-grid")
    expect([...grid.children].map((c) => c.getAttribute("data-testid"))).toEqual([
      "plan-tile-GEN 1",
      "plan-tile-gap-2",
      "plan-tile-GEN 3",
    ])
    // And nothing from a book this unit does not own.
    expect(screen.queryByTestId("plan-tile-EXO 1")).toBeNull()
    expect(screen.getByText("Progress by chapter")).toBeInTheDocument()
  })

  it("keeps a section that is not chapter-shaped off the numbered grid", async () => {
    // "Scene 4" must never masquerade as chapter 4, and "Act 2" is the trap
    // underneath that one: ACT is a real book code, so only the fact that a
    // human wrote it in title case separates it from Acts chapter two.
    const getToken = withSections([section("Scene 4"), section("Act 2"), section("MRK 1")])
    renderInspector(unit({ sectionKey: "", fileName: "Episode 1" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-chapter-extras")).toBeInTheDocument())

    const extras = screen.getByTestId("plan-chapter-extras")
    expect(within(extras).getByTestId("plan-tile-Scene 4")).toHaveTextContent("Scene 4")
    expect(within(extras).getByTestId("plan-tile-Act 2")).toHaveTextContent("Act 2")
    // The one real chapter in the file is still on the grid, at square one.
    const grid = screen.getByTestId("plan-chapter-grid")
    expect([...grid.children].map((c) => c.getAttribute("data-testid"))).toEqual(["plan-tile-MRK 1"])
    expect(screen.getByText("Progress by section")).toBeInTheDocument()
  })

  it("keeps a one-chapter book, whose section key IS its book code, off the grid too", async () => {
    // A bare book code carries no chapter number to be placed by — the same
    // shape USFM front matter comes back as.
    const getToken = withSections([section("TIT")])
    renderInspector(unit({ sectionKey: "TIT", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-tile-TIT")).toBeInTheDocument())
    expect(within(screen.getByTestId("plan-chapter-extras")).getByTestId("plan-tile-TIT"))
      .toBeInTheDocument()
    expect(screen.queryByTestId("plan-chapter-grid")).toBeNull()
  })

  it("counts a chapter's outstanding cells into its tile, for a screen reader too", async () => {
    const getToken = withSections([section("GEN 1", { totalCount: 40, filledCount: 40, validatedCount: 10 })])
    renderInspector(nearlyDone({ sectionKey: "GEN", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-tile-GEN 1")).toBeInTheDocument())
    expect(screen.getByTestId("plan-tile-GEN 1"))
      .toHaveAttribute("aria-label", "Chapter 1: 30 cells short")
  })

  it("badges the short tiles of a nearly-complete unit", async () => {
    const getToken = withSections([section("GEN 1", { validatedCount: 35 }), doneSection("GEN 2")])
    renderInspector(nearlyDone({ sectionKey: "GEN", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-tile-GEN 1")).toBeInTheDocument())
    expect(screen.getByTestId("plan-tile-badge-GEN 1")).toHaveTextContent("5")
    // A finished chapter is quiet: no badge, and no underline to carry a hue.
    expect(screen.queryByTestId("plan-tile-badge-GEN 2")).toBeNull()
    expect(screen.getByTestId("plan-tile-GEN 2").querySelector("[data-plan-underline]")).toBeNull()
  })

  it("badges nothing below the nearly-complete threshold", async () => {
    // Settled AQU-1278 rule: two-digit numbers on every tile turn the grid back
    // into the noise it replaced. 72/31 of 100 is nowhere near the threshold.
    const getToken = withSections([section("GEN 1"), section("GEN 2")])
    renderInspector(unit({ sectionKey: "GEN", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-tile-GEN 1")).toBeInTheDocument())
    expect(screen.queryByTestId("plan-tile-badge-GEN 1")).toBeNull()
    expect(screen.queryByTestId("plan-tile-badge-GEN 2")).toBeNull()
  })

  it("explains itself on a media file instead of drawing an empty frame", async () => {
    // Every section of a dubbed episode is a five-minute time bucket, and
    // `sectionBelongsToUnit` rejects all of them — so the list arrives empty.
    const getToken = withSections([section("t:0"), section("t:1")])
    renderInspector(unit({ sectionKey: "", fileName: "Day 12.mp3" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-grid-empty")).toBeInTheDocument())
    expect(screen.getByTestId("plan-grid-empty")).toHaveTextContent("time ranges")
    expect(screen.queryByTestId("plan-chapter-grid")).toBeNull()
  })

  it("keeps the grid out of a panel that was never able to read the breakdown", () => {
    // No token means no fetch at all, which is not the same fact as "this file
    // has no chapters" — and saying the second would be a lie.
    renderInspector(unit({ sectionKey: "GEN", fileName: "Whole Bible" }))
    expect(screen.queryByTestId("plan-sections")).toBeNull()
    expect(screen.queryByTestId("plan-grid-empty")).toBeNull()
  })

  it("summarises how much of the unit is left, in chapters", async () => {
    const getToken = withSections([section("GEN 1"), doneSection("GEN 2"), doneSection("GEN 3")])
    renderInspector(unit({ sectionKey: "GEN", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-grid-summary")).toBeInTheDocument())
    const summary = screen.getByTestId("plan-grid-summary")
    expect(summary).toHaveTextContent("1 chapter short")
    expect(summary).toHaveTextContent("2 of 3 complete")
  })

  it("counts the chapters it found into the header meta line", async () => {
    const getToken = withSections([section("GEN 1"), section("GEN 2"), section("GEN 3")])
    renderInspector(unit({ sectionKey: "GEN", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() =>
      expect(screen.getByTestId("plan-inspector-meta")).toHaveTextContent("3 chapters"))
  })

  it("opens one chapter's own bars when its tile is chosen", async () => {
    const getToken = withSections([section("GEN 1", { audioCount: 20, audioValidatedCount: 5 })])
    renderInspector(unit({ sectionKey: "GEN", fileName: "Whole Bible" }), true, true, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-tile-GEN 1")).toBeInTheDocument())
    expect(screen.queryByTestId("plan-chapter-detail")).toBeNull()

    fireEvent.click(screen.getByTestId("plan-tile-GEN 1"))
    const detail = screen.getByTestId("plan-chapter-detail")
    expect(detail.querySelector('[aria-label^="Text"]')).toHaveAttribute(
      "aria-label", "Text 100% translated, 25% validated",
    )
    expect(detail.querySelector('[aria-label^="Audio"]')).toHaveAttribute(
      "aria-label", "Audio 50% recorded, 13% validated",
    )

    // Choosing it again closes it: the grid is the summary, the bars are a
    // detour, and a detour you cannot leave is a trap.
    fireEvent.click(screen.getByTestId("plan-tile-GEN 1"))
    expect(screen.queryByTestId("plan-chapter-detail")).toBeNull()
  })
})

describe("the link into the editor (AQU-1278)", () => {
  const goLinks = () => screen.queryAllByRole("button", { name: /^Go to first/ })

  it("offers exactly one link, and prefers untranslated over unvalidated", async () => {
    // A cell nobody has written cannot be validated, so the translation queue
    // leads — sending a reader to the first unvalidated cell while blanks remain
    // names a queue that is blocked on the other one.
    const onGoToFirstOpen = vi.fn()
    const getToken = withSections([section("GEN 1")])
    renderInspector(
      nearlyDone({ sectionKey: "GEN", fileName: "Whole Bible", filledCount: 96, validatedCount: 96 }),
      true, false, getToken, { onGoToFirstOpen },
    )
    await waitFor(() => expect(screen.getByTestId("plan-chapter-grid")).toBeInTheDocument())

    expect(goLinks()).toHaveLength(1)
    fireEvent.click(screen.getByTestId("plan-go-to-first-open"))
    expect(onGoToFirstOpen).toHaveBeenCalledWith("untranslated")
    expect(onGoToFirstOpen).toHaveBeenCalledTimes(1)
  })

  it("sends a fully translated unit to the first unvalidated cell instead", async () => {
    const onGoToFirstOpen = vi.fn()
    const getToken = withSections([section("GEN 1")])
    renderInspector(
      nearlyDone({ sectionKey: "GEN", fileName: "Whole Bible" }),
      true, false, getToken, { onGoToFirstOpen },
    )
    await waitFor(() => expect(screen.getByTestId("plan-chapter-grid")).toBeInTheDocument())

    expect(goLinks()).toHaveLength(1)
    fireEvent.click(screen.getByTestId("plan-go-to-first-open"))
    expect(onGoToFirstOpen).toHaveBeenCalledWith("unvalidated")
  })

  it("gives a unit that is not nearly complete no link at all", async () => {
    // Deliberate, and flagged for re-confirmation at build review: "the first
    // outstanding cell" is not a useful place to stand when nearly everything
    // is outstanding.
    const onGoToFirstOpen = vi.fn()
    const getToken = withSections([section("GEN 1")])
    renderInspector(
      unit({ sectionKey: "GEN", fileName: "Whole Bible" }),
      true, false, getToken, { onGoToFirstOpen },
    )
    await waitFor(() => expect(screen.getByTestId("plan-chapter-grid")).toBeInTheDocument())
    expect(goLinks()).toHaveLength(0)
    expect(screen.queryByTestId("plan-go-to-first-open")).toBeNull()
  })
})
