import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { HealthRibbon } from "./HealthRibbon"

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

    fireEvent.focus(ribbon)
    const tip = await screen.findByRole("tooltip")
    expect(tip).toHaveTextContent("End punctuation — Terminal punctuation differs from source")
    expect(tip).toHaveTextContent("Number integrity — Number from source missing in translation")
    expect(tip).not.toHaveTextContent(/automatic issue/i)
  })
})
