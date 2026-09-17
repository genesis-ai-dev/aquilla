import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { PlanInspector } from "./PlanInspector"
import type { PlanOpenKind, PlanUnit } from "@/lib/plan/plan-status"

// Every test below used to pass getToken={null}, which short-circuits
// usePlanUnitSections before it fetches — so the whole AQU-1098 breakdown (the
// hook, the chapter labels, the chapters-vs-sections heading, the per-chapter
// bars) rendered in no test at all. Mocking the progress read exercises it.
vi.mock("@/lib/progress/file-progress-resource", () => ({
  getFileProgress: vi.fn(),
  // AQU-1278: the chapter card's verse chips read this, on the click that
  // opens a chapter and never before.
  getFileSectionProgress: vi.fn(),
}))
const { getFileProgress, getFileSectionProgress } =
  await import("@/lib/progress/file-progress-resource")

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
  // Default to a chapter with no verses, so every test that clicks a tile for
  // some other reason keeps working without knowing this exists.
  vi.mocked(getFileSectionProgress).mockReset().mockResolvedValue({ verses: [] } as never)
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
  onGoToFirstOpen?: (kind: PlanOpenKind) => void
  onOpenCell?: (cellId: string) => void
  onOpenUnit?: () => void
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

describe("the title opens the file", () => {
  it("is a button that hands the click upstairs when the panel can open it", () => {
    const onOpenUnit = vi.fn()
    renderInspector(unit(), true, false, null, { onOpenUnit })
    const title = screen.getByTestId("plan-inspector-open-file")
    expect(screen.getByRole("heading", { name: "Mark" })).toContainElement(title)
    fireEvent.click(title)
    expect(onOpenUnit).toHaveBeenCalledTimes(1)
  })

  it("is plain text when nothing can open it", () => {
    renderInspector(unit())
    expect(screen.queryByTestId("plan-inspector-open-file")).toBeNull()
    expect(screen.getByRole("heading", { name: "Mark" })).toBeInTheDocument()
  })
})

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

  it("keeps the note off a text-only book, whatever the rest of the project records", () => {
    // Per FILE, like the tiles. The project has audio elsewhere (showAudio),
    // so the bar still draws — but under a bar reading 0/0% the note was
    // explaining numbers that were not there.
    renderInspector(unit({ audioCount: 0 }), true, true, null, { laneCount: 3 })
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
    expect(screen.getByText("Chapters")).toBeInTheDocument()
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
    expect(screen.getByText("Sections")).toBeInTheDocument()
  })

  it("puts a one-chapter book on the grid as chapter 1", async () => {
    // AQU-1278. It used to land in the extras row wearing its book code, so
    // the board's where-line read "chapter TIT". Sam: "if it's a single
    // chapter it still is just a chapter, so you just put a little one there."
    // Genesis's front matter shares the key shape and does NOT get this — the
    // test above it proves the separation.
    const getToken = withSections([section("TIT")])
    renderInspector(unit({ sectionKey: "TIT", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-tile-TIT")).toBeInTheDocument())
    const grid = screen.getByTestId("plan-chapter-grid")
    expect([...grid.children].map((c) => c.getAttribute("data-testid"))).toEqual(["plan-tile-TIT"])
    expect(screen.getByTestId("plan-tile-TIT")).toHaveTextContent("1")
    expect(screen.queryByTestId("plan-chapter-extras")).toBeNull()
  })

  it("keeps a book's front matter off the numbered grid, named as what it is", async () => {
    // The same bare-code shape, but GEN 1 is in the unit too, so square one is
    // already spoken for and this is front matter.
    const getToken = withSections([section("GEN"), section("GEN 1")])
    renderInspector(unit({ sectionKey: "GEN", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-chapter-extras")).toBeInTheDocument())
    expect(within(screen.getByTestId("plan-chapter-extras")).getByTestId("plan-tile-GEN"))
      .toHaveTextContent("front matter")
    const grid = screen.getByTestId("plan-chapter-grid")
    expect([...grid.children].map((c) => c.getAttribute("data-testid"))).toEqual(["plan-tile-GEN 1"])
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

  it("shows no chapter block at all on a file with no sections", async () => {
    // AQU-1278, Sam 2026-09-16. A dubbed episode's sections are five-minute
    // time buckets, which `sectionBelongsToUnit` rejects, so the list arrives
    // empty; a Word document's is empty because it has none. This used to
    // print a heading and a sentence explaining which — more to read than the
    // thing it stood in for, and a lie whenever it guessed the kind wrong.
    const getToken = withSections([section("t:0"), section("t:1")])
    renderInspector(unit({ sectionKey: "", fileName: "Season 1 · Episode 1" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-inspector-bars")).toBeInTheDocument())
    expect(screen.queryByTestId("plan-sections")).toBeNull()
    expect(screen.queryByTestId("plan-chapter-grid")).toBeNull()
    expect(screen.queryByTestId("plan-grid-summary")).toBeNull()
  })

  it("keeps the grid out of a panel that was never able to read the breakdown", () => {
    // No token means no fetch at all, which is not the same fact as "this file
    // has no chapters" — and saying the second would be a lie.
    renderInspector(unit({ sectionKey: "GEN", fileName: "Whole Bible" }))
    expect(screen.queryByTestId("plan-sections")).toBeNull()
  })

  it("says how much of the unit is left, and only that", async () => {
    // AQU-1278: ONE of the two counts, never both. "1 chapter short" and "2 of
    // 3 complete" are the same fact from opposite ends, and a line carrying
    // both made a reader subtract to check they agreed.
    const getToken = withSections([section("GEN 1"), doneSection("GEN 2"), doneSection("GEN 3")])
    renderInspector(unit({ sectionKey: "GEN", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-grid-summary")).toBeInTheDocument())
    const summary = screen.getByTestId("plan-grid-summary")
    expect(summary).toHaveTextContent("1 chapter short")
    expect(summary).not.toHaveTextContent("complete")
  })

  it("switches to the complete count once nothing is short", async () => {
    const getToken = withSections([doneSection("GEN 1"), doneSection("GEN 2")])
    renderInspector(unit({ sectionKey: "GEN", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() => expect(screen.getByTestId("plan-grid-summary")).toBeInTheDocument())
    const summary = screen.getByTestId("plan-grid-summary")
    expect(summary).toHaveTextContent("2 of 2 complete")
    expect(summary).not.toHaveTextContent("short")
  })

  it("counts the chapters it found into the header meta line", async () => {
    const getToken = withSections([section("GEN 1"), section("GEN 2"), section("GEN 3")])
    renderInspector(unit({ sectionKey: "GEN", fileName: "Whole Bible" }), true, false, getToken)
    await waitFor(() =>
      expect(screen.getByTestId("plan-inspector-meta")).toHaveTextContent("3 chapters"))
  })

  it("opens one chapter's own bars when its tile is chosen", async () => {
    const getToken = withSections([section("GEN 1", { audioCount: 20, audioValidatedCount: 5 })])
    // The unit carries recordings too. AQU-1278 put the card on the same
    // per-FILE audio gate the grid above it already used, so a card drawing an
    // audio bar under a unit whose file has none would be the panel
    // contradicting itself two inches apart.
    renderInspector(
      unit({ sectionKey: "GEN", fileName: "Whole Bible", audioCount: 20 }), true, true, getToken,
    )
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
    expect(screen.queryByTestId("plan-unit-shortfall")).toBeNull()
  })

  it("keeps the link with the unit's own shortfall, not with the chapter grid", async () => {
    // It shared the grid's summary line until Sam found what that costs — see
    // the test below. The summary keeps the per-chapter count and nothing else.
    const getToken = withSections([section("GEN 1")])
    renderInspector(
      nearlyDone({ sectionKey: "GEN", fileName: "Whole Bible" }),
      true, false, getToken, { onGoToFirstOpen: vi.fn() },
    )
    await waitFor(() => expect(screen.getByTestId("plan-chapter-grid")).toBeInTheDocument())
    const line = screen.getByTestId("plan-unit-shortfall")
    expect(line).toContainElement(screen.getByTestId("plan-go-to-first-open"))
    expect(line).toHaveTextContent("5 cells to validate")
    expect(screen.getByTestId("plan-grid-summary")).not.toHaveTextContent(/Go to first/)
  })

  it("STILL OFFERS THE LINK on a file with no chapters to hang it on", async () => {
    // The hole the old placement left, and the reason it moved. A subtitle file
    // and a Word document have no grid, so the one link that takes a manager to
    // the remaining work existed for books and for nothing else — on exactly
    // the units whose whole panel is two bars.
    const onGoToFirstOpen = vi.fn()
    const getToken = withSections([])
    renderInspector(
      nearlyDone({ sectionKey: "", fileName: "northern-route.docx" }),
      true, false, getToken, { onGoToFirstOpen },
    )
    await waitFor(() => expect(screen.getByTestId("plan-unit-shortfall")).toBeInTheDocument())
    expect(screen.queryByTestId("plan-sections")).toBeNull()
    expect(goLinks()).toHaveLength(1)
    fireEvent.click(screen.getByTestId("plan-go-to-first-open"))
    expect(onGoToFirstOpen).toHaveBeenCalledWith("unvalidated")
  })

  it("sends a unit whose text is finished to the first cell with no take", async () => {
    // Sam, 2026-09-16: "if all text is translated … but some cells are missing
    // takes, could the link take you to the cells that are missing takes?"
    // Ninety of a hundred recorded is ten short, under the threshold, so the
    // unit is nearly complete BY AUDIO and the link follows the audio.
    const onGoToFirstOpen = vi.fn()
    const getToken = withSections([section("GEN 1")])
    renderInspector(
      nearlyDone({ sectionKey: "GEN", fileName: "Whole Bible", validatedCount: 100, audioCount: 94 }),
      true, true, getToken, { onGoToFirstOpen },
    )
    await waitFor(() => expect(screen.getByTestId("plan-unit-shortfall")).toBeInTheDocument())
    expect(screen.getByTestId("plan-unit-shortfall")).toHaveTextContent("6 takes to record")
    expect(goLinks()).toHaveLength(1)
    expect(screen.getByTestId("plan-go-to-first-open")).toHaveTextContent("Go to first unrecorded")
    fireEvent.click(screen.getByTestId("plan-go-to-first-open"))
    expect(onGoToFirstOpen).toHaveBeenCalledWith("unrecorded")
  })

  it("still leads with the text while any of it is outstanding", async () => {
    // Text before audio: "2 to validate · 6 to record" links to the text,
    // because that is the queue the words name first.
    const onGoToFirstOpen = vi.fn()
    const getToken = withSections([section("GEN 1")])
    renderInspector(
      nearlyDone({ sectionKey: "GEN", validatedCount: 98, audioCount: 94 }),
      true, true, getToken, { onGoToFirstOpen },
    )
    await waitFor(() => expect(screen.getByTestId("plan-go-to-first-open")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("plan-go-to-first-open"))
    expect(onGoToFirstOpen).toHaveBeenCalledWith("unvalidated")
  })

  it("says 'Nothing left' where there is nothing to link to", async () => {
    const getToken = withSections([])
    renderInspector(
      unit({
        sectionKey: "", fileName: "glossary.txt",
        totalCount: 100, filledCount: 100, validatedCount: 100,
      }),
      true, false, getToken, { onGoToFirstOpen: vi.fn() },
    )
    await waitFor(() => expect(screen.getByTestId("plan-unit-shortfall")).toBeInTheDocument())
    expect(screen.getByTestId("plan-unit-shortfall")).toHaveTextContent("Nothing left")
    expect(goLinks()).toHaveLength(0)
  })
})

// AQU-1278: the chapter card. Sam, on the build: "everything that is different
// here is for the worse" — the card showed a raw section key and two bars in
// percentages where the mockup has a title, a count, and a chip per verse.
describe("the chapter card", () => {
  const verse = (
    cellId: string,
    ref: string,
    over: Partial<{ filled: boolean; validated: boolean; recorded: boolean; audioValidated: boolean }> = {},
  ) => ({ cellId, ref, filled: true, validated: true, ...over })

  const openChapter = async (
    u: PlanUnit,
    sections: ReturnType<typeof section>[],
    verses: ReturnType<typeof verse>[],
    extras: InspectorExtras = {},
  ) => {
    vi.mocked(getFileSectionProgress).mockResolvedValue({ verses } as never)
    renderInspector(u, true, false, withSections(sections), extras)
    await waitFor(() => expect(screen.getByTestId(`plan-tile-${sections[0].key}`)).toBeInTheDocument())
    fireEvent.click(screen.getByTestId(`plan-tile-${sections[0].key}`))
    await waitFor(() => expect(screen.getByTestId("plan-chapter-detail")).toBeInTheDocument())
  }

  it("reads the chapter's verses only once its tile is clicked", async () => {
    vi.mocked(getFileSectionProgress).mockResolvedValue({ verses: [] } as never)
    renderInspector(nearlyDone({ sectionKey: "GEN" }), true, false, withSections([section("GEN 12")]))
    await waitFor(() => expect(screen.getByTestId("plan-tile-GEN 12")).toBeInTheDocument())
    // `cells.canonical_ref` is unindexed, so each of these is a full-file scan.
    // A grid that prefetched its fifty tiles would be fifty of them.
    expect(getFileSectionProgress).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("plan-tile-GEN 12"))
    await waitFor(() => expect(getFileSectionProgress).toHaveBeenCalledTimes(1))
    expect(vi.mocked(getFileSectionProgress).mock.calls[0].slice(0, 3))
      .toEqual(["p1", "f1", "GEN 12"])
  })

  it("titles itself as a chapter and says what is outstanding in it", async () => {
    await openChapter(
      nearlyDone({ sectionKey: "GEN" }),
      [section("GEN 12", { totalCount: 20, filledCount: 20, validatedCount: 18 })],
      [],
    )
    const detail = screen.getByTestId("plan-chapter-detail")
    // Not the raw "GEN 12" the build showed.
    expect(within(detail).getByTestId("plan-chapter-detail-title")).toHaveTextContent("Chapter 12")
    expect(within(detail).getByTestId("plan-chapter-detail-left"))
      .toHaveTextContent("2 cells not yet validated")
  })

  it("reads its bars in percentages, with the counts on hover", async () => {
    await openChapter(
      nearlyDone({ sectionKey: "GEN" }),
      [section("GEN 12", { totalCount: 20, filledCount: 20, validatedCount: 18 })],
      [],
    )
    // Percentages like every other bar, and the two cells "100% | 90%" rounds
    // away are what the hover says (Sam, 2026-09-17, for consistency).
    const card = screen.getByTestId("plan-chapter-detail")
    expect(card).toHaveTextContent("100% | 90%")
    expect(within(card).getAllByTestId("plan-readout-figure").map((el) => el.getAttribute("aria-label")))
      .toEqual(["20 of 20 translated", "18 of 20 validated"])
  })

  it("draws a chip per short verse, in canonical order, and opens the cell", async () => {
    const onOpenCell = vi.fn()
    await openChapter(
      nearlyDone({ sectionKey: "GEN" }),
      [section("GEN 12", { totalCount: 20, filledCount: 20, validatedCount: 18 })],
      [
        verse("c1", "GEN 12:1"),
        verse("c4", "GEN 12:4", { validated: false }),
        verse("c5", "GEN 12:5", { validated: false }),
      ],
      { onOpenCell },
    )
    const row = screen.getByTestId("plan-chapter-verses")
    expect([...row.children].map((c) => c.textContent)).toEqual(["12:4", "12:5"])

    fireEvent.click(screen.getByTestId("plan-verse-chip-c4"))
    expect(onOpenCell).toHaveBeenCalledWith("c4")
  })

  it("opens the chapter's FIRST cell from its title, short or not", async () => {
    // c1 is finished and draws no chip; it is still where "Chapter 12" goes.
    const onOpenCell = vi.fn()
    await openChapter(
      nearlyDone({ sectionKey: "GEN" }),
      [section("GEN 12", { totalCount: 20, filledCount: 20, validatedCount: 18 })],
      [verse("c1", "GEN 12:1"), verse("c4", "GEN 12:4", { validated: false })],
      { onOpenCell },
    )
    const title = screen.getByTestId("plan-chapter-open")
    expect(screen.getByTestId("plan-chapter-detail-title")).toContainElement(title)
    expect(title).toHaveTextContent("Chapter 12")
    fireEvent.click(title)
    expect(onOpenCell).toHaveBeenCalledWith("c1")
  })

  it("keeps the chapter title plain until its verses are known", async () => {
    await openChapter(
      nearlyDone({ sectionKey: "GEN" }),
      [section("GEN 12", { totalCount: 20, filledCount: 20, validatedCount: 18 })],
      [],
      { onOpenCell: vi.fn() },
    )
    expect(screen.getByTestId("plan-chapter-detail-title")).toHaveTextContent("Chapter 12")
    expect(screen.queryByTestId("plan-chapter-open")).toBeNull()
  })

  it("lists the unwritten verses when translation is what leads", async () => {
    // A cell nobody has written cannot be validated, so pointing at an
    // unvalidated one would send a reader to do the other job first.
    await openChapter(
      unit({ sectionKey: "GEN", totalCount: 100, filledCount: 98, validatedCount: 98 }),
      [section("GEN 12", { totalCount: 20, filledCount: 18, validatedCount: 18 })],
      [
        verse("c1", "GEN 12:1"),
        verse("c2", "GEN 12:2", { filled: false, validated: false }),
        verse("c3", "GEN 12:3", { validated: false }),
      ],
    )
    const row = screen.getByTestId("plan-chapter-verses")
    expect([...row.children].map((c) => c.textContent)).toEqual(["12:2"])
  })

  it("draws chips on a chapter of a unit that is nowhere near done", async () => {
    // Sam chose this over gating them the way the badges and the link are
    // gated: a chip says which verse, and that is worth the same on a book at
    // sixty percent as on one at ninety-nine.
    await openChapter(
      unit({ sectionKey: "GEN", totalCount: 1000, filledCount: 600, validatedCount: 400 }),
      [section("GEN 12", { totalCount: 20, filledCount: 20, validatedCount: 19 })],
      [verse("c9", "GEN 12:9", { validated: false })],
    )
    expect(screen.getByTestId("plan-verse-chip-c9")).toBeInTheDocument()
  })

  it("draws EVERY short verse in one scrolling row, with no count chip", async () => {
    // Sam, 2026-09-16: the row scrolls instead of folding the rest into "+N".
    // Every verse is reachable, and the header already says how many are
    // left. Twelve is more than any panel width holds; all twelve render.
    const verses = Array.from({ length: 12 }, (_, i) =>
      verse(`c${i + 1}`, `GEN 12:${i + 1}`, { validated: false }))
    await openChapter(
      unit({ sectionKey: "GEN", totalCount: 100, filledCount: 100, validatedCount: 88 }),
      [section("GEN 12", { totalCount: 20, filledCount: 20, validatedCount: 8 })],
      verses,
    )
    const row = screen.getByTestId("plan-chapter-verses")
    expect(row.children).toHaveLength(12)
    expect(row.className).toContain("overflow-x-auto")
    expect(screen.queryByTestId("plan-verse-more")).toBeNull()
  })

  it("lists the verses with no take on a chapter short on audio alone", async () => {
    // Round 5 (Sam, 2026-09-16): the verse detail carries take state now, so
    // a finished chapter with takes missing points at the takes — the same
    // rule the link follows.
    await openChapter(
      nearlyDone({ sectionKey: "GEN", validatedCount: 100, audioCount: 90 }),
      [section("GEN 12", {
        totalCount: 20, filledCount: 20, validatedCount: 20,
        audioCount: 18, audioValidatedCount: 18,
      })],
      [
        verse("c1", "GEN 12:1", { recorded: true, audioValidated: true }),
        verse("c2", "GEN 12:2", { recorded: false, audioValidated: false }),
        verse("c3", "GEN 12:3", { recorded: true, audioValidated: false }),
        verse("c4", "GEN 12:4", { recorded: false, audioValidated: false }),
      ],
    )
    expect(screen.getByTestId("plan-chapter-detail-left"))
      .toHaveTextContent("2 takes not yet recorded")
    const row = screen.getByTestId("plan-chapter-verses")
    expect([...row.children].map((c) => c.textContent)).toEqual(["12:2", "12:4"])
  })

  it("draws no chips for an audio lead when the verses carry no take state", async () => {
    // A worker from before the `s3` section shape: an absent flag is
    // "unknown", and unknown must never render as "every verse is short".
    await openChapter(
      nearlyDone({ sectionKey: "GEN", validatedCount: 100, audioCount: 90 }),
      [section("GEN 12", {
        totalCount: 20, filledCount: 20, validatedCount: 20,
        audioCount: 18, audioValidatedCount: 18,
      })],
      [verse("c1", "GEN 12:1"), verse("c2", "GEN 12:2")],
    )
    expect(screen.queryByTestId("plan-chapter-verses")).toBeNull()
  })

  it("names a one-chapter book's card as chapter 1", async () => {
    await openChapter(
      nearlyDone({ sectionKey: "TIT" }),
      [section("TIT", { totalCount: 15, filledCount: 15, validatedCount: 13 })],
      [],
    )
    expect(screen.getByTestId("plan-chapter-detail-title")).toHaveTextContent("Chapter 1")
  })
})

describe("the inspector's percentages say what they stand for (round 7)", () => {
  it("names each figure's count out of the bar's own total", () => {
    renderInspector(
      unit({ totalCount: 646, filledCount: 646, validatedCount: 640, audioCount: 540, audioValidatedCount: 0, audioTotalCount: 548 }),
      true, true,
    )
    const names = within(screen.getByTestId("plan-inspector-bars"))
      .getAllByTestId("plan-readout-figure").map((el) => el.getAttribute("aria-label"))
    expect(names).toEqual([
      "646 of 646 translated", "640 of 646 validated",
      "540 of 548 recorded", "0 of 548 validated",
    ])
  })
})

/**
 * AQU-1278 (2026-09-17). A chapter's verses are ONE LANGUAGE'S: which are
 * unwritten, which are unvalidated, which have a take. The board grew its own
 * language picker, so switching is now one click away from these chips.
 */
describe("the chapter's verses belong to the language on screen", () => {
  const verse = (cellId: string, ref: string, over: Record<string, boolean> = {}) =>
    ({ cellId, ref, filled: true, validated: true, ...over })

  const renderAt = (lane: string) => {
    const props = {
      unit: nearlyDone({ sectionKey: "GEN" }), now: NOW, canPlan: true, showAudio: false,
      projectId: "p1", getToken: withSections([section("GEN 12", { totalCount: 20, filledCount: 20, validatedCount: 18 })]),
      languageLabel: "German", onPatch: vi.fn().mockResolvedValue(true), onClose: vi.fn(), onStep: vi.fn(),
    }
    const { rerender } = render(<PlanInspector {...props} lane={lane} />)
    return { rerender: (next: string) => rerender(<PlanInspector {...props} lane={next} />) }
  }

  it("re-reads the open chapter in the new language instead of showing the old one's", async () => {
    vi.mocked(getFileSectionProgress).mockResolvedValue({ verses: [verse("c4", "GEN 12:4", { validated: false })] } as never)
    const { rerender } = renderAt("")
    await waitFor(() => expect(screen.getByTestId("plan-tile-GEN 12")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("plan-tile-GEN 12"))
    await waitFor(() => expect(screen.getByTestId("plan-verse-chip-c4")).toBeInTheDocument())
    expect(vi.mocked(getFileSectionProgress).mock.calls[0]?.[4]).toBe("")

    vi.mocked(getFileSectionProgress).mockResolvedValue({ verses: [verse("c9", "GEN 12:9", { validated: false })] } as never)
    rerender("tpi")
    // The German answer is not reused for Tok Pisin, and the new read is
    // asked for the lane now on screen.
    await waitFor(() => expect(screen.getByTestId("plan-verse-chip-c9")).toBeInTheDocument())
    expect(screen.queryByTestId("plan-verse-chip-c4")).toBeNull()
    const lanes = vi.mocked(getFileSectionProgress).mock.calls.map((c) => c[4])
    expect(lanes).toContain("tpi")
  })

  it("reads a chapter once however many times React renders it", async () => {
    // The fetch used to be launched from inside a setState updater, which
    // React may call more than once — StrictMode calls it twice on purpose —
    // so one click fired two or three identical full-file scans.
    vi.mocked(getFileSectionProgress).mockResolvedValue({ verses: [] } as never)
    const { rerender } = renderAt("")
    await waitFor(() => expect(screen.getByTestId("plan-tile-GEN 12")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("plan-tile-GEN 12"))
    await waitFor(() => expect(screen.getByTestId("plan-chapter-detail")).toBeInTheDocument())
    rerender("")
    rerender("")
    expect(getFileSectionProgress).toHaveBeenCalledTimes(1)
  })
})
