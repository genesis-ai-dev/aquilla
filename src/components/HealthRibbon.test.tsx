import { render, screen } from "@testing-library/react"
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
})
