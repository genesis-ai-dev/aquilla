import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { PlanChapterGrid, planTileChapter } from "./PlanChapterGrid"
import type { PlanSection } from "@/hooks/usePlanUnitSections"
import { hexToRgba, parseTrackHue } from "@/lib/timeline/track-colors"

/**
 * The hues are asserted through the same lookup the component uses, on purpose.
 * What these tests pin is not the value of azure — `track-colors.ts` owns that
 * and Sam retunes it — but WHICH HALF OF THE UNDERLINE EACH MEDIUM GETS and the
 * alpha it is drawn at, which is this file's decision and nobody else's.
 */
const TEXT_HUE = parseTrackHue("azure")
const AUDIO_HUE = parseTrackHue("cyan")

const section = (key: string, over: Partial<PlanSection> = {}): PlanSection => ({
  key,
  label: key,
  totalCount: 40,
  filledCount: 40,
  validatedCount: 40,
  audioCount: 40,
  audioValidatedCount: 40,
  ...over,
})

function renderGrid(sections: PlanSection[], over: {
  showAudio?: boolean
  nearlyComplete?: boolean
  selectedKey?: string | null
} = {}) {
  const onSelect = vi.fn()
  render(
    <PlanChapterGrid
      sections={sections}
      showAudio={over.showAudio ?? false}
      nearlyComplete={over.nearlyComplete ?? false}
      selectedKey={over.selectedKey ?? null}
      onSelect={onSelect}
    />,
  )
  return { onSelect }
}

const testids = (el: HTMLElement) =>
  [...el.children].map((c) => c.getAttribute("data-testid"))

const underline = (key: string, medium: "text" | "audio") =>
  screen.getByTestId(`plan-tile-${key}`).querySelector(`[data-plan-underline="${medium}"]`)

describe("which keys are chapters", () => {
  it("reads a USFM chapter key", () => {
    expect(planTileChapter("GEN 1")).toBe(1)
    expect(planTileChapter("1CO 12")).toBe(12)
  })

  it("refuses a bare book code, which carries no chapter to be placed by", () => {
    // USFM front matter, and a one-chapter book whose section key IS its code.
    expect(planTileChapter("GEN")).toBeNull()
    expect(planTileChapter("TIT")).toBeNull()
  })

  it("refuses a document's own section names", () => {
    // `sectionLabel` in usePlanUnitSections reads "Scene 4" as "4" because it
    // only has to print something. A grid POSITIONS by this number, so the
    // looser rule would sit scene four in chapter four's square.
    expect(planTileChapter("Scene 4")).toBeNull()
    expect(planTileChapter("Chapter 4")).toBeNull()
  })

  it("separates Acts chapter two from the second act of something", () => {
    // ACT is a real book code, so a code test alone accepts "Act 2". The only
    // signal left is case: a section key is machine-made from canonical_ref and
    // a USFM code is upper case in every one of them.
    expect(planTileChapter("ACT 2")).toBe(2)
    expect(planTileChapter("Act 2")).toBeNull()
  })
})

describe("laying the tiles out", () => {
  it("puts each tile at its own number and holds the missing squares open", () => {
    renderGrid([section("GEN 1"), section("GEN 4")])
    expect(testids(screen.getByTestId("plan-chapter-grid"))).toEqual([
      "plan-tile-GEN 1",
      "plan-tile-gap-2",
      "plan-tile-gap-3",
      "plan-tile-GEN 4",
    ])
  })

  it("keeps ten columns for an ordinary book", () => {
    renderGrid(Array.from({ length: 50 }, (_, i) => section(`GEN ${i + 1}`)))
    expect(screen.getByTestId("plan-chapter-grid").className).toContain("grid-cols-10")
  })

  it("takes twelve columns once a book runs past sixty chapters", () => {
    // Psalms. Fifteen rows of ten would need a scroller of its own inside a
    // panel that already scrolls, which is what the grid replaced.
    renderGrid(Array.from({ length: 150 }, (_, i) => section(`PSA ${i + 1}`)))
    expect(screen.getByTestId("plan-chapter-grid").className).toContain("grid-cols-12")
  })

  it("puts everything unnumbered in its own row, labelled with its own key", () => {
    renderGrid([section("GEN 1"), section("TIT"), section("Scene 4")])
    const extras = screen.getByTestId("plan-chapter-extras")
    expect(within(extras).getByTestId("plan-tile-TIT")).toHaveTextContent("TIT")
    expect(within(extras).getByTestId("plan-tile-Scene 4")).toHaveTextContent("Scene 4")
    expect(testids(screen.getByTestId("plan-chapter-grid"))).toEqual(["plan-tile-GEN 1"])
  })

  it("says why there is no grid rather than drawing an empty frame", () => {
    // A media file's sections are all five-minute time buckets, every one of
    // which `sectionBelongsToUnit` rejects — so the list arrives empty.
    renderGrid([])
    expect(screen.getByTestId("plan-grid-empty")).toHaveTextContent("time ranges")
    expect(screen.queryByTestId("plan-chapter-grid")).toBeNull()
  })

  it("hands the key back when a tile is chosen", () => {
    const { onSelect } = renderGrid([section("GEN 1")])
    fireEvent.click(screen.getByTestId("plan-tile-GEN 1"))
    expect(onSelect).toHaveBeenCalledWith("GEN 1")
  })

  it("marks the chosen tile as pressed, for a screen reader as well as the eye", () => {
    renderGrid([section("GEN 1"), section("GEN 2")], { selectedKey: "GEN 2" })
    expect(screen.getByTestId("plan-tile-GEN 2")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("plan-tile-GEN 1")).toHaveAttribute("aria-pressed", "false")
  })
})

