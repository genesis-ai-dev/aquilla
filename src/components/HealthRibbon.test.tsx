import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { HealthRibbon } from "./HealthRibbon"
import { expectClickNote } from "@/test-utils/tooltip"

describe("HealthRibbon", () => {
  it("keeps issue information accessible without drawing warning dashes or a split focus ring", () => {
    render(
      <HealthRibbon
        point={{
          id: "cell-1",
          stage: "automatic",
          rawScore: 20,
          smoothedScore: 25,
          evidenceWeight: 1,
        }}
        hasMajorIssue
      />,
    )

    const ribbon = screen.getByTestId("health-ribbon")
    expect(ribbon).toHaveAccessibleName(/major automatic issue/i)
    expect(ribbon.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1)
    expect(ribbon.className).not.toContain("focus-visible:ring")
  })

  it("names every active check on hover instead of a generic issue label", async () => {
    render(
      <HealthRibbon
        point={{
          id: "cell-1",
          stage: "validated",
          rawScore: 100,
          smoothedScore: 100,
          evidenceWeight: 1,
        }}
        hasIssue
        issues={[
          {
            ruleId: "builtin:end-punctuation-mismatch",
            name: "End punctuation",
            reason: "Terminal punctuation differs from source",
          },
          {
            ruleId: "builtin:number-integrity",
            name: "Number integrity",
            reason: "Number from source missing in translation",
          },
        ]}
      />,
    )

    const ribbon = screen.getByTestId("health-ribbon")
    expect(ribbon).toHaveAccessibleName(/End punctuation — Terminal punctuation differs from source/)
    expect(ribbon).toHaveAccessibleName(/Number integrity — Number from source missing in translation/)
    expect(ribbon).not.toHaveAccessibleName(/automatic issue/i)

    // AQU-2260 (Sam, Oct 29): on a click, in a note anchored to it, never a
    // hover.
    await expectClickNote(ribbon, "End punctuation — Terminal punctuation differs from source")
    const note = document.querySelector('[data-slot="popover-content"]')!
    expect(note).toHaveTextContent("Number integrity — Number from source missing in translation")
    expect(note).not.toHaveTextContent(/automatic issue/i)
  })

  it("says what its colour means on a click, and the click goes no further", async () => {
    const onRow = vi.fn()
    render(
      <div onClick={onRow}>
        <HealthRibbon point={{ id: "cell-1", stage: "automatic", rawScore: 20, smoothedScore: 25, evidenceWeight: 1 }} />
      </div>,
    )
    await expectClickNote(screen.getByTestId("health-ribbon"), "Automatic estimate 20%")
    expect(onRow).not.toHaveBeenCalled()
  })
})