describe("what a tile says it is short of", () => {
  it("leaves a finished chapter quiet — no underline, no badge", () => {
    renderGrid([section("GEN 1")], { showAudio: true, nearlyComplete: true })
    const tile = screen.getByTestId("plan-tile-GEN 1")
    expect(tile.querySelector("[data-plan-underline]")).toBeNull()
    expect(screen.queryByTestId("plan-tile-badge-GEN 1")).toBeNull()
    expect(tile).toHaveAttribute("aria-label", "Chapter 1: 0 cells short")
  })

  it("draws the text hue on the left half only, where audio is done", () => {
    renderGrid([section("GEN 1", { validatedCount: 20 })], { showAudio: true })
    // Twenty of forty cells unvalidated: 0.5 + 0.5 = a full-strength line.
    expect(underline("GEN 1", "text")).toHaveStyle({
      backgroundColor: hexToRgba(TEXT_HUE, 1),
    })
    expect(underline("GEN 1", "audio")).toHaveStyle({ backgroundColor: "transparent" })
  })

  it("draws the audio hue on the right half only, where the text is done", () => {
    renderGrid([section("GEN 1", { audioCount: 36, audioValidatedCount: 36 })], { showAudio: true })
    // Four takes of forty missing: 0.5 + 0.1.
    expect(underline("GEN 1", "audio")).toHaveStyle({
      backgroundColor: hexToRgba(AUDIO_HUE, 0.6),
    })
    expect(underline("GEN 1", "text")).toHaveStyle({ backgroundColor: "transparent" })
  })

  it("never counts audio on a project that records none", () => {
    // `showAudio` is the whole gate: with it off the chapter is complete, so
    // the tile carries no underline at all.
    renderGrid([section("GEN 1", { audioCount: 0, audioValidatedCount: 0 })], { showAudio: false })
    expect(screen.getByTestId("plan-tile-GEN 1").querySelector("[data-plan-underline]")).toBeNull()
    expect(screen.getByTestId("plan-tile-GEN 1")).toHaveAttribute("aria-label", "Chapter 1: 0 cells short")
  })

  it("reports the WORSE medium in the number, not the sum of the two", () => {
    // Thirty cells unvalidated and thirty-five takes missing is a chapter that
    // is thirty-five short, not sixty-five: the two mediums cover the same
    // cells, which is the rule `planUnitShortfall` states.
    renderGrid([section("GEN 1", { validatedCount: 10, audioCount: 5, audioValidatedCount: 5 })], {
      showAudio: true, nearlyComplete: true,
    })
    expect(screen.getByTestId("plan-tile-GEN 1"))
      .toHaveAttribute("aria-label", "Chapter 1: 35 cells short")
    expect(screen.getByTestId("plan-tile-badge-GEN 1")).toHaveTextContent("35")
  })

  it("keeps the count off a tile while the unit is far from done", () => {
    // The settled AQU-1278 answer, tested against six alternatives: below the
    // threshold every short tile would carry a two-digit number and the grid
    // becomes the noise it replaced.
    renderGrid([section("GEN 1", { validatedCount: 35 })], { nearlyComplete: false })
    expect(screen.getByTestId("plan-tile-GEN 1")).toHaveAttribute("data-short", "true")
    expect(screen.queryByTestId("plan-tile-badge-GEN 1")).toBeNull()
  })

  it("puts the count on the same tile once the unit is nearly complete", () => {
    renderGrid([section("GEN 1", { validatedCount: 35 })], { nearlyComplete: true })
    expect(screen.getByTestId("plan-tile-badge-GEN 1")).toHaveTextContent("5")
  })
})

describe("the legend", () => {
  it("names all three swatches where a project records audio", () => {
    renderGrid([section("GEN 1")], { showAudio: true })
    const legend = screen.getByTestId("plan-grid-legend")
    expect(legend).toHaveTextContent("all complete")
    expect(legend).toHaveTextContent("text short")
    expect(legend).toHaveTextContent("audio short")
  })

  it("drops the audio swatch on a text-only project", () => {
    // A legend entry for a colour that is nowhere on screen is a question, not
    // an answer.
    renderGrid([section("GEN 1")], { showAudio: false })
    expect(screen.getByTestId("plan-grid-legend")).not.toHaveTextContent("audio short")
  })
})
